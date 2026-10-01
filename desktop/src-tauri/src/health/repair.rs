use super::Control;
use crate::{db, runtime_log, thumbnail, transcript::Segment};
use anyhow::{ensure, Context, Result};
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
};
fn seconds(s: &str) -> Option<f64> {
    let p = s
        .trim()
        .split(':')
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if !(2..=3).contains(&p.len()) || p.iter().any(|x| !x.is_finite() || *x < 0.) {
        return None;
    }
    Some(p.into_iter().fold(0., |n, p| n * 60. + p))
}
pub fn parse(path: &Path) -> Result<Vec<Segment>> {
    // A readable source is required even if a JSON sidecar exists.
    let markdown = std::fs::read_to_string(path)?;
    let sidecar = path.with_extension("json");
    if let Ok(text) = std::fs::read_to_string(sidecar) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Ok(segments) = serde_json::from_value::<Vec<Segment>>(v["segments"].clone()) {
                let valid: Vec<_> = segments.into_iter().filter(valid).collect();
                if !valid.is_empty() {
                    return Ok(valid);
                }
            }
        }
    }
    let mut segments = Vec::new();
    for line in markdown.lines() {
        let Some(rest) = line.trim().strip_prefix("- [") else {
            continue;
        };
        let Some((range, raw)) = rest.split_once(']') else {
            continue;
        };
        let Some((start, end)) = range
            .split_once('→')
            .or_else(|| range.split_once("->"))
            .or_else(|| range.split_once('-'))
        else {
            continue;
        };
        let (Some(start), Some(end)) = (seconds(start), seconds(end)) else {
            continue;
        };
        let mut text = raw.trim().to_string();
        let mut speaker = None;
        if let Some(bold) = text.strip_prefix("**") {
            if let Some((name, body)) = bold.split_once(":**") {
                speaker = Some(name.to_string());
                text = body.trim().to_string();
            }
        }
        let segment = Segment {
            start,
            end,
            text,
            speaker,
        };
        if valid(&segment) {
            segments.push(segment);
        }
    }
    ensure!(
        !segments.is_empty(),
        "No readable timed passages; existing search data was preserved"
    );
    Ok(segments)
}
fn valid(s: &Segment) -> bool {
    s.start.is_finite()
        && s.end.is_finite()
        && s.start >= 0.
        && s.end >= s.start
        && !s.text.trim().is_empty()
}
pub fn reindex(root: &Path, id: &str) -> Result<usize> {
    let row = db::media(root, id)?;
    let path = Path::new(row["transcript"].as_str().context("No transcript path")?);
    let stamp = super::stamp(path)?;
    let segments = parse(path)?;
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    let current: String = tx.query_row("SELECT transcript FROM media WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    ensure!(
        current == path.to_string_lossy() && super::stamp(path)? == stamp,
        "Transcript changed while indexing; try again"
    );
    tx.execute("DELETE FROM segments WHERE media_id=?1", [id])?;
    for s in &segments {
        tx.execute(
            "INSERT INTO segments(media_id,start,end,speaker,text) VALUES (?1,?2,?3,?4,?5)",
            params![id, s.start, s.end, s.speaker, s.text],
        )?;
    }
    tx.execute(
        "DELETE FROM ai_sources WHERE kind='recording' AND source_id=?1",
        [id],
    )?;
    // Keep human speaker labels and fingerprints; add only previously unseen local labels.
    for s in &segments {
        if let Some(local) = &s.speaker {
            tx.execute(
                "INSERT OR IGNORE INTO assignments(media_id,local_id) VALUES (?1,?2)",
                params![id, local],
            )?;
        }
    }
    super::indexed(&tx, id, path)?;
    tx.commit()?;
    Ok(segments.len())
}
pub fn fingerprint(root: &Path, id: &str) -> Result<()> {
    let row = db::media(root, id)?;
    let path = Path::new(row["path"].as_str().context("No media file")?);
    let (bytes, mtime) = super::stamp(path)?;
    let mut file = std::fs::File::open(path)?;
    let count = bytes.min(1024 * 1024) as usize;
    let mut first = vec![0; count];
    let mut last = vec![0; count];
    file.read_exact(&mut first)?;
    file.seek(SeekFrom::Start(bytes.saturating_sub(count as u64)))?;
    file.read_exact(&mut last)?;
    ensure!(
        super::stamp(path)? == (bytes, mtime),
        "File changed while fingerprinting"
    );
    let mut hash = Sha256::new();
    hash.update(format!("{bytes}\0"));
    hash.update(first);
    hash.update(last);
    let digest = format!("{:x}", hash.finalize());
    db::open(root)?.execute("INSERT INTO media_fingerprints VALUES (?1,?2,?3,?4,?5) ON CONFLICT(media_id) DO UPDATE SET path=excluded.path,bytes=excluded.bytes,mtime=excluded.mtime,fingerprint=excluded.fingerprint",params![id,path.to_string_lossy(),bytes,mtime,digest])?;
    Ok(())
}
pub fn start(
    root: PathBuf,
    control: Arc<Control>,
    generator: Arc<Mutex<()>>,
    action: String,
) -> Result<String> {
    ensure!(
        ["reindex", "thumbnails", "fingerprints", "cleanup"].contains(&action.as_str()),
        "Unknown archive repair"
    );
    ensure!(
        !control.busy.swap(true, Ordering::SeqCst),
        "Another archive repair is already running"
    );
    control.cancel.store(false, Ordering::SeqCst);
    let job = uuid::Uuid::new_v4().to_string();
    if let Err(e)=db::open(&root).and_then(|db|Ok(db.execute("INSERT INTO maintenance_jobs(id,action,status,message) VALUES (?1,?2,'running','Preparing repair')",params![job,action])?)){control.busy.store(false,Ordering::SeqCst);return Err(e);}
    let id = job.clone();
    std::thread::spawn(move || {
        runtime_log::push("info", &format!("Archive repair started: {action}"));
        let result = run(&root, &control, &generator, &id, &action);
        let cancelled = control.cancel.load(Ordering::SeqCst);
        let (status, message) = if cancelled {
            (
                "cancelled",
                "Stopped. Completed items are kept; run the repair again to resume.".into(),
            )
        } else {
            match result {
                Ok((done, failed)) => {
                    if failed > 0 {
                        (
                            "failed",
                            format!("{done} checked; {failed} items need attention"),
                        )
                    } else {
                        ("complete", format!("{done} items checked"))
                    }
                }
                Err(e) => ("failed", format!("{e:#}")),
            }
        };
        if let Ok(db) = db::open(&root) {
            let _ = db.execute(
                "UPDATE maintenance_jobs SET status=?2,message=?3 WHERE id=?1",
                params![id, status, message],
            );
        }
        runtime_log::push(
            if status == "failed" { "error" } else { "info" },
            &format!("Archive {action}: {message}"),
        );
        control.busy.store(false, Ordering::SeqCst);
    });
    Ok(job)
}
fn run(
    root: &Path,
    control: &Control,
    generator: &Mutex<()>,
    job: &str,
    action: &str,
) -> Result<(usize, usize)> {
    let db = db::open(root)?;
    if action == "cleanup" {
        let n=db.execute("DELETE FROM segments WHERE media_id NOT IN (SELECT id FROM media)",[])?+db.execute("DELETE FROM ai_sources WHERE (kind='recording' AND source_id NOT IN (SELECT id FROM media)) OR (kind='document' AND source_id NOT IN (SELECT id FROM docs)) OR (kind='note' AND source_id NOT IN (SELECT id FROM notes))",[])?;
        db.execute(
            "UPDATE maintenance_jobs SET total=?2,done=?2 WHERE id=?1",
            params![job, n],
        )?;
        return Ok((n, 0));
    }
    let report = super::report::audit(root)?;
    let issue = match action {
        "reindex" => "stale-fts",
        "thumbnails" => "thumbnails",
        _ => "unhashed",
    };
    let items = report["issues"]
        .as_array()
        .and_then(|v| v.iter().find(|i| i["id"] == issue))
        .and_then(|v| v["items"].as_array())
        .cloned()
        .unwrap_or_default();
    db.execute(
        "UPDATE maintenance_jobs SET total=?2 WHERE id=?1",
        params![job, items.len()],
    )?;
    let mut failed = Vec::new();
    let mut done = 0;
    for item in &items {
        ensure!(!control.cancel.load(Ordering::SeqCst), "Cancelled");
        let id = item["id"].as_str().unwrap();
        let title = item["title"].as_str().unwrap_or("Recording");
        db.execute(
            "UPDATE maintenance_jobs SET message=?2 WHERE id=?1",
            params![job, format!("{} / {} · {title}", done + 1, items.len())],
        )?;
        let result = match action {
            "reindex" => reindex(root, id).map(|_| ()),
            "thumbnails" => thumbnail::resolve(root, id, generator)
                .and_then(|v| v.context("Unable to create thumbnail").map(|_| ())),
            _ => fingerprint(root, id),
        };
        if let Err(e) = result {
            failed.push(json!({"id":id,"title":title,"error":format!("{e:#}")}));
        }
        done += 1;
        db.execute(
            "UPDATE maintenance_jobs SET done=?2,failed=?3,details=?4 WHERE id=?1",
            params![job, done, failed.len(), serde_json::to_string(&failed)?],
        )?;
    }
    Ok((done, failed.len()))
}
