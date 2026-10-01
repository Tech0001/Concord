//! Resumable, model-isolated retrieval index. Network I/O never holds a write transaction.
use super::{
    config::{self, Provider},
    Control,
};
use crate::db;
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};

#[derive(Default, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Filter {
    pub kind: String,
    pub channel: String,
    pub speaker: String,
    pub from: String,
    pub to: String,
    pub tag: String,
    pub media_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hit {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub channel: String,
    pub date: String,
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub score: f64,
}
#[derive(Clone)]
pub struct Chunk {
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
}
pub fn digest(chunks: &[Chunk]) -> String {
    let mut hasher = Sha256::new();
    for c in chunks {
        hasher.update(c.text.as_bytes());
        hasher.update(format!("\0{:?}:{:?}\0", c.start, c.end));
    }
    format!("{:x}", hasher.finalize())
}
pub fn chunks(db: &Connection, kind: &str, id: &str) -> Result<Vec<Chunk>> {
    let pieces=match kind {
        "recording"=>db::rows(db,"SELECT text,CAST(start AS REAL) AS start,CAST(end AS REAL) AS end FROM segments WHERE media_id=?1 ORDER BY CAST(start AS REAL),rowid",[id])?,
        "document"=>db::rows(db,"SELECT title||char(10)||body AS text FROM docs WHERE id=?1",[id])?,
        "note"=>db::rows(db,"SELECT title||char(10)||body||char(10)||coalesce((SELECT group_concat(quote,char(10)) FROM note_anchors WHERE note_id=n.id),quote) AS text FROM notes n WHERE id=?1",[id])?,
        _=>anyhow::bail!("Unknown source type"),
    };
    let mut out = Vec::new();
    let mut current = Chunk {
        text: String::new(),
        start: None,
        end: None,
    };
    for piece in pieces {
        let text = piece["text"].as_str().unwrap_or("");
        // Bounded Unicode passages, including documents without whitespace.
        let chars = text.chars().collect::<Vec<_>>();
        for part in chars.chunks(1200) {
            if current.text.chars().count() + part.len() > 1200 && !current.text.is_empty() {
                out.push(current);
                current = Chunk {
                    text: String::new(),
                    start: None,
                    end: None,
                };
            }
            if current.text.is_empty() {
                current.start = piece["start"].as_f64();
            } else {
                current.text.push(' ');
            }
            current.text.extend(part);
            current.end = piece["end"].as_f64();
        }
    }
    if !current.text.trim().is_empty() {
        out.push(current);
    }
    Ok(out)
}
pub fn sources(db: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt=db.prepare("SELECT DISTINCT 'recording',media_id FROM segments JOIN media ON media.id=segments.media_id UNION ALL SELECT 'document',id FROM docs UNION ALL SELECT 'note',id FROM notes")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
pub fn status(root: &Path) -> Result<Value> {
    let db = db::open(root)?;
    let config = config::read(root)?;
    let signature = config.embedding.signature();
    let count: i64 = db.query_row(
        "SELECT count(*) FROM ai_sources WHERE signature=?1",
        [&signature],
        |r| r.get(0),
    )?;
    let vectors: i64 = db.query_row(
        "SELECT count(*) FROM ai_chunks WHERE signature=?1",
        [&signature],
        |r| r.get(0),
    )?;
    let dimensions: Option<i64> = db
        .query_row(
            "SELECT dimensions FROM ai_indexes WHERE signature=?1",
            [signature],
            |r| r.get(0),
        )
        .optional()?;
    Ok(
        json!({"modelReady":config.embedding.kind!="builtin"||super::builtin::ready(root),"indexed":count,"total":sources(&db)?.len(),"chunks":vectors,"dimensions":dimensions,"job":db::rows(&db,"SELECT * FROM ai_jobs ORDER BY created_at DESC,rowid DESC LIMIT 1",[])?.pop()}),
    )
}
pub fn start(root: PathBuf, control: Arc<Control>) -> Result<String> {
    let provider = config::read(&root)?.embedding;
    provider.validate(true)?;
    ensure!(
        !control.indexing.swap(true, Ordering::SeqCst),
        "Indexing is already running"
    );
    control.cancel_index.store(false, Ordering::SeqCst);
    let id = uuid::Uuid::new_v4().to_string();
    let result = (|| -> Result<()> {
        db::open(&root)?.execute(
            "INSERT INTO ai_jobs(id,status,message) VALUES(?1,'running','Preparing search index')",
            [&id],
        )?;
        Ok(())
    })();
    if let Err(e) = result {
        control.indexing.store(false, Ordering::SeqCst);
        return Err(e);
    }
    let job = id.clone();
    std::thread::spawn(move || {
        let result = build(&root, &provider, &control, &job);
        let cancelled = control.cancel_index.load(Ordering::SeqCst);
        let (status, message) = if cancelled {
            (
                "cancelled",
                "Indexing stopped. Completed sources are kept; Update index resumes.".to_owned(),
            )
        } else {
            match result {
                Ok(()) => ("complete", "Search index is up to date".to_owned()),
                Err(e) => ("failed", format!("{e:#}")),
            }
        };
        if let Ok(db) = db::open(&root) {
            let _ = db.execute(
                "UPDATE ai_jobs SET status=?2,message=?3 WHERE id=?1",
                params![job, status, message],
            );
        }
        control.indexing.store(false, Ordering::SeqCst);
    });
    Ok(id)
}
fn build(root: &Path, provider: &Provider, control: &Control, job: &str) -> Result<()> {
    let mut db = db::open(root)?;
    let effective = if provider.kind == "builtin" {
        super::builtin::provider(root, |message| {
            ensure!(!control.cancel_index.load(Ordering::SeqCst), "Cancelled");
            db.execute(
                "UPDATE ai_jobs SET message=?2 WHERE id=?1",
                params![job, message],
            )?;
            Ok(())
        })?
    } else {
        provider.clone()
    };
    let provider = &effective;
    let list = sources(&db)?;
    let signature = provider.signature();
    let client = provider.client()?;
    db.execute(
        "UPDATE ai_jobs SET total=?2 WHERE id=?1",
        params![job, list.len()],
    )?;
    for (i, (kind, id)) in list.iter().enumerate() {
        ensure!(!control.cancel_index.load(Ordering::SeqCst), "Cancelled");
        let source = chunks(&db, kind, id)?;
        let hash = digest(&source);
        let old: Option<String> = db
            .query_row(
                "SELECT digest FROM ai_sources WHERE signature=?1 AND kind=?2 AND source_id=?3",
                params![signature, kind, id],
                |r| r.get(0),
            )
            .optional()?;
        if old.as_deref() != Some(&hash) && !source.is_empty() {
            db.execute(
                "UPDATE ai_jobs SET message=?2 WHERE id=?1",
                params![
                    job,
                    format!("Indexing {} of {} ({kind})", i + 1, list.len())
                ],
            )?;
            let mut vectors = Vec::new();
            for batch in source.chunks(8) {
                ensure!(!control.cancel_index.load(Ordering::SeqCst), "Cancelled");
                vectors.extend(provider.embed(
                    &client,
                    &batch.iter().map(|c| c.text.clone()).collect::<Vec<_>>(),
                )?);
            }
            ensure!(!control.cancel_index.load(Ordering::SeqCst), "Cancelled");
            let dimensions = vectors[0].len();
            ensure!(
                vectors.iter().all(|v| v.len() == dimensions),
                "Embedding dimensions changed during indexing"
            );
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            // A note or transcript could have changed while the remote request was running.
            if digest(&chunks(&tx, kind, id)?) != hash {
                continue;
            }
            let stored: Option<usize> = tx
                .query_row(
                    "SELECT dimensions FROM ai_indexes WHERE signature=?1",
                    [&signature],
                    |r| r.get(0),
                )
                .optional()?;
            ensure!(
                stored.is_none_or(|d| d == dimensions),
                "This model's embedding dimensions changed. Clear its index before rebuilding."
            );
            tx.execute(
                "INSERT OR IGNORE INTO ai_indexes(signature,model,dimensions) VALUES(?1,?2,?3)",
                params![signature, provider.model, dimensions],
            )?;
            tx.execute(
                "DELETE FROM ai_sources WHERE signature=?1 AND kind=?2 AND source_id=?3",
                params![signature, kind, id],
            )?;
            tx.execute(
                "INSERT INTO ai_sources VALUES(?1,?2,?3,?4)",
                params![signature, kind, id, hash],
            )?;
            for (position, (c, vector)) in source.iter().zip(vectors).enumerate() {
                let bytes = vector
                    .iter()
                    .flat_map(|n| n.to_le_bytes())
                    .collect::<Vec<_>>();
                tx.execute("INSERT INTO ai_chunks(signature,kind,source_id,position,text,start,end,vector) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![signature,kind,id,position,c.text,c.start,c.end,bytes])?;
            }
            tx.commit()?;
        }
        db.execute(
            "UPDATE ai_jobs SET done=?2 WHERE id=?1",
            params![job, i + 1],
        )?;
    }
    Ok(())
}
pub fn clear(root: &Path, control: &Control) -> Result<()> {
    ensure!(
        !control.indexing.load(Ordering::SeqCst),
        "Stop indexing before clearing it"
    );
    db::open(root)?.execute(
        "DELETE FROM ai_indexes WHERE signature=?1",
        [config::read(root)?.embedding.signature()],
    )?;
    Ok(())
}
fn metadata(db: &Connection, f: &Filter) -> Result<HashMap<(String, String), Hit>> {
    let rows=db::rows(db,"SELECT 'recording' AS kind,id,title,channel,date FROM media UNION ALL SELECT 'document',id,title,'','' FROM docs UNION ALL SELECT 'note',id,title,'',substr(created_at,1,10) FROM notes",[])?;
    let mut allowed = HashMap::new();
    // Apply filters before ranking/limit. Empty source metadata cannot satisfy a recording filter.
    let tagged: HashSet<(String, String)> = if f.tag.is_empty() {
        HashSet::new()
    } else {
        db::rows(db,"SELECT 'note' AS kind,note_id AS id FROM note_tags WHERE tag=?1 UNION SELECT 'recording',a.media_id FROM note_tags t JOIN note_anchors a ON a.note_id=t.note_id WHERE tag=?1 AND a.media_id IS NOT NULL UNION SELECT 'document',a.doc_id FROM note_tags t JOIN note_anchors a ON a.note_id=t.note_id WHERE tag=?1 AND a.doc_id IS NOT NULL",[&f.tag])?.into_iter().map(|r|(r["kind"].as_str().unwrap().into(),r["id"].as_str().unwrap().into())).collect()
    };
    for r in rows {
        let get = |s: &str| r[s].as_str().unwrap_or("").to_owned();
        let kind = get("kind");
        let id = get("id");
        let date = get("date");
        let channel = get("channel");
        if !f.kind.is_empty() && f.kind != kind
            || !f.channel.is_empty() && f.channel != channel
            || !f.media_id.is_empty() && (kind != "recording" || id != f.media_id)
            || !f.from.is_empty() && date < f.from
            || !f.to.is_empty() && (date.is_empty() || date > f.to)
            || !f.tag.is_empty() && !tagged.contains(&(kind.clone(), id.clone()))
            || !f.speaker.is_empty() && kind != "recording"
        {
            continue;
        }
        allowed.insert(
            (kind.clone(), id.clone()),
            Hit {
                kind,
                id,
                title: get("title"),
                channel,
                date,
                text: String::new(),
                start: None,
                end: None,
                score: 0.,
            },
        );
    }
    Ok(allowed)
}
fn speaker_ranges(db: &Connection, speaker: &str) -> Result<HashMap<String, Vec<(f64, f64)>>> {
    let mut ranges: HashMap<String, Vec<(f64, f64)>> = HashMap::new();
    if speaker.is_empty() {
        return Ok(ranges);
    }
    let mut stmt=db.prepare("SELECT f.media_id,CAST(f.start AS REAL),CAST(f.end AS REAL) FROM segments f JOIN assignments a ON a.media_id=f.media_id AND a.local_id=f.speaker WHERE a.speaker_id=?1")?;
    for row in stmt.query_map([speaker], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, f64>(2)?,
        ))
    })? {
        let (id, start, end) = row?;
        ranges.entry(id).or_default().push((start, end));
    }
    Ok(ranges)
}
fn allowed_time(
    f: &Filter,
    ranges: &HashMap<String, Vec<(f64, f64)>>,
    id: &str,
    start: Option<f64>,
    end: Option<f64>,
) -> bool {
    f.speaker.is_empty()
        || ranges.get(id).is_some_and(|r| {
            r.iter()
                .any(|(s, e)| *e > start.unwrap_or(0.) && *s < end.unwrap_or(f64::MAX))
        })
}
pub fn query_input(query: &str, model: &str) -> String {
    let model = model.to_lowercase();
    if model.contains("qwen3-embedding") {
        format!("Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: {query}")
    } else if model.contains("embeddinggemma") {
        format!("task: search result | query: {query}")
    } else if model.contains("nomic-embed-text") {
        format!("search_query: {query}")
    } else {
        query.to_owned()
    }
}
pub fn search(
    root: &Path,
    query: &str,
    semantic: bool,
    f: &Filter,
    limit: usize,
) -> Result<Vec<Hit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }
    ensure!(query.len() <= 16000, "Search query is too long");
    let db = db::open(root)?;
    let meta = metadata(&db, f)?;
    let ranges = speaker_ranges(&db, &f.speaker)?;
    let mut hits = Vec::new();
    let limit = limit.clamp(1, 200);
    if semantic {
        let provider = config::read(root)?.embedding;
        provider.validate(true)?;
        let signature = provider.signature();
        let dimensions: usize = db
            .query_row(
                "SELECT dimensions FROM ai_indexes WHERE signature=?1",
                [&signature],
                |r| r.get(0),
            )
            .optional()?
            .context("Create a search index for this embedding model in Settings")?;
        let provider = if provider.kind == "builtin" {
            super::builtin::provider(root, |_| Ok(()))?
        } else {
            provider
        };
        let vector = provider
            .embed(&provider.client()?, &[query_input(query, &provider.model)])?
            .remove(0);
        ensure!(vector.len()==dimensions,"Embedding dimensions do not match the index. Rebuild the index with the current model.");
        let mut stmt = db.prepare(
            "SELECT kind,source_id,text,start,end,vector FROM ai_chunks WHERE signature=?1",
        )?;
        let mut rows = stmt.query([signature])?;
        while let Some(r) = rows.next()? {
            let kind: String = r.get(0)?;
            let id: String = r.get(1)?;
            let Some(base) = meta.get(&(kind, id.clone())) else {
                continue;
            };
            let start = r.get(3)?;
            let end = r.get(4)?;
            if !allowed_time(f, &ranges, &id, start, end) {
                continue;
            }
            let bytes = r.get_ref(5)?.as_blob()?;
            ensure!(
                bytes.len() == dimensions * 4,
                "Corrupt search vector; rebuild the index"
            );
            let score = bytes
                .as_chunks::<4>()
                .0
                .iter()
                .zip(&vector)
                .map(|(b, v)| f32::from_le_bytes(*b) as f64 * *v as f64)
                .sum::<f64>();
            if !score.is_finite() || score < 0.25 {
                continue;
            }
            if hits.len() < limit || hits.last().is_some_and(|h: &Hit| score > h.score) {
                let mut h = base.clone();
                h.text = r.get(2)?;
                h.start = start;
                h.end = end;
                h.score = score;
                hits.push(h);
                hits.sort_by(|a, b| b.score.total_cmp(&a.score));
                hits.truncate(limit);
            }
        }
    } else {
        let fts = query
            .split_whitespace()
            .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let mut stmt=db.prepare("SELECT media_id,text,CAST(start AS REAL),CAST(end AS REAL),rank FROM segments WHERE segments MATCH ?1 ORDER BY rank")?;
        let mut rows = stmt.query([fts])?;
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            if let Some(base) = meta.get(&("recording".into(), id.clone())) {
                let start = r.get(2)?;
                let end = r.get(3)?;
                if !allowed_time(f, &ranges, &id, start, end) {
                    continue;
                }
                let mut h = base.clone();
                h.text = r.get(1)?;
                h.start = start;
                h.end = end;
                h.score = -r.get::<_, f64>(4)?;
                hits.push(h);
                if hits.len() >= limit {
                    break;
                }
            }
        }
        // Text documents and notes are small enough to scan; recording search uses FTS.
        let terms = query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        for ((kind, id), base) in &meta {
            if kind == "recording" {
                continue;
            }
            for c in chunks(&db, kind, id)? {
                let lower = c.text.to_lowercase();
                if terms.iter().all(|t| lower.contains(t)) {
                    let mut h = base.clone();
                    h.text = c.text;
                    h.score = 1.;
                    hits.push(h);
                    break;
                }
            }
        }
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.title.cmp(&b.title)));
        hits.truncate(limit);
    }
    Ok(hits)
}
pub fn filters(root: &Path) -> Result<Value> {
    let db = db::open(root)?;
    Ok(
        json!({"channels":db::rows(&db,"SELECT DISTINCT channel FROM media ORDER BY channel",[])?,"speakers":db::rows(&db,"SELECT id,name FROM speakers WHERE is_noise=0 ORDER BY name",[])?,"tags":db::rows(&db,"SELECT DISTINCT tag FROM note_tags ORDER BY tag",[])?}),
    )
}
