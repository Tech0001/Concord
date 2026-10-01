use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn data_root() -> PathBuf {
    if let Some(path) = std::env::var_os("CONCORD_NEXT_DATA") {
        return path.into();
    }
    #[cfg(target_os = "linux")]
    {
        directories::BaseDirs::new()
            .expect("home directory")
            .data_dir()
            .join("concord-next")
    }
    #[cfg(not(target_os = "linux"))]
    {
        directories::ProjectDirs::from("app", "Concord", "Concord Next")
            .expect("home directory")
            .data_dir()
            .to_path_buf()
    }
}

pub fn legacy_root() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        directories::BaseDirs::new()
            .expect("home directory")
            .data_dir()
            .join("concord")
    }
    #[cfg(not(target_os = "linux"))]
    {
        directories::ProjectDirs::from("", "", "Concord")
            .expect("home directory")
            .data_dir()
            .to_path_buf()
    }
}

pub fn open(root: &Path) -> Result<Connection> {
    std::fs::create_dir_all(root)?;
    let mut db = Connection::open(root.join("library.db"))?;
    db.busy_timeout(std::time::Duration::from_secs(10))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT 'Imports',
        date TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0, path TEXT, transcript TEXT,
        words INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE IF NOT EXISTS speakers (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, notes TEXT, embedding BLOB);
      CREATE TABLE IF NOT EXISTS assignments (
        media_id TEXT NOT NULL REFERENCES media(id), local_id TEXT NOT NULL, speaker_id TEXT REFERENCES speakers(id),
        centroid BLOB, airtime REAL NOT NULL DEFAULT 0, start REAL, end REAL, confidence REAL,
        PRIMARY KEY (media_id,local_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS segments USING fts5(media_id UNINDEXED, start UNINDEXED, end UNINDEXED, speaker UNINDEXED, text, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',quote TEXT NOT NULL DEFAULT '',
        media_id TEXT REFERENCES media(id),start REAL,end REAL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS links (source TEXT REFERENCES notes(id),target TEXT REFERENCES notes(id),kind TEXT,PRIMARY KEY(source,target,kind));
      CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,media_id TEXT REFERENCES media(id),title TEXT NOT NULL,
        status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (datetime('now')));")?;
    migrate(&mut db)?;
    Ok(db)
}

/// Columns added in schema version 2 (library state). Applied idempotently.
const MEDIA_COLUMNS_V2: [(&str, &str); 4] = [
    ("starred", "starred INTEGER NOT NULL DEFAULT 0"),
    ("review_state", "review_state TEXT NOT NULL DEFAULT 'unreviewed'"),
    ("position", "position REAL NOT NULL DEFAULT 0"),
    ("opened_at", "opened_at TEXT"),
];

fn migrate(db: &mut Connection) -> Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= 10 {
        return Ok(());
    }
    // Immediate: two windows opening at once must not both add the columns.
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (name, ddl) in MEDIA_COLUMNS_V2 {
        let present: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('media') WHERE name = ?1)",
            [name],
            |r| r.get(0),
        )?;
        if !present {
            tx.execute_batch(&format!("ALTER TABLE media ADD COLUMN {ddl}"))?;
        }
    }
    if version < 3 {
    for (name, ddl) in [("is_noise", "is_noise INTEGER NOT NULL DEFAULT 0"), ("sample_count", "sample_count INTEGER NOT NULL DEFAULT 1")] {
        let present: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('speakers') WHERE name=?1)", [name], |r| r.get(0))?;
        if !present { tx.execute_batch(&format!("ALTER TABLE speakers ADD COLUMN {ddl}"))?; }
    }
    tx.execute_batch("UPDATE speakers SET is_noise=1 WHERE name='(noise)';
      CREATE TABLE IF NOT EXISTS speaker_training (
        speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL, local_id TEXT NOT NULL,
        PRIMARY KEY(speaker_id,media_id,local_id));
      INSERT OR IGNORE INTO speaker_training SELECT speaker_id,media_id,local_id FROM assignments WHERE speaker_id IS NOT NULL AND centroid IS NOT NULL;
      INSERT OR IGNORE INTO assignments(media_id,local_id,airtime,start,end)
        SELECT f.media_id,f.speaker,sum(max(0,CAST(f.end AS REAL)-CAST(f.start AS REAL))),min(CAST(f.start AS REAL)),max(CAST(f.end AS REAL))
        FROM segments f JOIN media m ON m.id=f.media_id WHERE f.speaker IS NOT NULL AND f.speaker<>'' GROUP BY f.media_id,f.speaker;
      PRAGMA user_version = 3")?;
    }
    if version < 4 { crate::research::migrate(&tx)?; }
    if version < 5 { crate::ai::migrate(&tx)?; }
    if version < 6 { crate::health::migrate(&tx)?; }
    if version < 7 { crate::documents::migrate(&tx)?; }
    if version < 8 { crate::pipeline::migrate(&tx)?; }
    if version < 9 {crate::pipeline::migrate_sources(&tx)?;}
    crate::search_index::migrate(&tx)?;
    tx.execute_batch("PRAGMA user_version=10")?;
    tx.commit()?;
    Ok(())
}

