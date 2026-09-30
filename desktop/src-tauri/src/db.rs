use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
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
    let db = Connection::open(root.join("library.db"))?;
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
        status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (datetime('now')));
      PRAGMA user_version=1;")?;
    Ok(db)
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
      INSERT INTO notes(id,title,body,quote,media_id,start,end,created_at)
        SELECT n.id,n.title,coalesce(n.note,''),coalesce(n.quote,''),m.id,n.start_seconds,n.end_seconds,n.created_at
        FROM previous.transcript_clips n LEFT JOIN media m ON m.id=json_array(n.channel_id,n.video_id);
      INSERT OR IGNORE INTO links SELECT from_clip_id,to_clip_id,kind FROM previous.clip_links
        WHERE from_clip_id IN (SELECT id FROM notes) AND to_clip_id IN (SELECT id FROM notes);
      INSERT INTO docs(id,title,body)
        SELECT d.id,d.title,coalesce((SELECT group_concat(text,char(10)||char(10)) FROM
          (SELECT text FROM previous.docs_fts f WHERE f.document_id=d.id ORDER BY CAST(chunk_index AS INTEGER))), '')
        FROM previous.documents d;")?;
    tx.execute(
        "INSERT INTO settings VALUES ('imported_from',?1)",
        [source.to_string_lossy().as_ref()],
    )?;
    tx.commit()?;
    stats(root)
}

pub fn library(root: &Path, query: &str, channel: &str, offset: u32) -> Result<Value> {
    let db = open(root)?;
    let filter = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let total: i64 = db.query_row(
        "SELECT count(*) FROM media WHERE title LIKE ?1 ESCAPE '\\' AND (?2='' OR channel=?2)",
        params![filter, channel],
        |r| r.get(0),
    )?;
    let items=rows(&db,"SELECT m.*,(SELECT count(*) FROM assignments a WHERE a.media_id=m.id) AS speaker_count,
      (SELECT group_concat(DISTINCT s.name) FROM assignments a JOIN speakers s ON s.id=a.speaker_id WHERE a.media_id=m.id) AS speaker_names
      FROM media m WHERE title LIKE ?1 ESCAPE '\\' AND (?2='' OR channel=?2) ORDER BY date DESC,title LIMIT 60 OFFSET ?3",params![filter,channel,offset])?;
    Ok(
        json!({"items":items,"total":total,"channels":rows(&db,"SELECT DISTINCT channel FROM media ORDER BY channel",[]) ?}),
    )
}

pub fn media(root: &Path, id: &str) -> Result<Value> {
    rows(&open(root)?, "SELECT * FROM media WHERE id=?1", [id])?
        .pop()
        .context("Recording not found")
}

pub fn transcript(root: &Path, id: &str) -> Result<Value> {
    let mut item = media(root, id)?;
    let db = open(root)?;
    let assignments=rows(&db,"SELECT a.local_id,a.speaker_id,a.airtime,s.name,s.color FROM assignments a LEFT JOIN speakers s ON s.id=a.speaker_id WHERE media_id=?1 ORDER BY airtime DESC",[id])?;
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
    Ok(json!({"media":item,"segments":segments,"assignments":assignments,"model":model}))
}

pub fn search(root: &Path, query: &str) -> Result<Vec<Value>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    // Treat user input as words, never raw FTS operators or SQL.
    let fts = query
        .split_whitespace()
        .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");
    rows(&open(root)?,"SELECT m.id,m.title,m.channel,s.text,CAST(s.start AS REAL) AS start,s.speaker FROM segments s JOIN media m ON m.id=s.media_id WHERE segments MATCH ?1 ORDER BY rank LIMIT 100",[fts])
}

pub fn speakers(root: &Path) -> Result<Vec<Value>> {
    rows(&open(root)?,"SELECT s.id,s.name,s.color,s.notes,count(DISTINCT a.media_id) AS recordings,coalesce(sum(a.airtime),0) AS airtime FROM speakers s LEFT JOIN assignments a ON a.speaker_id=s.id GROUP BY s.id ORDER BY s.name COLLATE NOCASE",[])
}

pub fn assign(root: &Path, media_id: &str, local_id: &str, name: &str) -> Result<()> {
    if name.trim().is_empty() {
        bail!("Enter a speaker name");
    }
    let mut db = open(root)?;
    let tx = db.transaction()?;
    let id: Option<String> = tx
        .query_row(
            "SELECT id FROM speakers WHERE name=?1 COLLATE NOCASE",
            [name.trim()],
            |r| r.get(0),
        )
        .ok();
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let embedding: Option<Vec<u8>> = tx
        .query_row(
            "SELECT centroid FROM assignments WHERE media_id=?1 AND local_id=?2",
            params![media_id, local_id],
            |r| r.get(0),
        )
        .context("Speaker turn not found")?;
    tx.execute("INSERT INTO speakers(id,name,embedding) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET embedding=coalesce(speakers.embedding,excluded.embedding)",params![id,name.trim(),embedding])?;
    tx.execute(
        "UPDATE assignments SET speaker_id=?1 WHERE media_id=?2 AND local_id=?3",
        params![id, media_id, local_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn import_files(root: &Path, paths: &[String]) -> Result<usize> {
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
            "INSERT INTO media(id,title,path,date) VALUES (?1,?2,?3,date('now'))",
            params![id, title, path.to_string_lossy()],
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
}
