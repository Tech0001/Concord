//! Local archive status, integrity checks and explicitly requested repairs.
pub mod backup;
pub mod legacy;
pub mod repair;
pub mod report;
use anyhow::Result;
use rusqlite::{params, Connection};
use std::{path::Path, sync::atomic::AtomicBool};
#[derive(Default)]
pub struct Control {
    pub busy: AtomicBool,
    pub cancel: AtomicBool,
}
pub fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS archive_transcripts(media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,path TEXT NOT NULL,bytes INTEGER NOT NULL,mtime INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media_fingerprints(media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,path TEXT NOT NULL,bytes INTEGER NOT NULL,mtime INTEGER NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_jobs(id TEXT PRIMARY KEY,action TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',done INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,details TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,diarize INTEGER NOT NULL DEFAULT 1,include_shorts INTEGER NOT NULL DEFAULT 0,category TEXT NOT NULL DEFAULT 'personal');
      CREATE TABLE IF NOT EXISTS document_roots(id TEXT PRIMARY KEY,path TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);")?;
    for (table, name, ddl) in [
        ("ai_jobs", "scope", "TEXT NOT NULL DEFAULT ''"),
        ("media", "source_id", "TEXT"),
        ("media", "category", "TEXT NOT NULL DEFAULT 'personal'"),
        ("docs", "path", "TEXT"),
        ("docs", "root_id", "TEXT"),
        ("docs", "starred", "INTEGER NOT NULL DEFAULT 0"),
        ("docs", "category", "TEXT NOT NULL DEFAULT 'personal'"),
    ] {
        let exists: bool = db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"),
            [name],
            |r| r.get(0),
        )?;
        if !exists {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {ddl}"))?;
        }
    }
    Ok(())
}
pub fn jobs(db: &Connection) -> Result<Vec<serde_json::Value>> {
    let mut jobs = crate::db::rows(
        db,
        "SELECT * FROM maintenance_jobs ORDER BY created_at DESC,rowid DESC LIMIT 40",
        [],
    )?;
    jobs.extend(crate::ai::summary::jobs(db)?);
    Ok(jobs)
}
pub fn stamp(path: &Path) -> Result<(u64, u64)> {
    let m = path.metadata()?;
    anyhow::ensure!(m.is_file(), "Expected a file");
    Ok((
        m.len(),
        m.modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64,
    ))
}
pub fn indexed(db: &Connection, id: &str, path: &Path) -> Result<()> {
    let (bytes, mtime) = stamp(path)?;
    db.execute("INSERT INTO archive_transcripts VALUES (?1,?2,?3,?4) ON CONFLICT(media_id) DO UPDATE SET path=excluded.path,bytes=excluded.bytes,mtime=excluded.mtime",params![id,path.to_string_lossy(),bytes,mtime])?;
    Ok(())
}
pub fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}
#[cfg(test)]
mod tests;