/// LIKE pattern that treats the user's text literally.
pub fn like_pattern(query: &str) -> String {
    format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

pub fn rows(db: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let result = stmt
        .query_map(args, |row| {
            let mut item = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let v = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(x) => json!(x),
                    ValueRef::Real(x) => json!(x),
                    ValueRef::Text(x) => json!(String::from_utf8_lossy(x)),
                    ValueRef::Blob(_) => Value::Null,
                };
                item.insert(name.clone(), v);
            }
            Ok(Value::Object(item))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}

pub fn stats(root: &Path) -> Result<Value> {
    let db = open(root)?;
    Ok(
        json!({"media":db.query_row("SELECT count(*) FROM media",[],|r|r.get::<_,i64>(0))?,
      "speakers":db.query_row("SELECT count(*) FROM speakers",[],|r|r.get::<_,i64>(0))?,
      "notes":db.query_row("SELECT count(*) FROM notes",[],|r|r.get::<_,i64>(0))?,
      "docs":db.query_row("SELECT count(*) FROM docs",[],|r|r.get::<_,i64>(0))?,
      "dataRoot":root,"legacyDatabase":legacy_root().join("pipeline.db")}),
    )
}

/// Copy only archive content, never jobs, watchers, credentials, or a writable source connection.
/// Import is atomic and only allowed into an empty library; repeated imports cannot erase edits.
pub fn import_legacy(root: &Path, source: &Path) -> Result<Value> {
    let source = source
        .canonicalize()
        .context("Cannot open that Concord database")?;
    let check = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64=check.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('video_queue','speakers','transcript_segments_fts')",[],|r|r.get(0))?;
    if version != 3 {
        bail!("This is not a supported Concord library database");
    }
    drop(check);
    let mut db = open(root)?;
    if db.query_row("SELECT count(*) FROM media", [], |r| r.get::<_, i64>(0))? > 0 {
        bail!("Import requires an empty Concord Next library so existing edits stay safe");
    }
    let mut uri =
        url::Url::from_file_path(&source).map_err(|_| anyhow::anyhow!("Invalid database path"))?;
    uri.query_pairs_mut().append_pair("mode", "ro");
    db.execute("ATTACH DATABASE ?1 AS previous", [uri.as_str()])?;
    let tx = db.transaction()?;
    tx.execute_batch("INSERT INTO media(id,title,url,channel,date,duration,path,transcript,words,status)
      SELECT json_array(v.channel_id,v.video_id),v.title,v.url,coalesce(c.name,'Imports'),coalesce(v.upload_date,''),
        coalesce(v.duration,0),v.video_path,v.md_path,coalesce(v.word_count,0),CASE WHEN v.md_path IS NOT NULL THEN 'complete' ELSE 'ready' END
      FROM previous.video_queue v LEFT JOIN previous.channels c ON c.id=v.channel_id;
      INSERT INTO speakers(id,name,color,notes,embedding)
        SELECT s.id,s.name,s.display_color,s.notes,e.embedding FROM previous.speakers s LEFT JOIN previous.speaker_embeddings e ON e.speaker_id=s.id;
      INSERT INTO assignments(media_id,local_id,speaker_id,centroid,airtime,start,end,confidence)
        SELECT json_array(a.channel_id,a.video_id),a.local_speaker,a.speaker_id,a.centroid,a.airtime_seconds,a.sample_start,a.sample_end,a.confidence
        FROM previous.video_speaker_assignments a JOIN media m ON m.id=json_array(a.channel_id,a.video_id);
      INSERT INTO segments(media_id,start,end,speaker,text)
        SELECT json_array(channel_id,video_id),start_seconds,end_seconds,speaker,text FROM previous.transcript_segments_fts;
      INSERT INTO notes(id,title,body,quote,media_id,start,end,created_at,updated_at)
        SELECT n.id,n.title,coalesce(n.note,''),coalesce(n.quote,''),m.id,n.start_seconds,n.end_seconds,n.created_at,n.created_at
        FROM previous.transcript_clips n LEFT JOIN media m ON m.id=json_array(n.channel_id,n.video_id);
      INSERT OR IGNORE INTO links(source,target,kind)
        SELECT CASE WHEN kind IN ('same_claim','same_topic','contradicts','related') AND from_clip_id>to_clip_id THEN to_clip_id ELSE from_clip_id END,
               CASE WHEN kind IN ('same_claim','same_topic','contradicts','related') AND from_clip_id>to_clip_id THEN from_clip_id ELSE to_clip_id END,kind FROM previous.clip_links
        WHERE from_clip_id IN (SELECT id FROM notes) AND to_clip_id IN (SELECT id FROM notes);
      INSERT INTO docs(id,title,body)
        SELECT d.id,d.title,coalesce((SELECT group_concat(text,char(10)||char(10)) FROM
          (SELECT text FROM previous.docs_fts f WHERE f.document_id=d.id ORDER BY CAST(chunk_index AS INTEGER))), '')
        FROM previous.documents d;")?;
    tx.execute(
        "INSERT INTO settings VALUES ('imported_from',?1)",
        [source.to_string_lossy().as_ref()],
    )?;
    tx.execute_batch("UPDATE speakers SET is_noise=1 WHERE name='(noise)';
      INSERT OR IGNORE INTO speaker_training SELECT speaker_id,media_id,local_id FROM assignments WHERE speaker_id IS NOT NULL AND centroid IS NOT NULL;")?;
    crate::research::backfill(&tx)?;
    tx.commit()?;
    drop(db);
    for result in [crate::health::legacy::seed(root), crate::legacy_research::seed(root), crate::documents::seed_legacy(root), crate::pipeline::sources::seed(root)] {
        if let Err(e) = result { crate::runtime_log::push("warn", &format!("Additional legacy metadata import: {e:#}")); }
    }
    stats(root)
}

pub const AUDIO_EXTENSIONS: [&str; 8] = ["ogg", "oga", "opus", "mp3", "m4a", "wav", "flac", "aac"];
pub const REVIEW_STATES: [&str; 3] = ["unreviewed", "in_review", "reviewed"];

/// SQL expression classifying `m` as audio or video by file extension.
fn kind_sql() -> String {
    let tests: Vec<String> = AUDIO_EXTENSIONS
        .iter()
        .map(|e| format!("lower(coalesce(m.path,'')) LIKE '%.{e}'"))
        .collect();
    format!("CASE WHEN {} THEN 'audio' ELSE 'video' END", tests.join(" OR "))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryFilter {
    pub category: String,
    pub status: String,
    pub query: String,
    pub channel: String,
    pub kind: String,
    pub transcribed: String,
    pub starred: bool,
    pub review: String,
    pub sort: String,
    pub offset: u32,
    pub limit: u32,
}

fn order_by(sort: &str) -> &'static str {
    match sort {
        "oldest" => "replace(m.date, '-', '') ASC, m.title COLLATE NOCASE",
        "opened" => "m.opened_at IS NULL, m.opened_at DESC, replace(m.date, '-', '') DESC",
        "words" => "m.words DESC, replace(m.date, '-', '') DESC",
        "title" => "m.title COLLATE NOCASE, replace(m.date, '-', '') DESC",
        "longest" => "m.duration DESC, replace(m.date, '-', '') DESC",
        _ => "replace(m.date, '-', '') DESC, m.title COLLATE NOCASE",
    }
}

pub fn library(root: &Path, f: &LibraryFilter) -> Result<Value> {
    let db = open(root)?;
    let kind = kind_sql();
    let query = f.query.trim();
    let pattern = like_pattern(query);
    let cte = "WITH latest_job AS (
      SELECT media_id,status,row_number() OVER (PARTITION BY media_id ORDER BY rowid DESC) AS position FROM jobs
    ), library_media AS (
      SELECT m.*, CASE WHEN m.status='archived' THEN 'archived' ELSE CASE j.status WHEN 'running' THEN 'processing' WHEN 'queued' THEN 'pending'
        WHEN 'retry' THEN 'pending' WHEN 'waiting_live' THEN 'live' WHEN 'failed' THEN 'failed'
        WHEN 'cancelled' THEN 'cancelled' ELSE CASE m.status
          WHEN 'live' THEN 'live' WHEN 'waiting_live' THEN 'live' WHEN 'failed' THEN 'failed'
          WHEN 'archived' THEN 'archived' WHEN 'pending' THEN 'pending' WHEN 'queued' THEN 'pending'
          WHEN 'cancelled' THEN 'cancelled' ELSE CASE WHEN m.transcript IS NOT NULL THEN 'complete' ELSE 'ready' END END
        END END AS processing_status FROM media m LEFT JOIN latest_job j ON j.media_id=m.id AND j.position=1
    )";
    let filter = format!(
        "(?1 = '' OR m.title LIKE ?2 ESCAPE '\\' OR m.channel LIKE ?2 ESCAPE '\\' OR coalesce(m.path,'') LIKE ?2 ESCAPE '\\')
         AND (?3 = '' OR m.channel = ?3)
         AND (?4 = '' OR {kind} = ?4)
         AND (?5 = '' OR (?5 = 'yes') = (m.transcript IS NOT NULL))
         AND (?6 = 0 OR m.starred = 1)
         AND (?7 = '' OR m.review_state = ?7)
         AND (?8 = '' OR m.category = ?8) AND (?9 = '' OR m.processing_status = ?9)"
    );
    let args: [&dyn rusqlite::ToSql; 9] = [&query, &pattern, &f.channel, &f.kind, &f.transcribed, &f.starred, &f.review, &f.category, &f.status];
    let (total, transcribed): (i64, i64) = db.query_row(
        &format!("{cte} SELECT count(*), coalesce(sum(m.transcript IS NOT NULL), 0) FROM library_media m WHERE {filter}"),
        &args[..],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let limit = if [60, 120, 240].contains(&f.limit) { f.limit } else { 60 };
    let paged: [&dyn rusqlite::ToSql; 10] = [&query, &pattern, &f.channel, &f.kind, &f.transcribed, &f.starred, &f.review, &f.category, &f.status, &f.offset];
    let mut items = rows(
        &db,
        &format!(
            "{cte} SELECT m.*, {kind} AS kind, (SELECT count(*) FROM assignments a WHERE a.media_id = m.id) AS speaker_count
             FROM library_media m WHERE {filter} ORDER BY {},m.id LIMIT {limit} OFFSET ?10",
            order_by(&f.sort)
        ),
        &paged[..],
    )?;
    attach_speakers(&db, &mut items)?;
    Ok(json!({
        "items": items,
        "total": total,
        "transcribed": transcribed,
        "channels": rows(&db, "SELECT DISTINCT channel FROM media WHERE (?1='' OR category=?1) ORDER BY channel COLLATE NOCASE", [&f.category])?,
    }))
}

/// Named voices per recording, loudest first; the Library shows the top three.
fn attach_speakers(db: &Connection, items: &mut [Value]) -> Result<()> {
    let ids: Vec<&str> = items.iter().filter_map(|m| m["id"].as_str()).collect();
    let found = rows(
        db,
        "SELECT a.media_id, s.name, s.color, sum(a.airtime) AS airtime
         FROM assignments a JOIN speakers s ON s.id = a.speaker_id
         WHERE s.is_noise=0 AND a.media_id IN (SELECT value FROM json_each(?1))
         GROUP BY a.media_id, s.id ORDER BY a.media_id, airtime DESC",
        [serde_json::to_string(&ids)?],
    )?;
    let mut by_media: HashMap<String, Vec<Value>> = HashMap::new();
    for row in found {
        let id = row["media_id"].as_str().unwrap_or_default().to_owned();
        by_media
            .entry(id)
            .or_default()
            .push(json!({"name": row["name"], "color": row["color"], "airtime": row["airtime"]}));
    }
    for item in items {
        let list = by_media.remove(item["id"].as_str().unwrap_or_default()).unwrap_or_default();
        item["speaker_total"] = json!(list.len());
        item["speakers"] = json!(list.into_iter().take(3).collect::<Vec<_>>());
    }
    Ok(())
}

fn update_media(root: &Path, sql: &str, args: impl rusqlite::Params) -> Result<()> {
    let changed = open(root)?.execute(sql, args)?;
    anyhow::ensure!(changed == 1, "Recording not found");
    Ok(())
}

pub fn set_category(root: &Path, id: &str, category: &str) -> Result<()> {
    anyhow::ensure!(["personal", "work"].contains(&category), "Choose Personal or Work");
    update_media(root, "UPDATE media SET category=?1 WHERE id=?2", params![category,id])
}

pub fn set_starred(root: &Path, id: &str, starred: bool) -> Result<()> {
    update_media(root, "UPDATE media SET starred = ?1 WHERE id = ?2", params![starred, id])
}

pub fn set_review(root: &Path, id: &str, state: &str) -> Result<()> {
    anyhow::ensure!(REVIEW_STATES.contains(&state), "Unknown review state: {state}");
    update_media(root, "UPDATE media SET review_state = ?1 WHERE id = ?2", params![state, id])
}

pub fn save_position(root: &Path, id: &str, seconds: f64) -> Result<()> {
    anyhow::ensure!(seconds.is_finite(), "Invalid playback position");
    update_media(
        root,
        "UPDATE media SET position = max(0, ?1), opened_at = datetime('now') WHERE id = ?2",
        params![seconds, id],
    )
}

pub fn clear_jobs(root: &Path, id: Option<&str>) -> Result<usize> {
    Ok(open(root)?.execute("DELETE FROM jobs WHERE status IN ('complete','failed','interrupted','cancelled') AND (?1 IS NULL OR id=?1)", [id])?)
}

pub fn media(root: &Path, id: &str) -> Result<Value> {
    rows(
        &open(root)?,
        &format!("SELECT m.*, {} AS kind FROM media m WHERE m.id = ?1", kind_sql()),
        [id],
    )?
        .pop()
        .context("Recording not found")
}

pub fn transcript(root: &Path, id: &str) -> Result<Value> {
    let mut item = media(root, id)?;
    let db = open(root)?;
    let assignments=rows(&db,"SELECT a.local_id,a.speaker_id,a.airtime,a.start,a.end,s.name,s.color,s.is_noise FROM assignments a LEFT JOIN speakers s ON s.id=a.speaker_id WHERE media_id=?1 ORDER BY airtime DESC",[id])?;
    let mut segments = Vec::new();
    let mut model = String::new();
    if let Some(path) = item["transcript"].as_str() {
        let json_path = Path::new(path).with_extension("json");
        if json_path.is_file() {
            let raw: Value = serde_json::from_reader(std::fs::File::open(json_path)?)?;
            model = raw["model"].as_str().unwrap_or("").to_owned();
            segments = raw["segments"].as_array().cloned().unwrap_or_default();
            if item["duration"].as_f64().unwrap_or(0.) <= 0. {
                if let Some(duration) = raw["duration_seconds"].as_f64() {
                    item["duration"] = json!(duration);
                }
            }
        }
    }
    if segments.is_empty() {
        segments=rows(&db,"SELECT CAST(start AS REAL) AS start,CAST(end AS REAL) AS end,speaker,text FROM segments WHERE media_id=?1 ORDER BY CAST(start AS REAL)",[id])?;
    }
    let notes = rows(
        &db,
        "SELECT n.id,n.title,a.start,a.end FROM note_anchors a JOIN notes n ON n.id=a.note_id WHERE a.media_id=?1 AND a.start IS NOT NULL UNION ALL SELECT n.id,n.title,n.start,n.end FROM notes n WHERE n.media_id=?1 AND n.start IS NOT NULL AND NOT EXISTS(SELECT 1 FROM note_anchors a WHERE a.note_id=n.id) ORDER BY 3",
        [id],
    )?;
    Ok(json!({"media":item,"segments":segments,"assignments":assignments,"notes":notes,"model":model}))
}

pub fn search(root: &Path, query: &str) -> Result<Vec<Value>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    // Treat user input as words, never raw FTS operators or SQL.
    let fts = crate::search_index::query(query,false);
    rows(
        &open(root)?,
        "SELECT m.id, m.title, m.channel, m.date, segments.text AS text,
                highlight(segments_fts, 0, char(2), char(3)) AS marked,
                CAST(segments.start AS REAL) AS start, segments.speaker AS speaker,
                sp.name AS speaker_name, sp.color AS speaker_color
         FROM segments_fts JOIN segments ON segments.id=segments_fts.rowid
         JOIN media m ON m.id = segments.media_id
         LEFT JOIN assignments a ON a.media_id = segments.media_id AND a.local_id = segments.speaker
         LEFT JOIN speakers sp ON sp.id = a.speaker_id
         WHERE segments_fts MATCH ?1
         ORDER BY segments_fts.rank LIMIT 200",
        [fts],
    )
}

/// Quick-jump results for the command palette.
pub fn palette(root: &Path, query: &str) -> Result<Value> {
    let db = open(root)?;
    let q = query.trim();
    if q.is_empty() {
        let recent = rows(&db, "SELECT id,title,channel,date FROM media WHERE opened_at IS NOT NULL ORDER BY opened_at DESC LIMIT 6", [])?;
        return Ok(json!({"recordings": recent, "speakers": [], "notes": [], "documents": []}));
    }
    let p = like_pattern(q);
    Ok(json!({
        "recordings": rows(&db, "SELECT id,title,channel,date FROM media WHERE title LIKE ?1 ESCAPE '\\' OR channel LIKE ?1 ESCAPE '\\' ORDER BY opened_at IS NULL, opened_at DESC, date DESC LIMIT 6", [&p])?,
        "speakers": rows(&db, "SELECT id,name,color FROM speakers WHERE is_noise=0 AND name LIKE ?1 ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT 6", [&p])?,
        "notes": rows(&db, "SELECT id,title,media_id,start FROM notes WHERE title LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\' OR quote LIKE ?1 ESCAPE '\\' ORDER BY created_at DESC LIMIT 6", [&p])?,
        "documents": rows(&db, "SELECT id,title FROM docs WHERE title LIKE ?1 ESCAPE '\\' ORDER BY title COLLATE NOCASE LIMIT 6", [&p])?,
    }))
}

pub fn speakers(root: &Path) -> Result<Vec<Value>> {
    rows(&open(root)?,"SELECT s.id,s.name,s.color,s.notes,s.is_noise,s.sample_count,count(DISTINCT a.media_id) AS recordings,coalesce(sum(a.airtime),0) AS airtime FROM speakers s LEFT JOIN assignments a ON a.speaker_id=s.id GROUP BY s.id ORDER BY s.is_noise, airtime DESC, s.name COLLATE NOCASE",[])
}

/// Every recording a saved voice appears in, loudest first, with the start of its longest turn.
pub fn speaker_appearances(root: &Path, speaker_id: &str) -> Result<Vec<Value>> {
    rows(
        &open(root)?,
        "SELECT a.media_id, a.local_id, a.airtime, a.start, a.end, m.title, m.channel, m.date, m.duration
         FROM assignments a JOIN media m ON m.id = a.media_id
         WHERE a.speaker_id = ?1
         ORDER BY a.airtime DESC, m.date DESC",
        [speaker_id],
    )
}

pub fn set_speaker_notes(root: &Path, id: &str, notes: &str) -> Result<()> {
    let notes = notes.trim();
    let changed = open(root)?.execute(
        "UPDATE speakers SET notes = ?1 WHERE id = ?2",
        params![(!notes.is_empty()).then_some(notes), id],
    )?;
    anyhow::ensure!(changed == 1, "Speaker not found");
    Ok(())
}

pub fn assign(root: &Path, media_id: &str, local_id: &str, name: &str) -> Result<()> {
    crate::speakers::label(root, &crate::speakers::Label {
        media_id: media_id.into(), locals: vec![local_id.into()], name: Some(name.into()),
        speaker_id: None, color: None, noise: false, unlink: false,
    })?;
    Ok(())
}

#[cfg(test)]
pub fn import_files(root: &Path, paths: &[String]) -> Result<usize> { import_files_in_category(root,paths,"personal") }
pub fn import_files_in_category(root: &Path, paths: &[String], category: &str) -> Result<usize> {
    anyhow::ensure!(["personal", "work"].contains(&category), "Choose Personal or Work");
    let mut db = open(root)?;
    let tx = db.transaction()?;
    let mut count = 0;
    for path in paths {
        let path = Path::new(path).canonicalize()?;
        if !path.is_file() {
            bail!("Choose a media file");
        }
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if ![
            "mp4", "mkv", "webm", "mov", "ogg", "wav", "mp3", "m4a", "flac", "aac", "opus",
        ]
        .contains(&extension.as_str())
        {
            bail!("Unsupported media type: {extension}");
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM media WHERE path=?1)",
            [path.to_string_lossy().as_ref()],
            |r| r.get(0),
        )?;
        if exists {
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let title = path.file_stem().unwrap_or_default().to_string_lossy();
        tx.execute(
            "INSERT INTO media(id,title,path,date,category) VALUES (?1,?2,?3,date('now'),?4)",
            params![id, title, path.to_string_lossy(),category],
        )?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn legacy_fixture(path: &Path) {
        let db = Connection::open(path).unwrap();
        db.execute_batch("CREATE TABLE channels(id TEXT,name TEXT);
          CREATE TABLE video_queue(video_id TEXT,channel_id TEXT,title TEXT,url TEXT,upload_date TEXT,duration REAL,video_path TEXT,md_path TEXT,word_count INTEGER);
          CREATE TABLE speakers(id TEXT,name TEXT,display_color TEXT,notes TEXT);
          CREATE TABLE speaker_embeddings(speaker_id TEXT,embedding BLOB);
          CREATE TABLE video_speaker_assignments(channel_id TEXT,video_id TEXT,local_speaker TEXT,speaker_id TEXT,centroid BLOB,airtime_seconds REAL,sample_start REAL,sample_end REAL,confidence REAL);
          CREATE VIRTUAL TABLE transcript_segments_fts USING fts5(video_id UNINDEXED,channel_id UNINDEXED,start_seconds UNINDEXED,end_seconds UNINDEXED,speaker UNINDEXED,text);
          CREATE TABLE transcript_clips(id TEXT,title TEXT,note TEXT,quote TEXT,channel_id TEXT,video_id TEXT,start_seconds REAL,end_seconds REAL,created_at TEXT);
          CREATE TABLE clip_links(from_clip_id TEXT,to_clip_id TEXT,kind TEXT);
          CREATE TABLE documents(id TEXT,title TEXT);
          CREATE TABLE docs_fts(document_id TEXT,chunk_index INTEGER,text TEXT);
          INSERT INTO channels VALUES ('c','Meetings');
          INSERT INTO video_queue VALUES ('v','c','Meeting','local','20251022',100,NULL,NULL,2);
          INSERT INTO speakers VALUES ('speaker','Sarah',NULL,NULL);
          INSERT INTO speaker_embeddings VALUES ('speaker',x'0000803F');
          INSERT INTO video_speaker_assignments VALUES ('c','v','S10','speaker',x'0000803F',10,0,10,1);
          INSERT INTO transcript_segments_fts VALUES ('v','c',0,2,'S10','hello world');
          INSERT INTO documents VALUES ('d','Document');
          INSERT INTO docs_fts VALUES ('d',1,'second'),('d',0,'first');
          INSERT INTO transcript_clips VALUES ('n','A note','Thinking','hello','c','v',0,2,'today');").unwrap();
    }
    #[test]
    fn clearing_finished_activity_preserves_running_jobs_and_media() {
        let root = tempfile::tempdir().unwrap();
        let db = open(root.path()).unwrap();
        db.execute_batch("INSERT INTO media(id,title) VALUES ('m','Meeting'),('m2','Second meeting');
          INSERT INTO jobs(id,media_id,title,status) VALUES ('done','m','Meeting','complete'),('fail','m','Meeting','failed'),('run','m','Meeting','running'),('queue','m2','Second meeting','queued');").unwrap();
        assert_eq!(clear_jobs(root.path(),Some("run")).unwrap(),0);
        assert_eq!(clear_jobs(root.path(),None).unwrap(),2);
        assert_eq!(db.query_row("SELECT count(*) FROM jobs",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(db.query_row("SELECT count(*) FROM media",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    }
    #[test]
    fn migration_is_isolated_and_searchable() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("old.db");
        legacy_fixture(&source);
        let original = std::fs::read(&source).unwrap();
        let root = tmp.path().join("next");
        let counts = import_legacy(&root, &source).unwrap();
        assert_eq!(counts["media"], 1);
        assert_eq!(counts["speakers"], 1);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(import_legacy(&root, &source).is_err());
        let hits = search(&root, "hello").unwrap();
        assert_eq!(hits[0]["title"], "Meeting");
        assert_eq!(
            transcript(&root, hits[0]["id"].as_str().unwrap()).unwrap()["assignments"][0]
                ["local_id"],
            "S10"
        );
        assert!(search(&root, "\" OR *").unwrap().is_empty());
        assert_eq!(
            rows(&open(&root).unwrap(), "SELECT body FROM docs", []).unwrap()[0]["body"],
            "first\n\nsecond"
        );
        assert_eq!(
            open(&root)
                .unwrap()
                .query_row("SELECT count(*) FROM jobs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn media_import_rejects_non_media_and_deduplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        let file = tmp.path().join("audio.ogg");
        std::fs::write(&file, b"test").unwrap();
        let paths = [file.to_string_lossy().into_owned()];
        assert_eq!(import_files(&root, &paths).unwrap(), 1);
        assert_eq!(import_files(&root, &paths).unwrap(), 0);
        let bad = tmp.path().join("secret.txt");
        std::fs::write(&bad, b"not media").unwrap();
        assert!(import_files(&root, &[bad.to_string_lossy().into_owned()]).is_err());
        assert_eq!(stats(&root).unwrap()["media"], 1);
    }

    #[test]
    fn migration_adds_library_state_to_existing_v1_database() {
        let tmp = tempfile::tempdir().unwrap();
        let v1 = Connection::open(tmp.path().join("library.db")).unwrap();
        v1.execute_batch(
            "CREATE TABLE media (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
               channel TEXT NOT NULL DEFAULT 'Imports', date TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,
               path TEXT, transcript TEXT, words INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ready');
             INSERT INTO media(id,title) VALUES ('a','Old');
             PRAGMA user_version=1;",
        )
        .unwrap();
        drop(v1);
        let db = open(tmp.path()).unwrap();
        let row = &rows(&db, "SELECT starred, review_state, position, opened_at FROM media WHERE id='a'", []).unwrap()[0];
        assert_eq!(row["starred"], 0);
        assert_eq!(row["review_state"], "unreviewed");
        assert_eq!(row["position"], 0.0);
        assert!(row["opened_at"].is_null());
        assert_eq!(db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 10);
        drop(db);
        open(tmp.path()).unwrap(); // reopening is a no-op, not a duplicate-column error
    }
    #[test]
    fn palette_groups_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        open(&root)
            .unwrap()
            .execute_batch(
                "INSERT INTO media(id,title,channel) VALUES ('a','Alpha meeting','Meetings');
                 INSERT INTO speakers(id,name) VALUES ('s','Sarah');
                 INSERT INTO notes(id,title,body) VALUES ('n','Alpha thoughts','');
                 INSERT INTO docs(id,title,body) VALUES ('d','Alpha paper','x');",
            )
            .unwrap();
        let r = palette(&root, "alpha").unwrap();
        assert_eq!(r["recordings"][0]["id"], "a");
        assert_eq!(r["notes"][0]["id"], "n");
        assert_eq!(r["documents"][0]["id"], "d");
        assert_eq!(palette(&root, "sar").unwrap()["speakers"][0]["name"], "Sarah");
        assert!(palette(&root, "  ").unwrap()["recordings"].as_array().unwrap().is_empty());
        open(&root).unwrap().execute("UPDATE media SET opened_at=datetime('now')", []).unwrap();
        assert_eq!(palette(&root, "").unwrap()["recordings"][0]["id"], "a");
    }

    fn library_fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        open(&root)
            .unwrap()
            .execute_batch(
                "INSERT INTO media(id,title,channel,date,duration,path,transcript,words) VALUES
                   ('a','Alpha meeting','Meetings','20251007',8100,'/m/alpha.ogg','/t/alpha.md',9000),
                   ('b','Beta interview','Interviews','20250102',1200,'/m/beta.mp4',NULL,0),
                   ('c','Gamma talk','Meetings','20240505',600,'/m/gamma.webm','/t/gamma.md',500);
                 INSERT INTO speakers(id,name,color) VALUES ('s1','Sarah','#ff0000'),('s2','Tom',NULL);
                 INSERT INTO assignments(media_id,local_id,speaker_id,airtime) VALUES
                   ('a','S0','s1',300),('a','S1','s2',900),('a','S2',NULL,50),('a','S3','s1',100);
                 INSERT INTO notes(id,title,media_id,start,end) VALUES ('n1','Key moment','a',10,20),('n2','No time','a',NULL,NULL);",
            )
            .unwrap();
        (tmp, root)
    }

    fn ids(v: &Value) -> Vec<String> {
        v["items"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_owned()).collect()
    }

    #[test]
    fn library_filters_sorts_and_summarises_speakers() {
        let (_tmp, root) = library_fixture();
        let all = library(&root, &LibraryFilter::default()).unwrap();
        assert_eq!(all["total"], 3);
        assert_eq!(all["transcribed"], 2);
        assert_eq!(ids(&all), ["a", "b", "c"]);
        let alpha = &all["items"][0];
        assert_eq!(alpha["kind"], "audio");
        assert_eq!(all["items"][1]["kind"], "video");
        assert_eq!(alpha["speaker_count"], 4);
        assert_eq!(alpha["speaker_total"], 2);
        assert_eq!(alpha["speakers"][0]["name"], "Tom");
        assert_eq!(alpha["speakers"][1]["name"], "Sarah");
        assert_eq!(alpha["speakers"][1]["airtime"], 400.0);
        assert_eq!(alpha["speakers"][1]["color"], "#ff0000");
        let only = |edit: fn(&mut LibraryFilter)| {
            let mut filter = LibraryFilter::default();
            edit(&mut filter);
            ids(&library(&root, &filter).unwrap())
        };
        assert_eq!(only(|f| f.kind = "video".into()), ["b", "c"]);
        assert_eq!(only(|f| f.kind = "audio".into()), ["a"]);
        assert_eq!(only(|f| f.transcribed = "no".into()), ["b"]);
        assert_eq!(only(|f| f.channel = "Meetings".into()), ["a", "c"]);
        assert_eq!(only(|f| f.query = "interv".into()), ["b"]);
        assert_eq!(only(|f| f.query = "meetings".into()), ["a", "c"]);
        assert_eq!(only(|f| f.query = "gamma.webm".into()), ["c"]);
        assert_eq!(only(|f| f.query = "%".into()), Vec::<String>::new());
        assert_eq!(only(|f| f.sort = "oldest".into()), ["c", "b", "a"]);
        assert_eq!(only(|f| f.sort = "longest".into()), ["a", "b", "c"]);
        assert_eq!(only(|f| f.sort = "words".into()), ["a", "c", "b"]);
        assert_eq!(only(|f| f.sort = "title".into()), ["a", "b", "c"]);
        assert_eq!(only(|f| f.sort = "anything-else".into()), ["a", "b", "c"]);
        let mut paged = LibraryFilter { limit: 60, offset: 2, ..Default::default() };
        assert_eq!(ids(&library(&root, &paged).unwrap()), ["c"]);
        paged.limit = 7; // not an allowed page size, falls back to 60
        assert_eq!(ids(&library(&root, &paged).unwrap()), ["c"]);
    }

    #[test]
    fn library_categories_and_latest_processing_state_keep_existing_transcripts() {
        let (_tmp,root)=library_fixture();
        set_category(&root,"b","work").unwrap();
        assert!(set_category(&root,"b","unknown").is_err());
        assert!(set_category(&root,"missing","personal").is_err());
        let db=open(&root).unwrap();
        db.execute_batch("UPDATE media SET date='2025-10-08' WHERE id='b';
          INSERT INTO jobs(id,media_id,title,status) VALUES ('old','a','Old failure','failed'),('new','a','New success','complete');
          INSERT INTO jobs(id,media_id,title,status) VALUES ('latest','c','Failed replacement','failed');").unwrap();
        let all=library(&root,&LibraryFilter::default()).unwrap();
        assert_eq!(ids(&all),["b","a","c"]); // ISO and compact dates sort together.
        let filtered=|category:&str,status:&str| library(&root,&LibraryFilter{category:category.into(),status:status.into(),..Default::default()}).unwrap();
        assert_eq!(ids(&filtered("personal","complete")),["a"]);
        assert_eq!(ids(&filtered("personal","failed")),["c"]);
        assert_eq!(filtered("personal","failed")["transcribed"],1);
        assert_eq!(ids(&filtered("work","ready")),["b"]);
        assert_eq!(filtered("work","")["channels"],json!([{"channel":"Interviews"}]));
        for (state,status) in [("queued","pending"),("running","processing"),("retry","pending"),("waiting_live","live"),("cancelled","cancelled")] {
            db.execute("UPDATE jobs SET status=?1 WHERE id='latest'",[state]).unwrap();
            assert_eq!(ids(&filtered("personal",status)),["c"]);
        }
        assert_eq!(media(&root,"c").unwrap()["transcript"],"/t/gamma.md");
        let path=root.join("work.ogg");std::fs::write(&path,b"fixture").unwrap();
        let paths=vec![path.to_string_lossy().into_owned()];
        assert_eq!(import_files_in_category(&root,&paths,"work").unwrap(),1);
        assert_eq!(import_files_in_category(&root,&paths,"personal").unwrap(),0);
        assert_eq!(filtered("work","")["total"],2);
    }

    #[test]
    fn star_review_and_position_update_one_recording() {
        let (_tmp, root) = library_fixture();
        set_starred(&root, "c", true).unwrap();
        set_review(&root, "b", "reviewed").unwrap();
        save_position(&root, "b", 42.5).unwrap();
        save_position(&root, "a", -3.0).unwrap();
        let filtered = |f: LibraryFilter| ids(&library(&root, &f).unwrap());
        assert_eq!(filtered(LibraryFilter { starred: true, ..Default::default() }), ["c"]);
        assert_eq!(filtered(LibraryFilter { review: "reviewed".into(), ..Default::default() }), ["b"]);
        assert_eq!(filtered(LibraryFilter { sort: "opened".into(), ..Default::default() })[2], "c");
        assert_eq!(media(&root, "b").unwrap()["position"], 42.5);
        assert_eq!(media(&root, "a").unwrap()["position"], 0.0);
        assert!(set_review(&root, "b", "archived").is_err());
        assert!(set_starred(&root, "missing", true).is_err());
        assert!(save_position(&root, "b", f64::NAN).is_err());
    }

    #[test]
    fn recording_includes_kind_and_timed_notes() {
        let (_tmp, root) = library_fixture();
        let rec = transcript(&root, "a").unwrap();
        assert_eq!(rec["media"]["kind"], "audio");
        let notes = rec["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["title"], "Key moment");
        assert_eq!(notes[0]["start"], 10.0);
    }

    #[test]
    fn search_marks_matches_and_names_speakers() {
        let (_tmp, root) = library_fixture();
        open(&root)
            .unwrap()
            .execute_batch(
                "INSERT INTO segments(media_id,start,end,speaker,text) VALUES
                   ('a',12.5,15,'S0','We met at the harbour'),('c',3,4,'S9','harbour lights');",
            )
            .unwrap();
        let hits = search(&root, "harbour").unwrap();
        let alpha = hits.iter().find(|h| h["id"] == "a").unwrap();
        assert_eq!(alpha["marked"], "We met at the \u{2}harbour\u{3}");
        assert_eq!(alpha["text"], "We met at the harbour");
        assert_eq!(alpha["speaker_name"], "Sarah");
        assert_eq!(alpha["speaker_color"], "#ff0000");
        assert_eq!(alpha["date"], "20251007");
        assert_eq!(alpha["start"], 12.5);
        let gamma = hits.iter().find(|h| h["id"] == "c").unwrap();
        assert!(gamma["speaker_name"].is_null());
        assert!(search(&root, "\" OR *").unwrap().is_empty());
    }

    #[test]
    fn speakers_are_listed_by_speaking_time() {
        let (_tmp, root) = library_fixture();
        let list = speakers(&root).unwrap();
        assert_eq!(list[0]["name"], "Tom");
        assert_eq!(list[1]["name"], "Sarah");
        assert_eq!(list[1]["airtime"], 400.0);
        assert_eq!(list[1]["recordings"], 1);
    }

    #[test]
    fn speaker_appearances_list_where_a_voice_spoke() {
        let (_tmp, root) = library_fixture();
        open(&root)
            .unwrap()
            .execute_batch("UPDATE assignments SET start = 42.5 WHERE media_id='a' AND local_id='S0'; INSERT INTO assignments(media_id,local_id,speaker_id,airtime,start) VALUES ('c','S2','s1',60,7);")
            .unwrap();
        let list = speaker_appearances(&root, "s1").unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0]["media_id"], "a");
        assert_eq!(list[0]["local_id"], "S0");
        assert_eq!(list[0]["airtime"], 300.0);
        assert_eq!(list[0]["start"], 42.5);
        assert_eq!(list[0]["title"], "Alpha meeting");
        assert_eq!(list[0]["channel"], "Meetings");
        assert_eq!(list[0]["date"], "20251007");
        assert_eq!(list[1]["local_id"], "S3");
        assert_eq!(list[2]["media_id"], "c");
        assert!(speaker_appearances(&root, "nobody").unwrap().is_empty());
    }

    #[test]
    fn speaker_notes_save_and_clear() {
        let (_tmp, root) = library_fixture();
        set_speaker_notes(&root, "s1", "  Leads the Tuesday study.  ").unwrap();
        assert_eq!(speakers(&root).unwrap().iter().find(|s| s["id"] == "s1").unwrap()["notes"], "Leads the Tuesday study.");
        set_speaker_notes(&root, "s1", "   ").unwrap();
        assert!(speakers(&root).unwrap().iter().find(|s| s["id"] == "s1").unwrap()["notes"].is_null());
        assert!(set_speaker_notes(&root, "missing", "x").is_err());
    }
}
