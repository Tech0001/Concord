//! Recording file actions preserve research and journal filesystem changes before publication.
use crate::{db, health, pipeline, speech};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::Ordering,
    time::Duration,
};
const JOURNAL: &str = "pending-media-file-action";
#[derive(Serialize, Deserialize)]
struct Operation {
    kind: String,
    source: PathBuf,
    target: Option<PathBuf>,
    ids: Vec<String>,
    fingerprint: String,
}

pub fn migrate(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS removed_recordings(id TEXT PRIMARY KEY,path TEXT,url TEXT NOT NULL DEFAULT '',removed_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE INDEX IF NOT EXISTS removed_recordings_path ON removed_recordings(path);
      CREATE INDEX IF NOT EXISTS removed_recordings_url ON removed_recordings(url);
      ")?;
    let has_title: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('note_anchors') WHERE name='source_title')",
        [],
        |r| r.get(0),
    )?;
    if !has_title {
        db.execute_batch("ALTER TABLE note_anchors ADD COLUMN source_title TEXT")?;
    }
    Ok(())
}

/// Forget this library entry without touching any files or deleting research notes.
pub fn remove(
    root: &Path,
    control: &pipeline::Control,
    ai: &crate::ai::Control,
    id: &str,
) -> Result<()> {
    let _gate = control.gate.lock().unwrap();
    let _automatic = ai.automation_gate.lock().unwrap();
    let _index = ai.index_job.lock().unwrap();
    let summaries = ai.summaries.lock().unwrap();
    ensure!(
        !control.checking.load(Ordering::SeqCst),
        "Wait for the source scan to finish before removing a recording"
    );
    ensure!(
        !ai.indexing.load(Ordering::SeqCst),
        "Wait for semantic indexing to finish before removing a recording"
    );
    ensure!(
        !summaries.contains_key(id),
        "Stop this recording's AI summary before removing it"
    );
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM jobs WHERE media_id=?1 AND status='running')",
        [id],
        |r| r.get(0),
    )?;
    ensure!(!active, "Stop processing this recording before removing it");
    let (path, url, title): (Option<String>, String, String) = tx
        .query_row("SELECT path,url,title FROM media WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .context("Recording not found")?;
    let path = path.map(|p| {
        Path::new(&p)
            .canonicalize()
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or(p)
    });
    tx.execute(
        "INSERT OR REPLACE INTO removed_recordings(id,path,url) VALUES(?1,?2,?3)",
        params![id, path, url],
    )?;
    crate::research::backfill(&tx)?;
    tx.execute(
        "UPDATE note_anchors SET source_title=?2,media_id=NULL WHERE media_id=?1",
        params![id, title],
    )?;
    tx.execute("UPDATE notes SET media_id=NULL WHERE media_id=?1", [id])?;
    tx.execute("DELETE FROM jobs WHERE media_id=?1", [id])?;
    tx.execute("DELETE FROM segments WHERE media_id=?1", [id])?;
    tx.execute("DELETE FROM assignments WHERE media_id=?1", [id])?;
    // Foreign keys/triggers remove summaries, semantic chunks, fingerprints and follow-ups.
    // Speaker profiles and their accumulated voice training remain available.
    tx.execute("DELETE FROM media WHERE id=?1", [id])?;
    tx.commit()?;
    crate::runtime_log::push(
        "info",
        "Recording removed from library; original files kept",
    );
    Ok(())
}

