use super::{config, download, now, queue, running, save_config, subprocess, Control};
use crate::{db, runtime_log};
use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
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
/// Whether this source is the one a running check is working on. Others can change meanwhile.
fn being_checked(root: &Path, control: &Control, id: Option<&str>) -> Result<bool> {
    let Some(id) = id else { return Ok(false) };
    if !control.checking.load(Ordering::SeqCst) {
        return Ok(false);
    }
    Ok(db::open(root)?.query_row("SELECT EXISTS(SELECT 1 FROM channels WHERE id=?1 AND check_status='checking')", [id], |r| r.get(0))?)
}
pub fn save(root: &Path, control: &Control, input: &Source) -> Result<String> {
    anyhow::ensure!(
        !being_checked(root, control, input.id.as_deref())?,
        "Wait for this check to finish, or stop it, before changing it"
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
                "This folder is inside, or contains, {}, which Concord already has as a folder",
                source["name"].as_str().unwrap_or("another folder")
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
        !being_checked(root, control, Some(id))?,
        "Stop this check before removing it"
    );
    control.waiting_checks.lock().unwrap().retain(|w| w != id);
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    tx.execute("UPDATE media SET source_id=NULL WHERE source_id=?1", [id])?;
    tx.execute("DELETE FROM source_seen WHERE source_id=?1", [id])?;
    tx.execute("DELETE FROM channels WHERE id=?1", [id])?;
    tx.commit()?;
    Ok(())
}
pub fn source(root: &Path, id: &str) -> Result<Value> {
    db::rows(&db::open(root)?, "SELECT * FROM channels WHERE id=?1", [id])?
        .pop()
        .context("Source no longer exists")
}
const MEDIA: [&str; 12] = ["mp4", "mkv", "webm", "mov", "ogg", "oga", "wav", "mp3", "m4a", "flac", "aac", "opus"];
fn is_media(path: &Path) -> bool {
    MEDIA.contains(&path.extension().unwrap_or_default().to_string_lossy().to_lowercase().as_str())
}
fn files(folder: &Path, out: &mut Vec<PathBuf>, cancel: &crate::speech::Control) -> Result<()> {
    for entry in std::fs::read_dir(folder)? {
        anyhow::ensure!(!cancel.is_cancelled(), "Cancelled");
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') || kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files(&path, out, cancel)?;
        } else if kind.is_file()
            && is_media(&path)
            && entry.metadata()?.len() > 0
        {
            out.push(path.canonicalize()?);
        }
    }
    Ok(())
}
pub(super) fn local(root: &Path, control: &Control, source: &Value) -> Result<usize> {
    local_with(root, &control.scanner, source)
}
/// Scan a folder source with its own cancel switch, so a stopped check elsewhere can't stop it.
fn local_with(root: &Path, cancel: &crate::speech::Control, source: &Value) -> Result<usize> {
    scan_into(
        root,
        cancel,
        Path::new(source["url"].as_str().context("Source missing its folder")?),
        source["id"].as_str(),
        source["name"].as_str().unwrap_or("Recordings"),
        source["category"].as_str().unwrap_or("personal"),
        source["diarize"] != 0,
    )
}
/// Import a folder's new recordings (subfolders included) and queue them to transcribe.
fn scan_into(root: &Path, cancel: &crate::speech::Control, folder: &Path, source_id: Option<&str>, channel: &str, category: &str, diarize: bool) -> Result<usize> {
    let mut paths = vec![];
    files(folder, &mut paths, cancel)?;
    paths.sort();
    let found = paths.len();
    runtime_log::debug("Source scan", &format!("Found {found} supported media files (recursive, hidden files and symlinks excluded)"));
    let device = config(root)?.device;
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut added = 0;
    for path in paths {
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM media WHERE path=?1) OR EXISTS(SELECT 1 FROM removed_recordings WHERE path=?1)",
            [path.to_string_lossy().as_ref()],
            |r| r.get::<_, bool>(0),
        )? {
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let title = path.file_stem().unwrap_or_default().to_string_lossy();
        tx.execute("INSERT INTO media(id,title,path,channel,source_id,category,date) VALUES (?1,?2,?3,?4,?5,?6,date('now','localtime'))",params![id,title,path.to_string_lossy(),channel,source_id,category])?;
        queue::insert(&tx, &id, &title, "transcribe", &device, diarize)?;
        added += 1;
    }
    tx.commit()?;
    runtime_log::debug("Source scan", &format!("Queued {added}; skipped {} already imported or removed files", found - added));
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
    let added = ingest_tx(&tx, source, entries, device)?;
    tx.commit()?;
    Ok(added)
}
fn ingest_tx(tx: &rusqlite::Transaction, source: &Value, entries: &[Value], device: &str) -> Result<usize> {
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
            "SELECT EXISTS(SELECT 1 FROM media WHERE id=?1 OR url=?2) OR EXISTS(SELECT 1 FROM removed_recordings WHERE id=?1 OR url=?2)",
            params![id, url],
            |r| r.get(0),
        )?;
        if exists {
            continue;
        }
        let title = e["title"].as_str().unwrap_or(remote);
        tx.execute("INSERT INTO media(id,title,url,channel,source_id,category,date,duration,status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending')",params![id,title,url,source["name"].as_str(),source["id"].as_str(),source["category"].as_str(),e["upload_date"].as_str().unwrap_or(""),e["duration"].as_f64().unwrap_or(0.)])?;
        queue::insert(tx, &id, title, "download", device, source["diarize"] != 0)?;
        added += 1;
    }
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
/// One listing of a channel tab or playlist. `listed` is false when YouTube didn't list it fully.
pub struct Tab {
    pub url: String,
    pub entries: Vec<Value>,
    pub listed: bool,
}
/// How much of a tab to list. A channel tab that already has its baseline only needs its newest
/// entries; a first listing, and any playlist (often oldest first), is listed in full so nothing
/// older can later look new.
pub fn listing_limit(url: &str, baselined: bool) -> Option<u32> {
    let tab = url::Url::parse(url).is_ok_and(|u| ["/videos", "/streams", "/shorts"].iter().any(|t| u.path().ends_with(t)));
    (tab && baselined).then_some(20)
}
fn tab_marker(url: &str) -> String {
    format!("tab:{url}")
}
fn youtube(root: &Path, control: &Control, source: &Value, full: bool) -> Result<usize> {
    let cfg = config(root)?;
    let id = source["id"].as_str().context("Source missing")?;
    let followed = source["since"].as_i64().unwrap_or(0) > 0;
    let baselined: HashSet<String> = if followed {
        db::rows(&db::open(root)?, "SELECT video_id FROM source_seen WHERE source_id=?1 AND video_id LIKE 'tab:%'", [id])?
            .iter()
            .filter_map(|r| r["video_id"].as_str().map(str::to_owned))
            .collect()
    } else {
        HashSet::new()
    };
    let mut tabs = vec![];
    let mut failures = vec![];
    for url in download::scan_urls(
        source["url"].as_str().unwrap_or(""),
        source["include_shorts"] == 1,
    )? {
        let limit = if followed {
            listing_limit(&url, baselined.contains(&tab_marker(&url)))
        } else if full {
            None
        } else {
            Some(20)
        };
        let mut cmd = download::command(root, &cfg)?;
        cmd.args([
            "--flat-playlist",
            "--dump-single-json",
            "--skip-download",
            "--ignore-errors",
        ]);
        if let Some(n) = limit {
            cmd.arg("--playlist-end").arg(n.to_string());
        }
        cmd.arg("--").arg(&url);
        let mut tab = Tab { url: url.clone(), entries: vec![], listed: false };
        match subprocess::capture(
            root,
            &control.scanner,
            cmd,
            None,
            Duration::from_secs(if limit.is_none() { 1800 } else { 180 }),
        ) {
            Ok(output) => {
                if !output.success && missing_tab(&output.error) {
                    // An absent tab is a real, empty listing: its first entry later is new.
                    tab.listed = true;
                    tabs.push(tab);
                    continue;
                }
                if !output.success {
                    failures.push(output.error.clone());
                }
                match listing(&output.text) {
                    Ok(list) => {
                        tab.entries = list.into_iter().filter(|e| download::video_id(e).is_some()).collect();
                        tab.listed = output.success;
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
        tabs.push(tab);
    }
    let added = if followed {
        follow_ingest(root, source, &tabs, &cfg.device)?
    } else {
        let mut seen = HashSet::new();
        let mut entries: Vec<Value> = tabs
            .iter()
            .flat_map(|t| t.entries.iter())
            .filter(|e| download::video_id(e).is_some_and(|id| seen.insert(id.to_owned())))
            .cloned()
            .collect();
        // Flat playlist dates can be absent. Reversing YouTube's newest-first listing
        // processes older entries first without inventing dates; download fills real metadata.
        entries.reverse();
        ingest(root, source, &entries, &cfg.device)?
    };
    if !failures.is_empty() {
        anyhow::bail!(
            "Queued {added} recordings; some source tabs could not be checked: {}",
            failures.join("\n")
        );
    }
    Ok(added)
}
/// Mark a source as followed from now on: only what appears after this moment is added.
pub fn start_following(root: &Path, id: &str) -> Result<()> {
    db::open(root)?.execute("UPDATE channels SET since=?1 WHERE id=?2", params![now(), id])?;
    Ok(())
}
/// For a followed channel, each tab's first full listing records what already exists without
/// adding it; later listings add only videos not seen before. A tab that couldn't be listed
/// records nothing, so a failed check never becomes the baseline. All of it commits together.
pub fn follow_ingest(root: &Path, source: &Value, tabs: &[Tab], device: &str) -> Result<usize> {
    let id = source["id"].as_str().context("Source missing")?;
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let seen = |tx: &rusqlite::Transaction, video: &str| -> Result<bool> {
        Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM source_seen WHERE source_id=?1 AND video_id=?2)", params![id, video], |r| r.get(0))?)
    };
    let mark = |tx: &rusqlite::Transaction, video: &str| -> Result<()> {
        tx.execute("INSERT OR IGNORE INTO source_seen(source_id,video_id) VALUES (?1,?2)", params![id, video])?;
        Ok(())
    };
    let mut first = HashSet::new();
    for tab in tabs.iter().filter(|t| t.listed) {
        if !seen(&tx, &tab_marker(&tab.url))? {
            first.insert(tab.url.as_str());
        }
    }
    // Baselines first, so a video a new tab shares with an older one is never called new.
    for tab in tabs.iter().filter(|t| first.contains(t.url.as_str())) {
        for video in tab.entries.iter().filter_map(download::video_id) {
            mark(&tx, video)?;
        }
        mark(&tx, &tab_marker(&tab.url))?;
    }
    let mut fresh = vec![];
    for tab in tabs.iter().filter(|t| !first.contains(t.url.as_str())) {
        if !seen(&tx, &tab_marker(&tab.url))? {
            continue;
        }
        for entry in &tab.entries {
            let Some(video) = download::video_id(entry) else { continue };
            if !seen(&tx, video)? {
                mark(&tx, video)?;
                fresh.push(entry.clone());
            }
        }
    }
    // Newest first from YouTube; add the oldest of the new ones first.
    fresh.reverse();
    let added = ingest_tx(&tx, source, &fresh, device)?;
    tx.commit()?;
    Ok(added)
}
fn folder_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Recordings".into())
}
/// What adding a folder would bring in: its recordings and how many are already in the library.
pub fn folder_preview(root: &Path, folder: &Path) -> Result<Value> {
    anyhow::ensure!(folder.is_dir(), "That folder is unavailable");
    let mut paths = vec![];
    files(folder, &mut paths, &crate::speech::Control::default())?;
    let db = db::open(root)?;
    let mut existing = 0;
    let mut bytes = 0u64;
    for path in &paths {
        bytes += std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if db.query_row("SELECT EXISTS(SELECT 1 FROM media WHERE path=?1)", [path.to_string_lossy().as_ref()], |r| r.get::<_, bool>(0))? {
            existing += 1;
        }
    }
    Ok(json!({"name": folder_name(folder), "path": folder, "files": paths.len(), "existing": existing, "bytes": bytes}))
}
/// Add a folder's recordings now. With `watch`, the folder is followed for new recordings.
/// Add a folder's recordings now. Adding once imports them and leaves nothing behind; with
/// `watch`, the folder becomes a followed source (reusing one already set up for it).
pub fn add_folder(root: &Path, control: &Control, folder: &Path, watch: bool, category: &str, diarize: bool) -> Result<Value> {
    anyhow::ensure!(folder.is_dir(), "That folder is unavailable");
    let path = folder.canonicalize()?;
    let cancel = crate::speech::Control::default();
    let existing = list(root)?
        .into_iter()
        .find(|s| s["kind"] == "folder" && s["url"].as_str().is_some_and(|u| Path::new(u) == path));
    let id = match (existing, watch) {
        (Some(s), _) => {
            let id = s["id"].as_str().context("Source missing")?.to_owned();
            if watch {
                save(root, control, &Source {
                    id: Some(id.clone()),
                    name: s["name"].as_str().unwrap_or("Recordings").to_owned(),
                    kind: "folder".into(),
                    url: s["url"].as_str().unwrap_or("").to_owned(),
                    enabled: true,
                    diarize,
                    include_shorts: false,
                    category: category.into(),
                })?;
                if s["since"].as_i64().unwrap_or(0) == 0 {
                    start_following(root, &id)?;
                }
            }
            id
        }
        (None, true) => {
            let id = save(root, control, &Source {
                id: None,
                name: unique_name(root, &folder_name(&path))?,
                kind: "folder".into(),
                url: path.to_string_lossy().into_owned(),
                enabled: true,
                diarize,
                include_shorts: false,
                category: category.into(),
            })?;
            start_following(root, &id)?;
            id
        }
        (None, false) => {
            let added = scan_into(root, &cancel, &path, None, &folder_name(&path), category, diarize)?;
            return Ok(json!({"id": null, "name": folder_name(&path), "added": added}));
        }
    };
    let source = source(root, &id)?;
    let added = local_with(root, &cancel, &source)?;
    db::open(root)?.execute(
        "UPDATE channels SET check_status='complete',check_message=?1,last_check=?2 WHERE id=?3",
        params![format!("{added} new recordings queued"), now(), id],
    )?;
    Ok(json!({"id": id, "name": source["name"], "added": added}))
}
/// A source name not already used, adding " (2)" and so on when needed.
fn unique_name(root: &Path, base: &str) -> Result<String> {
    let base = if base.trim().is_empty() { "Recordings" } else { base.trim() };
    let taken: Vec<String> = list(root)?.iter().filter_map(|s| s["name"].as_str().map(str::to_lowercase)).collect();
    Ok((1..)
        .map(|n| if n == 1 { base.to_owned() } else { format!("{base} ({n})") })
        .find(|n| !taken.contains(&n.to_lowercase()))
        .unwrap())
}
/// Follow a channel or playlist for new videos. Following one already in the library reuses its
/// collection and updates its options.
pub fn follow(root: &Path, control: &Control, url: &str, name: &str, category: &str, diarize: bool, shorts: bool) -> Result<String> {
    let address = download::youtube_url(url)?;
    let key = |u: &str| u.trim_end_matches('/').trim_end_matches("/videos").to_lowercase();
    let existing = list(root)?
        .into_iter()
        .find(|s| s["kind"] == "youtube" && key(s["url"].as_str().unwrap_or("")) == key(address.as_str()));
    let id = match existing {
        Some(s) => {
            let id = s["id"].as_str().context("Source missing")?.to_owned();
            save(root, control, &Source {
                id: Some(id.clone()),
                name: s["name"].as_str().unwrap_or(name).to_owned(),
                kind: "youtube".into(),
                url: s["url"].as_str().unwrap_or(url).to_owned(),
                enabled: true,
                diarize,
                include_shorts: shorts,
                category: category.into(),
            })?;
            if s["since"].as_i64().unwrap_or(0) == 0 {
                start_following(root, &id)?;
            }
            id
        }
        None => {
            let id = save(root, control, &Source {
                id: None,
                name: unique_name(root, name)?,
                kind: "youtube".into(),
                url: address.to_string(),
                enabled: true,
                diarize,
                include_shorts: shorts,
                category: category.into(),
            })?;
            start_following(root, &id)?;
            id
        }
    };
    Ok(id)
}
/// Sort dropped paths into recordings, folders, and what can't be added.
pub fn inspect_paths(paths: &[String]) -> Value {
    let (mut found, mut folders, mut skipped) = (vec![], vec![], vec![]);
    for raw in paths {
        let path = Path::new(raw);
        if path.is_dir() {
            folders.push(json!({"path": path, "name": folder_name(path)}));
        } else if path.is_file() && is_media(path) {
            let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            found.push(json!({"path": path, "name": path.file_name().map(|n| n.to_string_lossy()), "bytes": bytes}));
        } else {
            skipped.push(json!(raw));
        }
    }
    json!({"files": found, "folders": folders, "skipped": skipped})
}
/// The next source to check: followed sources always, older subscriptions only with the
/// automatic-checks setting, each once per interval.
pub fn due(sources: &[Value], cfg: &super::Config, at: i64, youtube_ready: impl Fn(&Value) -> bool) -> Option<String> {
    sources
        .iter()
        .find(|s| {
            s["enabled"] == 1
                && s["kind"] != "collection"
                && (cfg.automatic_checks || s["since"].as_i64().unwrap_or(0) > 0)
                && (s["kind"] != "youtube" || youtube_ready(s))
                && s["last_check"].as_i64().unwrap_or(0) + i64::from(cfg.check_minutes) * 60 <= at
        })
        .and_then(|s| s["id"].as_str().map(str::to_owned))
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
    // Serialize check startup with filesystem changes and queue transitions.
    let gate=control.gate.lock().map_err(|_|anyhow::anyhow!("Processing lock interrupted"))?;
    {
        // The same lock the running check takes before it stops, so a request is never lost.
        let mut waiting = control.waiting_checks.lock().unwrap();
        if control.checking.load(Ordering::SeqCst) {
            let Some(id) = id else { anyhow::bail!("A source check is already running") };
            if !waiting.contains(&id) {
                db::open(&root)?.execute("UPDATE channels SET check_status='queued',check_message='Waiting for another check to finish' WHERE id=?1", [&id])?;
                waiting.push_back(id);
            }
            return Ok(());
        }
        control.checking.store(true, Ordering::SeqCst);
    }
    control.scanner.begin();
    drop(gate);
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
                check_one(&root, &control, &source, full)?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            runtime_log::push("error", &format!("Source check: {e:#}"));
        }
        // Then each check asked for meanwhile, in order, until none wait.
        while let Some(id) = next_waiting(&control) {
            let result = if control.scanner.is_cancelled() {
                db::open(&root).and_then(|db| Ok(db.execute("UPDATE channels SET check_status='cancelled',check_message='Source check stopped' WHERE id=?1", [&id])?)).map(|_| ())
            } else {
                source(&root, &id).and_then(|s| check_one(&root, &control, &s, false))
            };
            if let Err(e) = result {
                runtime_log::push("error", &format!("Source check: {e:#}"));
            }
        }
    });
    Ok(())
}
/// The next check asked for while one ran. When none wait, the check is over: it lets go
/// under the same lock `start` takes, so a request made at that moment starts a new check.
pub fn next_waiting(control: &Control) -> Option<String> {
    let mut waiting = control.waiting_checks.lock().unwrap();
    let next = waiting.pop_front();
    if next.is_none() {
        control.scanner.busy.store(false, Ordering::SeqCst);
        control.checking.store(false, Ordering::SeqCst);
    }
    next
}
fn check_one(root: &Path, control: &Control, source: &Value, full: bool) -> Result<()> {
    let id = source["id"].as_str().context("Source missing")?;
    db::open(root)?.execute("UPDATE channels SET check_status='checking',check_message='Checking for recordings' WHERE id=?1",[id])?;
    let started = std::time::Instant::now();
    runtime_log::debug("Source check", &format!("Starting {} source; full history: {full}", source["kind"].as_str().unwrap_or("unknown")));
    let result = if source["kind"] == "folder" {
        local(root, control, source)
    } else {
        let result = (|| {
            let guard=control.gate.lock().unwrap();
            super::downloader::binary(root)?;
            control.checking_youtube.store(true, Ordering::SeqCst);
            drop(guard);
            youtube(root, control, source, full)
        })();
        control.checking_youtube.store(false, Ordering::SeqCst);
        result
    };
    let (status, message) = match result {
        Ok(n) => ("complete", format!("{n} new recordings queued")),
        Err(_) if control.scanner.is_cancelled() => {
            ("cancelled", "Source check stopped".into())
        }
        Err(e) => ("failed", format!("{e:#}")),
    };
    db::open(root)?.execute("UPDATE channels SET check_status=?1,check_message=?2,last_check=?3 WHERE id=?4",params![status,message,now(),id])?;
    runtime_log::debug("Source check", &format!("Finished: {status}; elapsed {:.2}s", started.elapsed().as_secs_f64()));
    runtime_log::push(
        if status == "failed" { "error" } else { "info" },
        &format!(
            "Source {}: {message}",
            source["name"].as_str().unwrap_or("")
        ),
    );
    Ok(())
}
pub fn monitor(root: PathBuf, control: Arc<Control>) {
    std::thread::spawn(move || {
        while !control.closing.load(Ordering::SeqCst) {
            if !control.checking.load(Ordering::SeqCst) {
                let result = (|| -> Result<()> {
                    let cfg = config(&root)?;
                    if !running(&db::open(&root)?)? {
                        return Ok(());
                    }
                    if let Some(id) = due(&list(&root)?, &cfg, now(), |_| super::downloader::available(&root)) {
                        start(root.clone(), control.clone(), Some(id), false)?;
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
