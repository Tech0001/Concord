//! First-run setup: one readiness snapshot, checks before large downloads, and saved progress.
use crate::{ai, db, pipeline, runtime_log, speech, speech_setup};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command, time::Duration};

pub const STEPS: [&str; 6] = ["library", "speech", "recordings", "ai", "look", "ready"];
/// Measured from a real install: Python 3.12 (0.1 GB), the voice-matching venv (2.1 GB) and the
/// package cache it fills (2.0 GB), plus a margin.
pub const RUNTIME_BYTES: u64 = 4_400_000_000;
/// What the voice-matching runtime occupies once installed, for display.
pub const RUNTIME_INSTALLED_BYTES: u64 = 2_200_000_000;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Patch {
    pub step: Option<String>,
    pub completed: Option<bool>,
    pub skipped: Option<Vec<String>>,
    pub checklist_hidden: Option<bool>,
}

pub const LOCAL_SERVERS: [(&str, &str); 2] = [
    ("ollama", "http://127.0.0.1:11434/v1"),
    ("lmstudio", "http://127.0.0.1:1234/v1"),
];

fn setting(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .optional()?)
}
pub fn progress(root: &Path) -> Result<Value> {
    let db = db::open(root)?;
    let known = |key| -> Result<String> {
        Ok(setting(&db, key)?
            .filter(|s| STEPS.contains(&s.as_str()))
            .unwrap_or_else(|| STEPS[0].into()))
    };
    let step = known("onboarding.step")?;
    let furthest = known("onboarding.furthest")?;
    let skipped: Vec<String> = setting(&db, "onboarding.skipped")?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    Ok(json!({
        "step": step,
        "furthest": furthest,
        "completed": setting(&db, "onboarding.completed")?.as_deref() == Some("true"),
        "skipped": skipped,
        "checklistHidden": setting(&db, "onboarding.checklist_hidden")?.as_deref() == Some("true"),
    }))
}
pub fn save(root: &Path, patch: &Patch) -> Result<Value> {
    let known = |s: &String| STEPS.contains(&s.as_str());
    ensure!(patch.step.as_ref().is_none_or(known), "Unknown setup step");
    ensure!(
        patch.skipped.as_ref().is_none_or(|s| s.iter().all(known)),
        "Unknown setup step"
    );
    let furthest = progress(root)?["furthest"].as_str().unwrap_or_default().to_owned();
    let index = |s: &str| STEPS.iter().position(|x| *x == s).unwrap_or(0);
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    let put = |key: &str, value: String| {
        tx.execute(
            "INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
    };
    if let Some(step) = &patch.step {
        put("onboarding.step", step.clone())?;
        if index(step) > index(&furthest) {
            put("onboarding.furthest", step.clone())?;
        }
    }
    if let Some(completed) = patch.completed {
        put("onboarding.completed", completed.to_string())?;
    }
    if let Some(skipped) = &patch.skipped {
        put("onboarding.skipped", serde_json::to_string(skipped)?)?;
    }
    if let Some(hidden) = patch.checklist_hidden {
        put("onboarding.checklist_hidden", hidden.to_string())?;
    }
    tx.commit()?;
    progress(root)
}

/// Counts from the previous Concord app's library, opened read-only. None when there is no
/// supported library in `folder`.
pub fn legacy_summary(folder: &Path) -> Result<Option<Value>> {
    let path = folder.join("pipeline.db");
    if !path.is_file() {
        return Ok(None);
    }
    // Immutable keeps SQLite from creating -wal/-shm files beside the previous app's library.
    let mut uri = url::Url::from_file_path(&path).map_err(|_| anyhow::anyhow!("Invalid library path"))?;
    uri.query_pairs_mut().append_pair("immutable", "1");
    let old = Connection::open_with_flags(uri.as_str(), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)?;
    let tables: i64 = old.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('video_queue','speakers','transcript_segments_fts')",
        [],
        |r| r.get(0),
    )?;
    if tables != 3 {
        return Ok(None);
    }
    let count = |table: &str| -> Result<i64> {
        let exists: bool = old.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(0);
        }
        Ok(old.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
    };
    let models = folder.join("models/nemo");
    let reusable: u64 = speech_setup::ARTIFACTS
        .iter()
        .filter(|a| has_model(&models, a))
        .map(|a| a.bytes)
        .sum();
    Ok(Some(json!({
        "path": path,
        "folder": folder,
        "recordings": count("video_queue")?,
        "speakers": count("speakers")?,
        "notes": count("transcript_clips")?,
        "speechModelsReusable": reusable > 0,
        "reusableBytes": reusable,
    })))
}

