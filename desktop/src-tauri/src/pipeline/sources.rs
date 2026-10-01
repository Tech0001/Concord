use super::{config, download, now, queue, running, save_config, subprocess, Control};
use crate::{db, runtime_log};
use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub url: String,
    pub enabled: bool,
    pub diarize: bool,
    pub include_shorts: bool,
    pub category: String,
}
pub fn list(root: &Path) -> Result<Vec<Value>> {
    db::rows(&db::open(root)?,"SELECT c.*,(SELECT count(*) FROM media m WHERE m.source_id=c.id) AS recordings FROM channels c ORDER BY name COLLATE NOCASE",[])
}
pub fn save(root: &Path, control: &Control, input: &Source) -> Result<String> {
    anyhow::ensure!(
        !control.checking.load(Ordering::SeqCst),
        "Wait for the source check to finish, or stop it before editing sources"
    );
    let name = input.name.trim();
    anyhow::ensure!(
        !name.is_empty() && name.chars().count() <= 160,
        "Enter a source name of 1–160 characters"
    );
    anyhow::ensure!(
        ["youtube", "folder", "collection"].contains(&input.kind.as_str()),
        "Choose a YouTube source or local folder"
    );
    anyhow::ensure!(
        ["personal", "work"].contains(&input.category.as_str()),
        "Choose Personal or Work"
    );
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let address = match input.kind.as_str() {
        "youtube" => download::youtube_url(&input.url)?.to_string(),
        "folder" => {
            let path = Path::new(input.url.trim());
            anyhow::ensure!(path.is_absolute(), "Choose an absolute folder path");
            if path.is_dir() {
                path.canonicalize()?.to_string_lossy().into_owned()
            } else {
                let existing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM channels WHERE id=?1 AND url=?2 AND kind='folder')",params![input.id,input.url],|r|r.get(0))?;
                anyhow::ensure!(existing, "The selected folder is unavailable");
                input.url.clone()
            }
        }
        _ => String::new(),
    };
    for source in db::rows(
        &tx,
        "SELECT id,name,url,kind FROM channels WHERE (?1 IS NULL OR id<>?1)",
        [input.id.as_deref()],
    )? {
        anyhow::ensure!(
            !source["name"]
                .as_str()
                .unwrap_or("")
                .eq_ignore_ascii_case(name),
            "A source already has this name"
        );
        if input.kind == "folder" && source["kind"] == "folder" {
            let old = Path::new(source["url"].as_str().unwrap());
            let new = Path::new(&address);
            anyhow::ensure!(
                !old.starts_with(new) && !new.starts_with(old),
                "This folder overlaps an existing recording source"
            );
        }
        if input.kind == "youtube" && source["kind"] == "youtube" {
            let old = download::scan_urls(source["url"].as_str().unwrap_or(""), false)
                .unwrap_or_default();
            anyhow::ensure!(
                old.first() != download::scan_urls(&address, false)?.first(),
                "This YouTube source is already subscribed"
            );
        }
    }
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if input.id.is_some() {
        let changed=tx.execute("UPDATE channels SET name=?1,url=?2,kind=?3,enabled=?4,diarize=?5,include_shorts=?6,category=?7 WHERE id=?8",params![name,address,input.kind,input.enabled,input.diarize,input.include_shorts,input.category,id])?;
        anyhow::ensure!(changed == 1, "Source not found");
        tx.execute(
            "UPDATE media SET channel=?1,category=?2 WHERE source_id=?3",
            params![name, input.category, id],
        )?;
    } else {
        tx.execute("INSERT INTO channels(id,name,url,kind,enabled,diarize,include_shorts,category) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![id,name,address,input.kind,input.enabled,input.diarize,input.include_shorts,input.category])?;
    }
    tx.commit()?;
    Ok(id)
}
pub fn remove(root: &Path, control: &Control, id: &str) -> Result<()> {
    anyhow::ensure!(
        !control.checking.load(Ordering::SeqCst),
        "Stop the source check before removing a source"
    );
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    tx.execute("UPDATE media SET source_id=NULL WHERE source_id=?1", [id])?;
    tx.execute("DELETE FROM channels WHERE id=?1", [id])?;
    tx.commit()?;
    Ok(())
}
fn source(root: &Path, id: &str) -> Result<Value> {
    db::rows(&db::open(root)?, "SELECT * FROM channels WHERE id=?1", [id])?
        .pop()
        .context("Source no longer exists")
}
fn files(folder: &Path, out: &mut Vec<PathBuf>, control: &Control) -> Result<()> {
    for entry in std::fs::read_dir(folder)? {
        anyhow::ensure!(!control.scanner.is_cancelled(), "Cancelled");
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') || kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files(&path, out, control)?;
        } else if kind.is_file()
            && [
                "mp4", "mkv", "webm", "mov", "ogg", "oga", "wav", "mp3", "m4a", "flac", "aac",
                "opus",
            ]
            .contains(
                &path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .as_str(),
            )
            && entry.metadata()?.len() > 0
        {
            out.push(path.canonicalize()?);
        }
    }
    Ok(())
}
pub(super) fn local(root: &Path, control: &Control, source: &Value) -> Result<usize> {
    let folder = Path::new(source["url"].as_str().unwrap());
    let mut paths = vec![];
    files(folder, &mut paths, control)?;
    paths.sort();
    let device = config(root)?.device;
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut added = 0;
    for path in paths {
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM media WHERE path=?1)",
            [path.to_string_lossy().as_ref()],
            |r| r.get::<_, bool>(0),
        )? {
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let title = path.file_stem().unwrap_or_default().to_string_lossy();
        tx.execute("INSERT INTO media(id,title,path,channel,source_id,category,date) VALUES (?1,?2,?3,?4,?5,?6,date('now','localtime'))",params![id,title,path.to_string_lossy(),source["name"].as_str(),source["id"].as_str(),source["category"].as_str()])?;
        queue::insert(
            &tx,
            &id,
            &title,
            "transcribe",
            &device,
            source["diarize"] != 0,
        )?;
        added += 1;
    }
    tx.commit()?;
    Ok(added)
}
pub(super) fn ingest(
    root: &Path,
    source: &Value,
    entries: &[Value],
    device: &str,
) -> Result<usize> {
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut added = 0;
    for e in entries {
        if source["include_shorts"] != 1
            && (e["is_short"] == true
                || e["url"].as_str().unwrap_or("").contains("/shorts/")
                || e["webpage_url"].as_str().unwrap_or("").contains("/shorts/"))
        {
            continue;
        }
        let Some(remote) = download::video_id(e) else {
            continue;
        };
        let id = serde_json::to_string(&(source["id"].as_str().unwrap(), remote))?;
        let url = format!("https://www.youtube.com/watch?v={remote}");
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM media WHERE id=?1 OR url=?2)",
            params![id, url],
            |r| r.get(0),
        )?;
        if exists {
            continue;
        }
        let title = e["title"].as_str().unwrap_or(remote);
        tx.execute("INSERT INTO media(id,title,url,channel,source_id,category,date,duration,status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending')",params![id,title,url,source["name"].as_str(),source["id"].as_str(),source["category"].as_str(),e["upload_date"].as_str().unwrap_or(""),e["duration"].as_f64().unwrap_or(0.)])?;
        queue::insert(&tx, &id, title, "download", device, source["diarize"] != 0)?;
        added += 1;
    }
    tx.commit()?;
    Ok(added)
}
fn missing_tab(error: &str) -> bool {
    [
        "does not have a videos tab",
        "does not have a streams tab",
        "does not have a shorts tab",
    ]
    .iter()
    .any(|m| error.contains(m))
}
pub(super) fn listing(text: &str) -> Result<Vec<Value>> {
    let data: Value =
        serde_json::from_str(text.trim()).context("YouTube returned unreadable source metadata")?;
    Ok(
        if data.get("entries").is_some() || data["_type"] == "playlist" {
            data["entries"].as_array().cloned().unwrap_or_default()
        } else {
            vec![data]
        },
    )
}
fn youtube(root: &Path, control: &Control, source: &Value, full: bool) -> Result<usize> {
    let cfg = config(root)?;
    let mut entries = vec![];
    let mut seen = HashSet::new();
    let mut failures = vec![];
    for url in download::scan_urls(
        source["url"].as_str().unwrap_or(""),
        source["include_shorts"] == 1,
    )? {
        let mut cmd = download::command(root, &cfg);
        cmd.args([
            "--flat-playlist",
            "--dump-single-json",
            "--skip-download",
            "--ignore-errors",
        ]);
        if !full {
            cmd.args(["--playlist-end", "20"]);
        }
        cmd.arg("--").arg(&url);
        match subprocess::capture(
            root,
            &control.scanner,
            cmd,
            None,
            Duration::from_secs(if full { 1800 } else { 180 }),
        ) {
            Ok(output) => {
                if !output.success {
                    if missing_tab(&output.error) {
                        continue;
                    }
                    failures.push(output.error.clone());
                }
                match listing(&output.text) {
                    Ok(list) => {
                        for entry in list {
                            if let Some(id) = download::video_id(&entry) {
                                if seen.insert(id.to_owned()) {
                                    entries.push(entry);
                                }
                            }
                        }
                    }
                    Err(e) if output.success => failures.push(format!("{e:#}")),
                    Err(_) => {}
                }
            }
            Err(e) => {
                if control.scanner.is_cancelled() {
                    return Err(e);
                }
                failures.push(format!("{e:#}"));
            }
        }
    }
    // Flat playlist dates can be absent. Reversing YouTube's newest-first listing
    // processes older entries first without inventing dates; download fills real metadata.
    entries.reverse();
    let added = ingest(root, source, &entries, &cfg.device)?;
    if !failures.is_empty() {
        anyhow::bail!(
            "Queued {added} recordings; some source tabs could not be checked: {}",
            failures.join("\n")
        );
    }
    Ok(added)
}
pub fn start(root: PathBuf, control: Arc<Control>, id: Option<String>, full: bool) -> Result<()> {
    start_filtered(root,control,id,full,String::new())
}
pub fn start_filtered(root: PathBuf, control: Arc<Control>, id: Option<String>, full: bool, category: String) -> Result<()> {
    anyhow::ensure!(["", "personal", "work"].contains(&category.as_str()), "Unknown category");
    anyhow::ensure!(
        !control.closing.load(Ordering::SeqCst),
        "Concord is closing"
    );
    if control.checking.swap(true, Ordering::SeqCst) {
        anyhow::bail!("A source check is already running");
    }
    control.scanner.begin();
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let sources = if let Some(id) = id {
                vec![source(&root, &id)?]
            } else {
                list(&root)?
                    .into_iter()
                    .filter(|s| s["enabled"] == 1 && (category.is_empty() || s["category"] == category))
                    .collect()
            };
            for source in sources {
                if control.scanner.is_cancelled() {
                    break;
                }
                if source["kind"] == "collection" {
                    continue;
                }
                let id = source["id"].as_str().unwrap();
                db::open(&root)?.execute("UPDATE channels SET check_status='checking',check_message='Checking for recordings' WHERE id=?1",[id])?;
                let result = if source["kind"] == "folder" {
                    local(&root, &control, &source)
                } else {
                    youtube(&root, &control, &source, full)
                };
                let (status, message) = match result {
                    Ok(n) => ("complete", format!("{n} new recordings queued")),
                    Err(_) if control.scanner.is_cancelled() => {
                        ("cancelled", "Source check stopped".into())
                    }
                    Err(e) => ("failed", format!("{e:#}")),
                };
                db::open(&root)?.execute("UPDATE channels SET check_status=?1,check_message=?2,last_check=?3 WHERE id=?4",params![status,message,now(),id])?;
                runtime_log::push(
                    if status == "failed" { "error" } else { "info" },
                    &format!(
                        "Source {}: {message}",
                        source["name"].as_str().unwrap_or("")
                    ),
                );
            }
            Ok(())
        })();
        if let Err(e) = result {
            runtime_log::push("error", &format!("Source check: {e:#}"));
        }
        control.scanner.busy.store(false, Ordering::SeqCst);
        control.checking.store(false, Ordering::SeqCst);
    });
    Ok(())
}
pub fn monitor(root: PathBuf, control: Arc<Control>) {
    std::thread::spawn(move || {
        while !control.closing.load(Ordering::SeqCst) {
            if !control.checking.load(Ordering::SeqCst) {
                let result = (|| -> Result<()> {
                    let cfg = config(&root)?;
                    if !cfg.automatic_checks || !running(&db::open(&root)?)? {
                        return Ok(());
                    }
                    let due = list(&root)?.into_iter().find(|s| {
                        s["enabled"] == 1
                            && s["kind"] != "collection"
                            && s["last_check"].as_i64().unwrap_or(0)
                                + i64::from(cfg.check_minutes) * 60
                                <= now()
                    });
                    if let Some(s) = due {
                        start(
                            root.clone(),
                            control.clone(),
                            Some(s["id"].as_str().unwrap().into()),
                            false,
                        )?;
                    }
                    Ok(())
                })();
                if let Err(e) = result {
                    runtime_log::push("warn", &format!("Subscription scheduler: {e:#}"));
                }
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

/// Recover the old download preferences without enabling background subscriptions.
pub fn seed(root: &Path) -> Result<()> {
    let db = db::open(root)?;
    db.execute(
        "UPDATE channels SET kind='collection' WHERE url='' AND kind='youtube'",
        [],
    )?;
    let done: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key='pipeline.downloadsImported')",
        [],
        |r| r.get(0),
    )?;
    if done {
        return Ok(());
    }
    let legacy: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='imported_from'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(legacy) = legacy.filter(|p| Path::new(p).is_file()) else {
        return Ok(());
    };
    let old =
        rusqlite::Connection::open_with_flags(legacy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let exists: bool = old.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='app_config')",
        [],
        |r| r.get(0),
    )?;
    if exists {
        let get = |key: &str| {
            old.query_row("SELECT value FROM app_config WHERE key=?1", [key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten()
        };
        let mut cfg = config(root)?;
        if let Some(dir) = get("videoSaveDir").filter(|p| Path::new(p).is_absolute()) {
            cfg.download_directory = dir;
        }
        if let Some(q) = get("videoQuality").filter(|s| {
            ["best", "4320", "2160", "1440", "1080", "720", "480", "360"].contains(&s.as_str())
        }) {
            cfg.quality = q;
        }
        if let Some(q) =
            get("videoCodec").filter(|s| ["any", "avc1", "av01", "vp9"].contains(&s.as_str()))
        {
            cfg.codec = q;
        }
        if let Some(q) = get("youtubeSpeedPreset")
            .filter(|s| ["conservative", "balanced", "fast"].contains(&s.as_str()))
        {
            cfg.speed = q;
        }
        if let Some(n) = get("dailyDownloadCap")
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| (1..=10000).contains(n))
        {
            cfg.daily_limit = n;
        }
        if let Some(n) = get("checkIntervalMinutes")
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| (5..=10080).contains(n))
        {
            cfg.check_minutes = n;
        }
        save_config(root, &cfg)?;
    }
    db.execute(
        "INSERT OR IGNORE INTO settings VALUES ('pipeline.downloadsImported','1')",
        [],
    )?;
    Ok(())
}
