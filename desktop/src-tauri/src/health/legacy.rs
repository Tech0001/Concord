//! Fill fields the early preview importer omitted. Never change existing notes,
//! speaker labels, transcripts, providers, or read/write the Electron library.
use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::path::Path;
fn has(db: &Connection, table: &str, column: &str) -> bool {
    db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"),
        [column],
        |r| r.get(0),
    )
    .unwrap_or(false)
}
pub fn seed(root: &Path) -> Result<()> {
    let mut target = db::open(root)?;
    let done: bool = target.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key='health.legacyMetadataImported')",
        [],
        |r| r.get(0),
    )?;
    if done {
        return Ok(());
    }
    let source: Option<String> = target
        .query_row(
            "SELECT value FROM settings WHERE key='imported_from'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(source) = source else {
        return Ok(());
    };
    if !Path::new(&source).is_file() {
        return Ok(());
    }
    let old = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if !has(&old, "video_queue", "category") || !has(&old, "channels", "diarize") {
        return Ok(());
    }
    let tx = target.transaction()?;
    for c in db::rows(
        &old,
        "SELECT id,name,url,enabled,diarize,include_shorts,category FROM channels",
        [],
    )? {
        tx.execute("INSERT OR IGNORE INTO channels(id,name,url,enabled,diarize,include_shorts,category) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![c["id"].as_str(),c["name"].as_str(),c["url"].as_str().unwrap_or(""),c["enabled"].as_i64().unwrap_or(1),c["diarize"].as_i64().unwrap_or(1),c["include_shorts"].as_i64().unwrap_or(0),c["category"].as_str().unwrap_or("personal")])?;
    }
    for m in db::rows(
        &old,
        "SELECT channel_id,video_id,category,md_path,ai_summary,ai_summary_model,status FROM video_queue",
        [],
    )? {
        let id = serde_json::to_string(&[
            m["channel_id"].as_str().unwrap_or(""),
            m["video_id"].as_str().unwrap_or(""),
        ])?;
        tx.execute(
            "UPDATE media SET source_id=?2,category=?3 WHERE id=?1 AND source_id IS NULL",
            params![
                id,
                m["channel_id"].as_str(),
                m["category"].as_str().unwrap_or("personal")
            ],
        )?;
        if m["status"]=="complete" && m["md_path"].is_null() {
            tx.execute("UPDATE media SET status='complete' WHERE id=?1 AND status='ready' AND transcript IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE media_id=?1)",[&id])?;
        }
        if let Some(summary) = m["ai_summary"].as_str().filter(|s| !s.trim().is_empty()) {
            tx.execute("INSERT OR IGNORE INTO ai_summaries(media_id,content,model,digest) SELECT id,?2,?3,'legacy-import' FROM media WHERE id=?1 AND transcript=?4",params![id,summary,m["ai_summary_model"].as_str().unwrap_or("Imported summary"),m["md_path"].as_str()])?;
        }
    }
    if has(&old, "transcript_index", "md_mtime_ms") {
        for index in db::rows(
            &old,
            "SELECT channel_id,video_id,md_path,md_mtime_ms FROM transcript_index",
            [],
        )? {
            let id = serde_json::to_string(&[
                index["channel_id"].as_str().unwrap_or(""),
                index["video_id"].as_str().unwrap_or(""),
            ])?;
            let Some(path) = index["md_path"].as_str() else {
                continue;
            };
            let current: Option<String> = tx
                .query_row("SELECT transcript FROM media WHERE id=?1", [&id], |r| {
                    r.get(0)
                })
                .optional()?
                .flatten();
            if current.as_deref() != Some(path) {
                continue;
            }
            if let Ok((bytes, mtime)) = super::stamp(Path::new(path)) {
                let old_mtime = index["md_mtime_ms"].as_f64().unwrap_or(0.) as u64;
                if old_mtime.abs_diff(mtime) <= 1 {
                    tx.execute(
                        "INSERT OR IGNORE INTO archive_transcripts VALUES (?1,?2,?3,?4)",
                        params![id, path, bytes, mtime],
                    )?;
                }
            }
        }
    }
    if has(&old, "documents", "root_id") {
        let config: Option<String> = old
            .query_row(
                "SELECT value FROM app_config WHERE key='docs.rootFolders'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let roots: Value = config
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        for r in roots.as_array().into_iter().flatten() {
            if let (Some(id), Some(path)) = (r["id"].as_str(), r["path"].as_str()) {
                tx.execute(
                    "INSERT OR IGNORE INTO document_roots(id,path) VALUES (?1,?2)",
                    params![id, path],
                )?;
            }
        }
        for d in db::rows(
            &old,
            "SELECT id,root_id,rel_path,starred,category FROM documents",
            [],
        )? {
            let root_path: Option<String> = tx
                .query_row(
                    "SELECT path FROM document_roots WHERE id=?1",
                    [d["root_id"].as_str()],
                    |r| r.get(0),
                )
                .optional()?;
            let path = root_path.map(|p| {
                Path::new(&p)
                    .join(d["rel_path"].as_str().unwrap_or(""))
                    .to_string_lossy()
                    .into_owned()
            });
            tx.execute("UPDATE docs SET path=coalesce(path,?2),root_id=coalesce(root_id,?3),starred=?4,category=?5 WHERE id=?1",params![d["id"].as_str(),path,d["root_id"].as_str(),d["starred"].as_i64().unwrap_or(0),d["category"].as_str().unwrap_or("personal")])?;
        }
    }
    tx.execute(
        "INSERT INTO settings VALUES ('health.legacyMetadataImported','1')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}