/// Free space available to Concord on the disk that holds `path`, or its nearest parent.
#[cfg(unix)]
pub fn free_bytes(path: &Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let existing = path
        .ancestors()
        .find(|p| p.exists())
        .context("Cannot find the library disk")?;
    let name = std::ffi::CString::new(existing.as_os_str().as_bytes())?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `name` is a valid C string and `stat` is a writable statvfs.
    let rc = unsafe { libc::statvfs(name.as_ptr(), &mut stat) };
    ensure!(rc == 0, "Cannot read free space: {}", std::io::Error::last_os_error());
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}
#[cfg(not(unix))]
pub fn free_bytes(_path: &Path) -> Result<u64> {
    anyhow::bail!("Free space checks are not available on this system")
}

/// A quick size check; setup verifies checksums before using a model.
fn has_model(dir: &Path, a: &speech_setup::Artifact) -> bool {
    fs::metadata(dir.join(a.name)).is_ok_and(|m| m.len() == a.bytes)
}
/// For each speech model: already in this library, copied from the previous app, or downloaded.
pub fn model_states(root: &Path, reuse: &Path) -> Vec<Value> {
    let own = speech_setup::models(root);
    speech_setup::ARTIFACTS
        .iter()
        .map(|a| {
            let state = if has_model(&own, a) {
                "installed"
            } else if has_model(reuse, a) {
                "reusable"
            } else {
                "download"
            };
            json!({"name": a.name, "bytes": a.bytes, "state": state})
        })
        .collect()
}
/// Disk space and download size still needed for speech: (disk, download).
pub fn needed(root: &Path, reuse: &Path, runtime_installed: bool) -> (u64, u64) {
    let own = speech_setup::models(root);
    let (mut disk, mut download) = (0, 0);
    for a in speech_setup::ARTIFACTS.iter().filter(|a| !has_model(&own, a)) {
        disk += a.bytes;
        if !has_model(reuse, a) {
            download += a.bytes;
        }
    }
    if !runtime_installed {
        disk += RUNTIME_BYTES;
    }
    (disk, download)
}

/// Whether the hosts setup downloads from answer. Returns the first problem found.
fn reachable(urls: &[&'static str]) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let checks: Vec<_> = urls
        .iter()
        .copied()
        .map(|url| {
            let client = client.clone();
            std::thread::spawn(move || client.head(url).send().map(|_| ()).map_err(|_| url))
        })
        .collect();
    for check in checks {
        if let Ok(Err(url)) = check.join() {
            let host = url.trim_start_matches("https://");
            return Err(format!("Can't reach {host}. Check your connection."));
        }
    }
    Ok(())
}

/// Checks before speech setup starts: free disk, network, and FFmpeg.
pub fn preflight(root: &Path, runtime: &speech::Runtime) -> Result<Value> {
    let installed = speech_setup::active(root).is_some();
    let (disk, download) = needed(root, &runtime.models, installed);
    let ffmpeg = Command::new("ffmpeg")
        .env_remove("LD_LIBRARY_PATH")
        .arg("-version")
        .output()
        .is_ok_and(|o| o.status.success());
    let mut hosts = vec!["https://pypi.org"];
    if download > 0 {
        hosts.push("https://huggingface.co");
        hosts.push("https://api.ngc.nvidia.com");
    }
    let network = if disk == 0 { Ok(()) } else { reachable(&hosts) };
    let free = free_bytes(root);
    Ok(json!({
        "freeBytes": free.as_ref().ok(),
        "freeError": free.err().map(|e| format!("{e:#}")),
        "neededBytes": disk,
        "downloadBytes": download,
        "modelBytes": speech_setup::MODEL_BYTES,
        "models": model_states(root, &runtime.models),
        "runtimeBytes": RUNTIME_INSTALLED_BYTES,
        "ffmpeg": ffmpeg,
        "network": {"ok": network.is_ok(), "error": network.err()},
    }))
}

/// Local OpenAI-compatible servers that answer on loopback.
pub fn probe_local(targets: &[(&str, &str)]) -> Vec<Value> {
    let Ok(client) = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(600))
        .build()
    else {
        return Vec::new();
    };
    targets
        .iter()
        .filter_map(|(kind, base)| {
            let response = client.get(format!("{base}/models")).send().ok()?;
            if !response.status().is_success() {
                return None;
            }
            let body: Value = response.json().ok()?;
            let models = body["data"].as_array().map_or(0, Vec::len);
            Some(json!({"kind": kind, "baseUrl": base, "models": models}))
        })
        .collect()
}

