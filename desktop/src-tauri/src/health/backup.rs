use crate::{ai::config::private_write, db, runtime_log};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
const CONFIG_FILES: [&str; 3] = ["ai-providers.json", "chatgpt-auth.json", "youtube-api.json"];
fn readonly(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?)
}
fn copy_database(source: &Connection, path: &Path) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    drop(file);
    let mut dest = Connection::open(path)?;
    rusqlite::backup::Backup::new(source, &mut dest)?.run_to_completion(
        256,
        Duration::from_millis(5),
        None,
    )?;
    Ok(())
}
pub fn create(root: &Path, folder: &Path) -> Result<Value> {
    std::fs::create_dir_all(folder)?;
    let name = format!(
        "concord-next-{}-{}.sqlite",
        super::now(),
        uuid::Uuid::new_v4().simple()
    );
    let path = folder.join(name);
    let tmp = path.with_extension("partial");
    let result = (|| -> Result<Value> {
        let source = db::open(root)?;
        copy_database(&source, &tmp)?;
        let backup = Connection::open(&tmp)?;
        backup.execute_batch("DROP TABLE IF EXISTS concord_backup_files;CREATE TABLE concord_backup_files(name TEXT PRIMARY KEY,content BLOB);")?;
        for name in CONFIG_FILES {
            let bytes = match std::fs::read(root.join(name)) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            };
            backup.execute(
                "INSERT INTO concord_backup_files VALUES (?1,?2)",
                params![name, bytes],
            )?;
        }
        backup.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE;")?;
        drop(backup);
        validate(&tmp)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, &path)?;
        runtime_log::push("info", "Archive database backup created");
        Ok(json!({"path":path,"bytes":path.metadata()?.len()}))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}
pub fn validate(path: &Path) -> Result<Value> {
    ensure!(path.is_file(), "Backup file does not exist");
    let db = readonly(path).context("Cannot open SQLite backup")?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!((1..=12).contains(&version),"Unsupported Concord Next backup version {version}. Electron libraries must be imported, not restored.");
    let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    ensure!(
        integrity == "ok",
        "Backup integrity check failed: {integrity}"
    );
    let required:i64=db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('media','notes','docs','settings','segments')",[],|r|r.get(0))?;
    ensure!(required == 5, "This is not a Concord Next backup");
    let foreign_errors: i64 =
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    ensure!(
        foreign_errors == 0,
        "Backup contains {foreign_errors} broken database references"
    );
    let has_files: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='concord_backup_files')",
        [],
        |r| r.get(0),
    )?;
    if has_files {
        for name in CONFIG_FILES {
            let data: Option<Vec<u8>> = db.query_row(
                "SELECT content FROM concord_backup_files WHERE name=?1",
                [name],
                |r| r.get(0),
            ).optional()?.flatten();
            if let Some(bytes) = data {
                ensure!(
                    bytes.len() < 1024 * 1024,
                    "Backup configuration is too large"
                );
                let _: Value =
                    serde_json::from_slice(&bytes).context("Invalid configuration in backup")?;
            }
        }
    }
    let count = |table: &str| -> Result<i64> {
        Ok(db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
    };
    Ok(
        json!({"path":path,"bytes":path.metadata()?.len(),"recordings":count("media")?,"notes":count("notes")?,"documents":count("docs")?,"version":version,"includesConfiguration":has_files}),
    )
}
pub fn stage(root: &Path, source: &Path) -> Result<Value> {
    validate(source)?;
    let source = source.canonicalize()?;
    ensure!(
        source != root.join("library.db").canonicalize()?,
        "Choose a saved backup, not the active library"
    );
    let pending = root.join("restore-pending.sqlite");
    let tmp = root.join(format!("restore-{}.partial", uuid::Uuid::new_v4()));
    let result = (|| -> Result<Value> {
        copy_database(&readonly(&source)?, &tmp)?;
        let summary = validate(&tmp)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        // A superseded pending restore has not touched the active database.
        std::fs::rename(&tmp, &pending)?;
        runtime_log::push(
            "warn",
            "Database restore staged; it will be applied after restart",
        );
        Ok(summary)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}
pub fn cancel(root: &Path) -> Result<()> {
    let path = root.join("restore-pending.sqlite");
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
/// Called before opening any application database connections. SQLite's online backup
/// API applies the replacement as a transaction, so a crash cannot leave half a DB.
pub fn apply_pending(root: &Path) -> Result<Option<PathBuf>> {
    let pending = root.join("restore-pending.sqlite");
    if !pending.exists() {
        return Ok(None);
    }
    validate(&pending)?;
    let folder = root.join("backups");
    std::fs::create_dir_all(&folder)?;
    let previous = create(root, &folder)?;
    let previous = PathBuf::from(previous["path"].as_str().unwrap());
    let source = readonly(&pending)?;
    let mut dest = Connection::open(root.join("library.db"))?;
    dest.busy_timeout(Duration::from_secs(10))?;
    rusqlite::backup::Backup::new(&source, &mut dest)?.run_to_completion(
        256,
        Duration::from_millis(5),
        None,
    )?;
    let has_files: bool = source.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='concord_backup_files')",
        [],
        |r| r.get(0),
    )?;
    if has_files {
        for name in CONFIG_FILES {
            let data: Option<Vec<u8>> = source.query_row(
                "SELECT content FROM concord_backup_files WHERE name=?1",
                [name],
                |r| r.get(0),
            ).optional()?.flatten();
            if let Some(bytes) = data {
                private_write(root, name, &bytes)?;
            } else if root.join(name).exists() {
                std::fs::remove_file(root.join(name))?;
            }
        }
        dest.execute_batch("DROP TABLE concord_backup_files")?;
    }
    dest.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    drop(dest);
    drop(source);
    std::fs::remove_file(pending)?;
    runtime_log::push(
        "info",
        "Staged restore applied; previous database retained in backups",
    );
    Ok(Some(previous))
}