fn fingerprint(path: &Path) -> Result<String> {
    let stamp = health::stamp(path)?;
    let bytes = stamp.0;
    let mut file = fs::File::open(path)?;
    let mut first = vec![0; bytes.min(1024 * 1024) as usize];
    let mut last = first.clone();
    file.read_exact(&mut first)?;
    file.seek(SeekFrom::Start(bytes.saturating_sub(last.len() as u64)))?;
    file.read_exact(&mut last)?;
    ensure!(
        health::stamp(path)? == stamp,
        "The recording changed while reading it; try again"
    );
    let mut hash = Sha256::new();
    hash.update(format!("{bytes}\0"));
    hash.update(first);
    hash.update(last);
    Ok(format!("{:x}", hash.finalize()))
}
fn shared(root: &Path, path: &Path, id: &str) -> Result<Vec<Value>> {
    Ok(db::rows(
        &db::open(root)?,
        "SELECT id,title,path FROM media WHERE path IS NOT NULL OR id=?1",
        [id],
    )?
    .into_iter()
    .filter(|m| {
        m["id"] == id
            || m["path"].as_str().is_some_and(|p| {
                Path::new(p) == path || Path::new(p).canonicalize().is_ok_and(|p| p == path)
            })
    })
    .collect())
}
pub fn info(root: &Path, id: &str) -> Result<Value> {
    let media = db::media(root, id)?;
    let path = media["path"].as_str().map(PathBuf::from);
    let path = path.map(|p| p.canonicalize().unwrap_or(p));
    let linked = if let Some(ref path) = path {
        shared(root, path, id)?
    } else {
        vec![json!({"id":id,"title":media["title"]})]
    };
    Ok(
        json!({"id":id,"title":media["title"],"path":path,"exists":path.as_ref().is_some_and(|p|p.is_file()),"filename":path.as_ref().and_then(|p|p.file_stem()).map(|s|s.to_string_lossy()),"extension":path.as_ref().and_then(|p|p.extension()).map(|s|s.to_string_lossy()),"shared":linked}),
    )
}
pub fn title(root: &Path, id: &str, title: &str) -> Result<()> {
    let title = title.trim();
    ensure!(
        !title.is_empty() && title.len() <= 2048 && !title.chars().any(char::is_control),
        "Enter a recording title up to 2,048 bytes without control characters"
    );
    ensure!(
        db::open(root)?.execute("UPDATE media SET title=?1 WHERE id=?2", params![title, id])? == 1,
        "Recording not found"
    );
    Ok(())
}
fn publish(root: &Path, op: &Operation) -> Result<()> {
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    for id in &op.ids {
        match op.kind.as_str() {
            "rename" => {
                tx.execute(
                    "UPDATE media SET path=?1 WHERE id=?2",
                    params![
                        op.target
                            .as_ref()
                            .context("Missing renamed path")?
                            .to_string_lossy(),
                        id
                    ],
                )?;
                tx.execute(
                    "UPDATE media_fingerprints SET path=?1 WHERE media_id=?2",
                    params![op.target.as_ref().unwrap().to_string_lossy(), id],
                )?;
            }
            "trash" => {
                tx.execute("UPDATE media SET status='archived' WHERE id=?1", [id])?;
            }
            _ => anyhow::bail!("Unknown pending file action"),
        }
    }
    tx.execute("DELETE FROM settings WHERE key=?1", [JOURNAL])?;
    tx.commit()?;
    Ok(())
}
/// Restart recovery only publishes an already completed filesystem action. It never moves files.
pub fn recover(root: &Path) -> Result<()> {
    let db = db::open(root)?;
    let pending: Option<String> = db
        .query_row("SELECT value FROM settings WHERE key=?1", [JOURNAL], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(pending) = pending else {
        return Ok(());
    };
    let op: Operation = serde_json::from_str(&pending)?;
    if op.source.exists() {
        ensure!(
            op.target.as_ref().is_none_or(|p| !p.exists()),
            "Both file paths exist after an interrupted rename. Check {} and {} before retrying",
            op.source.display(),
            op.target.as_ref().unwrap().display()
        );
        ensure!(
            fingerprint(&op.source)? == op.fingerprint,
            "The original file changed after an interrupted action: {}",
            op.source.display()
        );
        db.execute("DELETE FROM settings WHERE key=?1", [JOURNAL])?;
        return Ok(());
    }
    if op.kind == "rename" {
        let target = op.target.as_ref().context("Missing recovery path")?;
        ensure!(
            target.is_file() && fingerprint(target)? == op.fingerprint,
            "An interrupted rename needs its file at {} or {}",
            op.source.display(),
            target.display()
        );
    } else {
        ensure!(op.kind == "trash", "Unknown pending file action");
    }
    publish(root, &op)
}
fn busy(root: &Path, ids: &[String], control: &pipeline::Control) -> Result<()> {
    ensure!(
        !control.checking.load(Ordering::SeqCst),
        "Wait for the source check to finish before changing files"
    );
    let active:bool=db::open(root)?.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE media_id IN (SELECT value FROM json_each(?1)) AND status IN ('queued','running','retry','waiting_live'))",[serde_json::to_string(ids)?],|r|r.get(0))?;
    ensure!(
        !active,
        "Remove this recording from the processing queue before changing its file"
    );
    Ok(())
}
fn renamed(source: &Path, stem: &str) -> Result<PathBuf> {
    let stem = stem.trim();
    ensure!(
        !stem.is_empty()
            && !stem.starts_with('.')
            && !stem
                .chars()
                .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c)),
        "Choose a filename without path separators, control characters or reserved characters"
    );
    let ext = source
        .extension()
        .context("Recording has no file extension")?
        .to_string_lossy();
    let name = format!("{stem}.{ext}");
    ensure!(
        name.len() <= 255,
        "Filename is too long; use a shorter name"
    );
    Ok(source.with_file_name(name))
}
#[cfg(target_os = "linux")]
pub(crate) fn rename_no_replace(source: &Path, target: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error())
            .context("Cannot rename the recording; an existing file will not be replaced");
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
pub(crate) fn rename_no_replace(_source: &Path, _target: &Path) -> Result<()> {
    anyhow::bail!("File renaming is currently available on Linux")
}
#[cfg(target_os = "linux")]
fn trash(source: &Path) -> Result<()> {
    use gio::prelude::FileExt;
    gio::File::for_path(source).trash(gio::Cancellable::NONE).context("This filesystem could not move the recording to Trash; the file was not permanently deleted")
}
#[cfg(not(target_os = "linux"))]
fn trash(_source: &Path) -> Result<()> {
    anyhow::bail!("Move to Trash is currently available on Linux")
}