/// Everything setup, the Library checklist and the sidebar need, in one call.
pub fn status(
    root: &Path,
    runtime: &speech::Runtime,
    setup: &speech_setup::Control,
    legacy: &Path,
) -> Result<Value> {
    let stats = db::stats(root)?;
    let db = db::open(root)?;
    let started = stats["libraryStarted"] == true;
    let speech = speech_setup::state(root, setup);
    let config = ai::config::read(root).unwrap_or_else(|e| {
        runtime_log::push("warn", &format!("AI settings could not be read: {e:#}"));
        ai::config::Config::default()
    });
    let chat = &config.chat;
    let connected = chat.enabled
        && !chat.model.is_empty()
        && (chat.kind != "chatgpt" || ai::chatgpt::available(root, &chat.account_id))
        && (!ai::subscription::is_cli(&chat.kind) || ai::subscription::installed(&chat.kind));
    let embedding = &config.embedding;
    let legacy = if started {
        Value::Null
    } else {
        match legacy_summary(legacy) {
            Ok(summary) => json!(summary),
            Err(e) => {
                runtime_log::push("warn", &format!("Previous library check: {e:#}"));
                Value::Null
            }
        }
    };
    let count = |sql: &str| -> Result<i64> { Ok(db.query_row(sql, [], |r| r.get(0))?) };
    Ok(json!({
        "progress": progress(root)?,
        "library": {
            "started": started,
            "imported": setting(&db, "imported_from")?.is_some(),
            "media": stats["media"],
            "docs": stats["docs"],
            "notes": stats["notes"],
            "dataRoot": root,
        },
        "legacy": legacy,
        "speech": {
            "installed": runtime.for_root(root).installed(),
            "managed": speech_setup::active(root).is_some(),
            "device": pipeline::device(root)?,
            "setup": {"status": speech.status, "message": speech.message, "phase": speech.phase, "done": speech.done, "total": speech.total},
        },
        "sources": {
            "sources": count("SELECT count(*) FROM channels WHERE kind<>'collection'")?,
            "documentFolders": count("SELECT count(*) FROM document_roots WHERE id<>''")?,
        },
        "search": {
            "kind": embedding.kind,
            "enabled": embedding.enabled,
            "modelReady": embedding.enabled && (embedding.kind != "builtin" || ai::builtin::ready(root)),
            "download": ai::builtin::prepare_status(root),
        },
        "chat": {"kind": chat.kind, "enabled": chat.enabled, "model": chat.model, "connected": connected},
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_starts_at_the_library_and_saves_each_change() {
        let root = tempfile::tempdir().unwrap();
        let fresh = progress(root.path()).unwrap();
        assert_eq!(fresh, json!({"step":"library","furthest":"library","completed":false,"skipped":[],"checklistHidden":false}));
        save(root.path(), &Patch { step: Some("speech".into()), skipped: Some(vec!["recordings".into()]), ..Default::default() }).unwrap();
        let saved = save(root.path(), &Patch { checklist_hidden: Some(true), ..Default::default() }).unwrap();
        assert_eq!(saved, json!({"step":"speech","furthest":"speech","completed":false,"skipped":["recordings"],"checklistHidden":true}));
        let back = save(root.path(), &Patch { step: Some("library".into()), ..Default::default() }).unwrap();
        assert_eq!((back["step"].as_str(), back["furthest"].as_str()), (Some("library"), Some("speech")));
        assert!(save(root.path(), &Patch { step: Some("elsewhere".into()), ..Default::default() }).is_err());
        assert!(save(root.path(), &Patch { skipped: Some(vec!["nope".into()]), ..Default::default() }).is_err());
        let done = save(root.path(), &Patch { completed: Some(true), ..Default::default() }).unwrap();
        assert_eq!(done["completed"], true);
    }

    fn legacy_fixture(folder: &Path) {
        fs::create_dir_all(folder).unwrap();
        let old = rusqlite::Connection::open(folder.join("pipeline.db")).unwrap();
        old.execute_batch(
            "CREATE TABLE video_queue(id INTEGER PRIMARY KEY);
             CREATE TABLE speakers(id TEXT PRIMARY KEY);
             CREATE TABLE transcript_segments_fts(text TEXT);
             CREATE TABLE transcript_clips(id TEXT PRIMARY KEY);
             INSERT INTO video_queue(id) VALUES (1),(2),(3);
             INSERT INTO speakers(id) VALUES ('a'),('b');
             INSERT INTO transcript_clips(id) VALUES ('n1');",
        )
        .unwrap();
    }
    fn sparse_models(folder: &Path, skip: usize) {
        fs::create_dir_all(folder).unwrap();
        for a in speech_setup::ARTIFACTS.iter().skip(skip) {
            fs::File::create(folder.join(a.name)).unwrap().set_len(a.bytes).unwrap();
        }
    }

    #[test]
    fn the_previous_library_is_summarised_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("concord");
        assert!(legacy_summary(&folder).unwrap().is_none());
        legacy_fixture(&folder);
        let summary = legacy_summary(&folder).unwrap().unwrap();
        assert_eq!(summary["recordings"], 3);
        assert_eq!(summary["speakers"], 2);
        assert_eq!(summary["notes"], 1);
        assert_eq!(summary["speechModelsReusable"], false);
        assert_eq!(summary["path"], json!(folder.join("pipeline.db")));
        // The previous app kept the two Nemotron models but not TitaNet.
        let models = folder.join("models/nemo");
        fs::create_dir_all(&models).unwrap();
        for a in &speech_setup::ARTIFACTS[..2] {
            fs::File::create(models.join(a.name)).unwrap().set_len(a.bytes).unwrap();
        }
        let partial = legacy_summary(&folder).unwrap().unwrap();
        assert_eq!(partial["speechModelsReusable"], true);
        assert_eq!(partial["reusableBytes"], speech_setup::ARTIFACTS[0].bytes + speech_setup::ARTIFACTS[1].bytes);
        let other = dir.path().join("other");
        fs::create_dir_all(&other).unwrap();
        rusqlite::Connection::open(other.join("pipeline.db")).unwrap().execute_batch("CREATE TABLE notes(id TEXT)").unwrap();
        assert!(legacy_summary(&other).unwrap().is_none());
    }

    #[test]
    fn free_space_is_read_from_the_library_disk() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes(dir.path()).unwrap() > 0);
    }

    #[test]
    fn reusable_models_need_disk_space_but_no_download() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("next");
        let legacy = dir.path().join("legacy");
        let models = speech_setup::MODEL_BYTES;
        assert_eq!(needed(&root, &legacy, false), (models + RUNTIME_BYTES, models));
        sparse_models(&legacy, 0);
        assert_eq!(needed(&root, &legacy, false), (models + RUNTIME_BYTES, 0));
        sparse_models(&speech_setup::models(&root), 1);
        let first = speech_setup::ARTIFACTS[0].bytes;
        assert_eq!(needed(&root, &dir.path().join("none"), true), (first, first));
    }

    #[test]
    fn each_model_is_marked_installed_reusable_or_to_download() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("next");
        let legacy = dir.path().join("legacy");
        sparse_models(&legacy, 1);
        fs::create_dir_all(speech_setup::models(&root)).unwrap();
        let first = &speech_setup::ARTIFACTS[0];
        fs::File::create(speech_setup::models(&root).join(first.name)).unwrap().set_len(first.bytes).unwrap();
        let states: Vec<_> = model_states(&root, &legacy).iter().map(|m| m["state"].as_str().unwrap().to_owned()).collect();
        assert_eq!(states, ["installed", "reusable", "reusable"]);
        let states: Vec<_> = model_states(&root, &dir.path().join("none")).iter().map(|m| m["state"].as_str().unwrap().to_owned()).collect();
        assert_eq!(states, ["installed", "download", "download"]);
    }

    #[test]
    fn a_running_local_ai_server_is_found() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        std::thread::spawn(move || {
            if let Ok(Some(req)) = server.recv_timeout(std::time::Duration::from_secs(10)) {
                let _ = req.respond(tiny_http::Response::from_string(r#"{"data":[{"id":"a"},{"id":"b"}]}"#));
            }
        });
        let found = probe_local(&[("ollama", base.as_str()), ("lmstudio", "http://127.0.0.1:9/v1")]);
        assert_eq!(found, vec![json!({"kind":"ollama","baseUrl":base,"models":2})]);
    }

    #[test]
    fn unreadable_ai_settings_do_not_hide_setup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("next");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("ai-providers.json"), b"{ not json").unwrap();
        let runtime = speech::Runtime {
            binary: dir.path().join("nemo-speech"),
            script: dir.path().join("transcribe.py"),
            python: dir.path().join("venv/bin/python"),
            models: dir.path().join("none"),
        };
        let value = status(&root, &runtime, &speech_setup::Control::default(), &dir.path().join("legacy")).unwrap();
        assert_eq!(value["library"]["started"], false);
        assert_eq!(value["chat"]["connected"], false);
    }

    #[test]
    fn a_new_library_reports_nothing_set_up() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("next");
        let runtime = speech::Runtime {
            binary: dir.path().join("nemo-speech"),
            script: dir.path().join("transcribe.py"),
            python: dir.path().join("venv/bin/python"),
            models: dir.path().join("none"),
        };
        let value = status(&root, &runtime, &speech_setup::Control::default(), &dir.path().join("legacy")).unwrap();
        assert_eq!(value["library"]["started"], false);
        assert_eq!(value["speech"]["installed"], false);
        assert_eq!(value["search"]["kind"], "builtin");
        assert_eq!(value["search"]["modelReady"], false);
        assert_eq!(value["chat"]["connected"], false);
        assert_eq!(value["progress"]["step"], "library");
        assert_eq!(value["sources"], json!({"sources":0,"documentFolders":0}));
    }
}
