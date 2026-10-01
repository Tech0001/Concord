use crate::{ai, db};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub detail: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub category: String,
    pub severity: String,
    pub title: String,
    pub description: String,
    pub count: usize,
    pub items: Vec<Item>,
    pub repair: Option<String>,
}
fn issue(
    out: &mut Vec<Issue>,
    id: &str,
    category_severity: (&str, &str),
    title: &str,
    description: &str,
    items: Vec<Item>,
    repair: Option<&str>,
) {
    if !items.is_empty() {
        out.push(Issue {
            id: id.into(),
            category: category_severity.0.into(),
            severity: category_severity.1.into(),
            title: title.into(),
            description: description.into(),
            count: items.len(),
            items,
            repair: repair.map(str::to_owned),
        });
    }
}
fn scalar(db: &Connection, sql: &str) -> Result<i64> {
    Ok(db.query_row(sql, [], |r| r.get(0))?)
}
fn item(v: &Value, kind: &str, detail: &str) -> Item {
    Item {
        id: v["id"].as_str().unwrap_or("").into(),
        title: v["title"].as_str().unwrap_or("Source").into(),
        kind: kind.into(),
        detail: detail.into(),
    }
}
fn strv<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn rows(root: &Path) -> Result<Vec<Value>> {
    db::rows(&db::open(root)?,"SELECT m.*,c.diarize,c.enabled,c.include_shorts FROM media m LEFT JOIN channels c ON c.id=m.source_id ORDER BY m.title",[])
}
pub fn snapshot(root: &Path) -> Result<Value> {
    let db = db::open(root)?;
    let config = ai::config::read(root)?;
    let signature = config.embedding.signature();
    let media = rows(root)?;
    let fts = db::rows(
        &db,
        "SELECT media_id,count(*) AS segments FROM segments GROUP BY media_id",
        [],
    )?;
    let fts_ids: HashSet<_> = fts.iter().filter_map(|v| v["media_id"].as_str()).collect();
    let diar: HashSet<String> = {
        let mut q = db.prepare("SELECT DISTINCT media_id FROM assignments")?;
        let out = q
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        out
    };
    let summaries: HashSet<String> = {
        let mut q = db.prepare("SELECT media_id FROM ai_summaries WHERE trim(content)<>''")?;
        let out = q
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        out
    };
    let indexed = db::rows(
        &db,
        "SELECT kind,source_id FROM ai_sources WHERE signature=?1",
        [&signature],
    )?;
    let embedded: HashSet<_> = indexed
        .iter()
        .filter(|v| v["kind"] == "recording")
        .filter_map(|v| v["source_id"].as_str())
        .collect();
    let embedded_docs: HashSet<_> = indexed
        .iter()
        .filter(|v| v["kind"] == "document")
        .filter_map(|v| v["source_id"].as_str())
        .collect();
    let complete: Vec<_> = media.iter().filter(|m| m["status"] == "complete").collect();
    let applicable: Vec<_> = complete
        .iter()
        .filter(|m| m["diarize"].as_i64() != Some(0))
        .collect();
    let docs = db::rows(
        &db,
        "SELECT id,title,path,root_id,starred,category,length(trim(body)) AS length FROM docs",
        [],
    )?;
    let mut channels: Vec<Value> = db::rows(&db, "SELECT * FROM channels ORDER BY name", [])?;
    let known: HashSet<String> = channels
        .iter()
        .filter_map(|c| c["id"].as_str().map(str::to_owned))
        .collect();
    let mut loose = HashSet::new();
    for m in &media {
        if !known.contains(strv(m, "source_id")) && loose.insert(strv(m, "channel").to_owned()) {
            channels.push(json!({"id":format!("collection:{}",strv(m,"channel")),"name":m["channel"],"enabled":null,"diarize":1,"include_shorts":0}));
        }
    }
    for c in &mut channels {
        let group: Vec<_> = media
            .iter()
            .filter(|m| {
                if known.contains(strv(c, "id")) {
                    m["source_id"] == c["id"]
                } else {
                    m["channel"] == c["name"]
                }
            })
            .collect();
        let done: Vec<_> = group.iter().filter(|m| m["status"] == "complete").collect();
        c["total"] = json!(group.len());
        c["complete"] = json!(done.len());
        c["pending"] = json!(group
            .iter()
            .filter(|m| ["ready", "pending", "queued"].contains(&strv(m, "status")))
            .count());
        c["failed"] = json!(group.iter().filter(|m| m["status"] == "failed").count());
        c["embedded"] = json!(done
            .iter()
            .filter(|m| embedded.contains(strv(m, "id")))
            .count());
        c["summarized"] = json!(done
            .iter()
            .filter(|m| summaries.contains(strv(m, "id")))
            .count());
        c["diarized"] = json!(done.iter().filter(|m| diar.contains(strv(m, "id"))).count());
    }
    let dims: Option<i64> = db
        .query_row(
            "SELECT dimensions FROM ai_indexes WHERE signature=?1",
            [&signature],
            |r| r.get(0),
        )
        .optional()?;
    let trans = complete
        .iter()
        .filter(|m| Path::new(strv(m, "transcript")).is_file())
        .count();
    let with_text: Vec<_> = docs
        .iter()
        .filter(|d| d["length"].as_i64().unwrap_or(0) > 0)
        .collect();
    let covered = |n: usize, t: usize| json!({"covered":n,"total":t});
    Ok(
        json!({"generatedAt":super::now(),"pipeline":crate::pipeline::overview(root)?,"archive":{"total":media.len(),"complete":complete.len(),"hours":complete.iter().map(|m|m["duration"].as_f64().unwrap_or(0.)).sum::<f64>()/3600.,"pending":media.iter().filter(|m|["ready","pending","queued"].contains(&strv(m,"status"))).count(),"failed":media.iter().filter(|m|m["status"]=="failed").count(),"words":complete.iter().map(|m|m["words"].as_i64().unwrap_or(0)).sum::<i64>()},
      "coverage":{"transcripts":covered(trans,complete.len()),"fts":covered(complete.iter().filter(|m|fts_ids.contains(strv(m,"id"))).count(),complete.len()),"segments":fts.iter().map(|m|m["segments"].as_i64().unwrap_or(0)).sum::<i64>(),"embeddings":covered(complete.iter().filter(|m|embedded.contains(strv(m,"id"))).count(),complete.len()),"summaries":covered(complete.iter().filter(|m|summaries.contains(strv(m,"id"))).count(),complete.len()),"diarization":covered(applicable.iter().filter(|m|diar.contains(strv(m,"id"))).count(),applicable.len()),"documents":covered(with_text.len(),docs.len()),"documentEmbeddings":covered(with_text.iter().filter(|d|embedded_docs.contains(strv(d,"id"))).count(),with_text.len())},
      "speakers":{"total":scalar(&db,"SELECT count(*) FROM speakers WHERE is_noise=0")?,"unidentified":scalar(&db,"SELECT count(*) FROM assignments WHERE speaker_id IS NULL")?},"documents":{"starred":docs.iter().filter(|d|d["starred"]==1).count(),"personal":docs.iter().filter(|d|d["category"]=="personal").count(),"work":docs.iter().filter(|d|d["category"]=="work").count()},"channels":channels,
      "embedding":{"model":config.embedding.model,"dimensions":dims,"enabled":config.embedding.enabled},"chat":{"configured":config.chat.enabled&&!config.chat.model.is_empty(),"model":config.chat.model},
      "jobs":db::rows(&db,"SELECT * FROM maintenance_jobs ORDER BY created_at DESC,rowid DESC LIMIT 40",[])?,"aiJobs":db::rows(&db,"SELECT * FROM ai_jobs ORDER BY created_at DESC,rowid DESC LIMIT 20",[])?,"restorePending":root.join("restore-pending.sqlite").is_file()}),
    )
}
pub fn audit(root: &Path) -> Result<Value> {
    let db = db::open(root)?;
    let media = rows(root)?;
    let mut issues = Vec::new();
    if db.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key='pending-media-file-action')",[],|r|r.get::<_,bool>(0))? {
        issue(&mut issues,"pending-file-action",("files","error"),"Interrupted recording file action","A rename or Trash action needs recovery. Restart Concord, then check Terminal for the affected paths if this remains.",vec![Item{id:"file-action".into(),title:"Recording file action".into(),kind:"file".into(),detail:"See Terminal for recovery paths".into()}],None);
    }
    let config = ai::config::read(root)?;
    let signature = config.embedding.signature();
    let fts: HashSet<String> = {
        let mut q = db.prepare("SELECT DISTINCT media_id FROM segments")?;
        let out = q
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        out
    };
    let stamps = db::rows(&db, "SELECT * FROM archive_transcripts", [])?;
    let stamps: HashMap<_, _> = stamps.iter().map(|v| (strv(v, "media_id"), v)).collect();
    let fingerprints = db::rows(&db, "SELECT * FROM media_fingerprints", [])?;
    let prints: HashMap<_, _> = fingerprints
        .iter()
        .map(|v| (strv(v, "media_id"), v))
        .collect();
    let legacy: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='imported_from'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let mut missing_media = Vec::new();
    let mut missing_transcripts = Vec::new();
    let mut stale = Vec::new();
    let mut thumbnails = Vec::new();
    let mut unhashed = Vec::new();
    let mut media_bytes = 0;
    let mut seen_paths = HashSet::new();
    let mut groups: HashMap<String, Vec<Item>> = HashMap::new();
    for m in &media {
        let id = strv(m, "id");
        let path = Path::new(strv(m, "path"));
        let transcript = Path::new(strv(m, "transcript"));
        if m["status"] != "archived" && !path.as_os_str().is_empty() && !path.is_file() {
            missing_media.push(item(m, "recording", strv(m, "path")));
        }
        if m["status"] == "complete" && !transcript.is_file() {
            missing_transcripts.push(item(m, "recording", strv(m, "transcript")));
        }
        if let Ok((bytes, mtime)) = super::stamp(transcript) {
            if !fts.contains(id)
                || !stamps.get(id).is_some_and(|s| {
                    s["path"] == m["transcript"]
                        && s["bytes"].as_u64() == Some(bytes)
                        && s["mtime"].as_u64().is_some_and(|t| t.abs_diff(mtime) <= 1)
                })
            {
                stale.push(item(
                    m,
                    "recording",
                    "Transcript index needs verification or rebuilding",
                ));
            }
        }
        if let Ok((bytes, mtime)) = super::stamp(path) {
            if seen_paths.insert(path) {
                media_bytes += bytes;
            }
            let audio = db::AUDIO_EXTENSIONS.contains(
                &path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .as_str(),
            );
            if !audio
                && crate::thumbnail::cached(root, id, legacy.as_deref().map(Path::new)).is_none()
            {
                thumbnails.push(item(m, "recording", "Generate a cached thumbnail"));
            }
            if let Some(p) = prints.get(id).filter(|p| {
                p["path"] == m["path"]
                    && p["bytes"].as_u64() == Some(bytes)
                    && p["mtime"].as_u64() == Some(mtime)
            }) {
                groups
                    .entry(strv(p, "fingerprint").into())
                    .or_default()
                    .push(item(m, "recording", strv(m, "path")));
            } else {
                unhashed.push(item(m, "recording", strv(m, "path")));
            }
        }
    }
    issue(
        &mut issues,
        "missing-media",
        ("storage", "error"),
        "Missing media files",
        "Reconnect the drive or relink these recordings. The audit does not remove anything.",
        missing_media,
        None,
    );
    issue(&mut issues,"missing-transcripts",("transcripts","error"),"Missing transcripts","Completed recordings need a readable transcript file. Review them to re-transcribe or reconnect the source.",missing_transcripts,None);
    issue(
        &mut issues,
        "stale-fts",
        ("transcripts", "warning"),
        "Stale transcript search index",
        "Transcript files changed or have not been verified against this search index.",
        stale,
        Some("reindex"),
    );
    issue(
        &mut issues,
        "thumbnails",
        ("thumbnails", "warning"),
        "Missing cached thumbnails",
        "Copy existing source artwork or generate a frame in the background.",
        thumbnails,
        Some("thumbnails"),
    );
    let indexed = db::rows(
        &db,
        "SELECT kind,source_id FROM ai_sources WHERE signature=?1",
        [&signature],
    )?;
    for (kind, title, action) in [
        (
            "recording",
            "Recordings missing semantic embeddings",
            "embed-recordings",
        ),
        (
            "document",
            "Documents missing semantic embeddings",
            "embed-documents",
        ),
    ] {
        let existing: HashSet<_> = indexed
            .iter()
            .filter(|v| v["kind"] == kind)
            .map(|v| strv(v, "source_id"))
            .collect();
        let source = if kind == "recording" {
            media
                .iter()
                .filter(|m| m["status"] == "complete" && fts.contains(strv(m, "id")))
                .cloned()
                .collect()
        } else {
            db::rows(&db, "SELECT id,title FROM docs WHERE trim(body)<>''", [])?
        };
        issue(&mut issues,action,("embeddings","warning"),title,"These sources are absent from the active model's vector space. Keyword search still works. Repairs verify dimensions before writing vectors.",source.iter().filter(|m|!existing.contains(strv(m,"id"))).map(|m|item(m,kind,"")).collect(),Some(action));
    }
    let roots = db::rows(&db, "SELECT * FROM document_roots WHERE enabled=1", [])?;
    issue(
        &mut issues,
        "roots",
        ("storage", "error"),
        "Disconnected document folders",
        "Reconnect the folders to resume document synchronization.",
        roots
            .iter()
            .filter(|r| !Path::new(strv(r, "path")).is_dir())
            .map(|r| Item {
                id: strv(r, "id").into(),
                title: strv(r, "path").into(),
                detail: String::new(),
                kind: "folder".into(),
            })
            .collect(),
        None,
    );
    issue(&mut issues,"unhashed",("duplicates","info"),"Duplicate scan incomplete","Sample the file size and first/last MiB to find possible copies without reading the whole archive.",unhashed,Some("fingerprints"));
    let duplicates: Vec<_> = groups
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .flat_map(|(hash, items)| {
            items.into_iter().map(move |mut i| {
                i.detail = format!("{} · fingerprint {}", i.detail, &hash[..12.min(hash.len())]);
                i
            })
        })
        .collect();
    issue(&mut issues,"duplicates",("duplicates","warning"),"Possible duplicate recordings","Matching sampled fingerprints identify possible copies. Review their sources before deciding what to remove.",duplicates,None);
    let orphan=db::rows(&db,"SELECT n.id,n.title,a.media_id,a.doc_id FROM note_anchors a JOIN notes n ON n.id=a.note_id LEFT JOIN media m ON m.id=a.media_id LEFT JOIN docs d ON d.id=a.doc_id WHERE (a.media_id IS NOT NULL AND m.id IS NULL) OR (a.doc_id IS NOT NULL AND d.id IS NULL)",[])?;
    issue(
        &mut issues,
        "orphan-notes",
        ("notes", "warning"),
        "Notes anchored to unavailable sources",
        "Your notes and quoted evidence are preserved.",
        orphan.iter().map(|n| item(n, "note", "")).collect(),
        None,
    );
    let orphans=db::rows(&db,"SELECT DISTINCT media_id AS id,'Transcript search data' AS title FROM segments WHERE media_id NOT IN (SELECT id FROM media) UNION ALL SELECT source_id AS id,'Semantic search data' AS title FROM ai_sources WHERE (kind='recording' AND source_id NOT IN (SELECT id FROM media)) OR (kind='document' AND source_id NOT IN (SELECT id FROM docs)) OR (kind='note' AND source_id NOT IN (SELECT id FROM notes))",[])?;
    issue(
        &mut issues,
        "orphans",
        ("embeddings", "info"),
        "Orphaned derived index sources",
        "Remove only rebuildable index rows for sources no longer in the library.",
        orphans.iter().map(|n| item(n, "index", "")).collect(),
        Some("cleanup"),
    );
    let broken = db::rows(&db, "SELECT id,title FROM media WHERE status='failed'", [])?;
    issue(
        &mut issues,
        "failed-work",
        ("jobs", "warning"),
        "Failed archive work",
        "Review current failures and retry from the recording or activity view.",
        broken
            .iter()
            .map(|m| item(m, "recording", "Current processing failure"))
            .collect(),
        None,
    );
    let integrity: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        issue(
            &mut issues,
            "database-integrity",
            ("storage", "error"),
            "Database integrity check failed",
            "Create a backup and inspect the log before attempting recovery.",
            vec![Item {
                id: "database".into(),
                title: "Library database".into(),
                kind: "database".into(),
                detail: integrity,
            }],
            None,
        );
    }
    let errors: usize = issues
        .iter()
        .filter(|i| i.severity == "error")
        .map(|i| i.count)
        .sum();
    let warnings: usize = issues
        .iter()
        .filter(|i| i.severity == "warning")
        .map(|i| i.count)
        .sum();
    let report = json!({"generatedAt":super::now(),"errors":errors,"warnings":warnings,"issues":issues,"databaseBytes":root.join("library.db").metadata()?.len()+root.join("library.db-wal").metadata().map(|m|m.len()).unwrap_or(0),"mediaBytes":media_bytes});
    db.execute("INSERT INTO settings(key,value) VALUES ('health.lastAudit',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[report.to_string()])?;
    crate::runtime_log::push(
        "info",
        &format!("Archive audit completed: {errors} errors, {warnings} warnings"),
    );
    Ok(report)
}