pub fn change(
    root: &Path,
    control: &pipeline::Control,
    id: &str,
    action: &str,
    value: &str,
) -> Result<Value> {
    let _gate = control
        .gate
        .lock()
        .map_err(|_| anyhow::anyhow!("Processing lock interrupted"))?;
    recover(root)?;
    let before = info(root, id)?;
    let stored = before["path"].as_str().map(PathBuf::from);
    let ids = before["shared"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    busy(root, &ids, control)?;
    if action == "relink" {
        return relink(root, id, stored.as_deref(), &ids, Path::new(value));
    }
    ensure!(["rename", "trash"].contains(&action), "Unknown file action");
    let source = stored.context("This recording has no local file; locate it first")?;
    ensure!(
        source.is_file(),
        "Recording file is unavailable; reconnect its drive or locate a copy"
    );
    let target = if action == "rename" {
        Some(renamed(&source, value)?)
    } else {
        None
    };
    if target.as_ref() == Some(&source) {
        return Ok(before);
    }
    ensure!(
        target.as_ref().is_none_or(|p| !p.exists()),
        "A file with that name already exists"
    );
    let op = Operation {
        kind: action.into(),
        fingerprint: fingerprint(&source)?,
        source,
        target,
        ids,
    };
    db::open(root)?.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2)",
        params![JOURNAL, serde_json::to_string(&op)?],
    )?;
    let result = if action == "rename" {
        rename_no_replace(&op.source, op.target.as_ref().unwrap())
    } else {
        trash(&op.source)
    };
    if let Err(e) = result {
        if fingerprint(&op.source).is_ok_and(|f| f == op.fingerprint) {
            db::open(root)?.execute("DELETE FROM settings WHERE key=?1", [JOURNAL])?;
        } else {
            let _ = recover(root);
        }
        return Err(e);
    }
    publish(root, &op)
        .context("File action completed; restart Concord to finish updating its saved location")?;
    crate::runtime_log::push(
        "info",
        &format!("Recording file action completed: {action}"),
    );
    info(root, id)
}
fn relink(
    root: &Path,
    id: &str,
    old: Option<&Path>,
    ids: &[String],
    target: &Path,
) -> Result<Value> {
    let target = target
        .canonicalize()
        .context("Choose an available copy of the recording")?;
    ensure!(target.is_file(), "Choose a recording file");
    let actual = fingerprint(&target)?;
    let expected = if let Some(old) = old.filter(|p| p.is_file()) {
        Some(fingerprint(old)?)
    } else {
        db::open(root)?
            .query_row(
                "SELECT fingerprint FROM media_fingerprints WHERE media_id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
    };
    if let Some(expected) = expected {
        ensure!(
            actual == expected,
            "That file does not match this recording. Add it as a new recording instead."
        );
    }
    let mut command = Command::new("ffprobe");
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
        ])
        .arg(&target);
    let probe = pipeline::subprocess::capture(
        root,
        &speech::Control::default(),
        command,
        None,
        Duration::from_secs(30),
    )
    .context("Cannot inspect the recording; check that FFmpeg and ffprobe are installed")?;
    ensure!(
        probe.success,
        "The selected file could not be read as media"
    );
    let probe: Value = serde_json::from_str(&probe.text)?;
    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.)
        .context("Cannot determine the selected recording's duration")?;
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    for shared in ids {
        let old_duration: f64 =
            tx.query_row("SELECT duration FROM media WHERE id=?1", [shared], |r| {
                r.get(0)
            })?;
        ensure!(
            old_duration <= 0. || (old_duration - duration).abs() <= 2f64.max(old_duration * 0.01),
            "The selected file has a different duration; choose a copy of the same recording"
        );
        tx.execute("UPDATE media SET path=?1,duration=?2,status=CASE WHEN transcript IS NULL THEN 'ready' ELSE 'complete' END WHERE id=?3",params![target.to_string_lossy(),duration,shared])?;
        let (bytes, mtime) = health::stamp(&target)?;
        tx.execute("INSERT INTO media_fingerprints VALUES(?1,?2,?3,?4,?5) ON CONFLICT(media_id) DO UPDATE SET path=excluded.path,bytes=excluded.bytes,mtime=excluded.mtime,fingerprint=excluded.fingerprint",params![shared,target.to_string_lossy(),bytes,mtime,actual])?;
    }
    tx.commit()?;
    // Timings and evidence are retained. Remove only derived waveform/thumbnail caches.
    for shared in ids {
        let hash = format!("{:x}", Sha256::digest(shared.as_bytes()));
        let _ = fs::remove_file(root.join("waveforms").join(format!("{hash}.json")));
        let _ = fs::remove_file(root.join("thumbnails").join(format!("{hash}.jpg")));
    }
    info(root, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn fixture() -> (tempfile::TempDir, pipeline::Control, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = root.join("recording.wav");
        let ok = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=220:duration=2",
                "-y",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(ok.success());
        let db = db::open(root).unwrap();
        for id in ["one", "two"] {
            db.execute("INSERT INTO media(id,title,path,transcript,duration,status) VALUES(?1,?1,?2,'retained.md',2,'complete')",params![id,path.to_string_lossy()]).unwrap();
        }
        db.execute_batch("INSERT INTO segments(media_id,start,end,speaker,text) VALUES('one',0,1,'S0','Retained evidence');INSERT INTO notes(id,title,media_id,start,end) VALUES('n','Keep this','one',0,1);INSERT INTO assignments(media_id,local_id,airtime) VALUES('one','S0',1);").unwrap();
        (
            dir,
            pipeline::Control::new(Arc::new(speech::Control::default())),
            path,
        )
    }
    #[test]
    fn removing_a_recording_keeps_files_notes_profiles_and_other_entries() {
        let (dir, c, path) = fixture();
        let root = dir.path();
        let ai = crate::ai::Control::default();
        let db = db::open(root).unwrap();
        fs::write(root.join("retained.md"), "Keep transcript file").unwrap();
        db.execute_batch("INSERT INTO speakers(id,name,embedding) VALUES('s','Person',X'0000803f');
              UPDATE assignments SET speaker_id='s' WHERE media_id='one';
              INSERT INTO speaker_training VALUES('s','one','S0');
              INSERT INTO note_anchors(id,note_id,position,media_id,start,end,quote) VALUES('a','n',0,'one',0,1,'Saved words');
              INSERT INTO ai_indexes VALUES('sig','model',1);
              INSERT INTO ai_sources VALUES('sig','recording','one','digest');
              INSERT INTO ai_chunks(signature,kind,source_id,position,text,vector) VALUES('sig','recording','one',0,'Search words',X'0000803f');
              INSERT INTO ai_summaries(media_id,content,model,digest) VALUES('one','Summary','model','digest');
              INSERT INTO jobs(id,media_id,title,status) VALUES('pending','one','One','queued');
              INSERT INTO pipeline_work(id,kind,device) VALUES('pending','transcribe','cpu');").unwrap();
        let bytes = fs::read(&path).unwrap();
        remove(root, &c, &ai, "one").unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            fs::read_to_string(root.join("retained.md")).unwrap(),
            "Keep transcript file"
        );
        assert!(db::media(root, "one").is_err());
        assert!(db::media(root, "two").is_ok());
        for table in [
            "assignments",
            "segments",
            "ai_sources",
            "ai_chunks",
            "ai_summaries",
            "jobs",
            "pipeline_work",
        ] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{table}"
            );
        }
        assert_eq!(
            db.query_row("SELECT count(*) FROM speakers", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let note = crate::research::read(root).unwrap()["notes"][0].clone();
        assert_eq!(note["anchors"][0]["title"], "one");
        assert_eq!(note["anchors"][0]["quote"], "Saved words");
        assert!(note["anchors"][0]["media_id"].is_null());
        let mut edit: crate::research::Note = serde_json::from_value(note).unwrap();
        edit.body = "Still editable".into();
        crate::research::save(root, &edit).unwrap();
        let saved = crate::research::read(root).unwrap()["notes"][0].clone();
        assert_eq!(saved["anchors"][0]["title"], "one");
        assert_eq!(saved["body"], "Still editable");
        assert_eq!(
            db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        db.execute(
            "INSERT INTO segments_fts(segments_fts,rank) VALUES('integrity-check',1)",
            [],
        )
        .unwrap();
        let backup = crate::health::backup::create(root, &root.join("backups")).unwrap();
        assert_eq!(
            crate::health::backup::validate(Path::new(backup["path"].as_str().unwrap())).unwrap()
                ["version"],
            13
        );
    }
    #[test]
    fn version_twelve_libraries_upgrade_without_changing_existing_content() {
        let (dir, _, path) = fixture();
        let root = dir.path();
        let db = db::open(root).unwrap();
        db.execute_batch("ALTER TABLE note_anchors DROP COLUMN source_title;DROP TABLE removed_recordings;PRAGMA user_version=12;").unwrap();
        drop(db);
        let db = db::open(root).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            13
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM media", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT media_id FROM notes WHERE id='n'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "one"
        );
        assert!(path.exists());
        migrate(&db).unwrap(); // Concurrent initial opens can both reach migration.
    }
    #[test]
    fn removal_refuses_active_work_and_accepts_missing_files() {
        let (dir, c, path) = fixture();
        let root = dir.path();
        let ai = crate::ai::Control::default();
        let db = db::open(root).unwrap();
        db.execute(
            "INSERT INTO jobs(id,media_id,title,status) VALUES('active','one','One','running')",
            [],
        )
        .unwrap();
        assert!(remove(root, &c, &ai, "one")
            .unwrap_err()
            .to_string()
            .contains("Stop processing"));
        db.execute("UPDATE jobs SET status='cancelled'", [])
            .unwrap();
        c.checking.store(true, Ordering::SeqCst);
        assert!(remove(root, &c, &ai, "one").is_err());
        c.checking.store(false, Ordering::SeqCst);
        ai.indexing.store(true, Ordering::SeqCst);
        assert!(remove(root, &c, &ai, "one").is_err());
        ai.indexing.store(false, Ordering::SeqCst);
        fs::remove_file(&path).unwrap();
        remove(root, &c, &ai, "one").unwrap();
        assert!(db::media(root, "one").is_err());
    }
    #[test]
    fn rename_updates_shared_paths_without_overwriting_files_or_research() {
        let (dir, c, old) = fixture();
        let root = dir.path();
        title(root, "one", "Renamed title").unwrap();
        assert!(title(root, "one", "\n").is_err());
        assert_eq!(
            info(root, "one").unwrap()["shared"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        for name in ["../escape", ".hidden", "bad/name", "bad\\name"] {
            assert!(change(root, &c, "one", "rename", name).is_err());
        }
        assert!(change(root, &c, "one", "rename", &"界".repeat(100)).is_err());
        fs::write(root.join("taken.wav"), b"never overwrite").unwrap();
        assert!(change(root, &c, "one", "rename", "taken").is_err());
        change(root, &c, "one", "rename", "A new name").unwrap();
        assert!(!old.exists());
        let path = root.join("A new name.wav");
        assert!(path.exists());
        assert_eq!(
            db::media(root, "two").unwrap()["path"],
            path.to_string_lossy().as_ref()
        );
        assert_eq!(db::media(root, "one").unwrap()["title"], "Renamed title");
        assert_eq!(
            db::open(root)
                .unwrap()
                .query_row("SELECT count(*) FROM segments", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            fs::read(root.join("taken.wav")).unwrap(),
            b"never overwrite"
        );
    }
    #[test]
    fn pending_rename_recovers_both_before_and_after_filesystem_change() {
        let (dir, _, source) = fixture();
        let root = dir.path();
        let target = root.join("recovered.wav");
        let op = Operation {
            kind: "rename".into(),
            source: source.clone(),
            target: Some(target.clone()),
            ids: vec!["one".into(), "two".into()],
            fingerprint: fingerprint(&source).unwrap(),
        };
        let save = || {
            db::open(root)
                .unwrap()
                .execute(
                    "INSERT INTO settings VALUES(?1,?2)",
                    params![JOURNAL, serde_json::to_string(&op).unwrap()],
                )
                .unwrap()
        };
        save();
        recover(root).unwrap();
        assert!(source.exists());
        save();
        rename_no_replace(&source, &target).unwrap();
        recover(root).unwrap();
        recover(root).unwrap();
        assert_eq!(
            db::media(root, "two").unwrap()["path"],
            target.to_string_lossy().as_ref()
        );
    }
    #[test]
    fn trash_recovery_keeps_evidence_and_reports_archived_despite_old_failure() {
        let (dir, _, source) = fixture();
        let root = dir.path();
        let op = Operation {
            kind: "trash".into(),
            fingerprint: fingerprint(&source).unwrap(),
            source: source.clone(),
            target: None,
            ids: vec!["one".into(), "two".into()],
        };
        db::open(root)
            .unwrap()
            .execute(
                "INSERT INTO settings VALUES(?1,?2)",
                params![JOURNAL, serde_json::to_string(&op).unwrap()],
            )
            .unwrap();
        fs::rename(&source, root.join("simulated-trash.wav")).unwrap();
        recover(root).unwrap();
        db::open(root).unwrap().execute_batch("INSERT INTO jobs(id,media_id,title,status) VALUES('old','one','Old attempt','failed')").unwrap();
        let library = db::library(
            root,
            &db::LibraryFilter {
                status: "archived".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(library["total"], 2);
        assert_eq!(db::media(root, "one").unwrap()["transcript"], "retained.md");
        let db = db::open(root).unwrap();
        for table in ["notes", "segments", "assignments"] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        assert!(!health::report::audit(root).unwrap()["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == "missing-media"));
    }
    #[test]
    fn relink_checks_fingerprints_and_keeps_recording_identity() {
        let (dir, c, source) = fixture();
        let root = dir.path();
        health::repair::fingerprint(root, "one").unwrap();
        let target = root.join("copy.wav");
        fs::copy(&source, &target).unwrap();
        fs::remove_file(&source).unwrap();
        let bad = root.join("wrong.wav");
        fs::write(&bad, b"not the recording").unwrap();
        assert!(change(root, &c, "one", "relink", bad.to_str().unwrap()).is_err());
        db::open(root)
            .unwrap()
            .execute("UPDATE media SET status='archived'", [])
            .unwrap();
        change(root, &c, "one", "relink", target.to_str().unwrap()).unwrap();
        assert_eq!(
            db::media(root, "two").unwrap()["path"],
            target.to_string_lossy().as_ref()
        );
        assert_eq!(db::media(root, "one").unwrap()["status"], "complete");
        assert_eq!(
            db::open(root)
                .unwrap()
                .query_row("SELECT count(*) FROM media", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn active_queue_blocks_file_actions() {
        let (dir, c, source) = fixture();
        let root = dir.path();
        db::open(root).unwrap().execute_batch("INSERT INTO jobs(id,media_id,title,status) VALUES('j','two','Shared recording','queued')").unwrap();
        assert!(change(root, &c, "one", "rename", "blocked")
            .unwrap_err()
            .to_string()
            .contains("queue"));
        assert!(source.exists());
    }
}
