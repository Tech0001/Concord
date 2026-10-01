use super::{config, now, running, set_running, validate_device, Control};
use crate::db;
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, sync::atomic::Ordering};

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Batch {
    pub category: String,
    pub ids: Vec<String>,
    pub channel: String,
    pub query: String,
    pub missing_only: bool,
    pub device: String,
}
fn selected(db: &Connection, batch: &Batch) -> Result<Vec<Value>> {
    let ids: HashSet<_> = batch.ids.iter().collect();
    Ok(db::rows(
        db,
        "SELECT m.id,m.title,m.channel,m.date,m.path,m.transcript,m.status,m.duration,COALESCE(c.diarize,1) AS diarize FROM media m LEFT JOIN channels c ON c.id=m.source_id
        WHERE (?1='' OR m.channel=?1) AND (?2='' OR m.title LIKE ?3 ESCAPE '\\') AND (?4='' OR m.category=?4) ORDER BY replace(m.date,'-',''),m.id",
        params![batch.channel, batch.query, db::like_pattern(&batch.query), batch.category],
    )?
    .into_iter()
    .filter(|m| ids.is_empty() || ids.contains(&m["id"].as_str().unwrap_or_default().to_owned()))
    .filter(|m| {
        !batch.missing_only || !Path::new(m["transcript"].as_str().unwrap_or_default()).is_file()
    })
    .collect())
}
fn available(m: &Value) -> bool {
    Path::new(m["path"].as_str().unwrap_or_default()).is_file()
}
pub fn candidates(root: &Path, batch: &Batch) -> Result<Value> {
    let db = db::open(root)?;
    let items = selected(&db, batch)?;
    let active: HashSet<String> = {
        let mut q = db.prepare(
            "SELECT media_id FROM jobs WHERE status IN ('queued','running','retry','waiting_live')",
        )?;
        let ids = q
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        ids
    };
    let eligible: Vec<_> = items
        .iter()
        .filter(|m| available(m) && !active.contains(m["id"].as_str().unwrap()))
        .collect();
    Ok(
        json!({"total":items.len(),"eligible":eligible.len(),"unavailable":items.iter().filter(|m|!available(m)).count(),"alreadyQueued":items.iter().filter(|m|active.contains(m["id"].as_str().unwrap())).count(),
        "hours":eligible.iter().map(|m|m["duration"].as_f64().unwrap_or(0.)).sum::<f64>()/3600.,"items":items}),
    )
}
pub fn enqueue(root: &Path, control: &Control, batch: &Batch, start: bool) -> Result<Value> {
    let _guard = control.gate.lock().unwrap();
    let device = if batch.device.is_empty() {
        config(root)?.device
    } else {
        batch.device.clone()
    };
    validate_device(&device)?;
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let items = selected(&tx, batch)?;
    let mut added = Vec::new();
    let mut unavailable = 0;
    let mut existing = 0;
    for m in items {
        if !available(&m) {
            unavailable += 1;
            continue;
        }
        if let Some(id) = insert(
            &tx,
            m["id"].as_str().unwrap(),
            m["title"].as_str().unwrap(),
            "transcribe",
            &device,
            m["diarize"] != 0,
        )? {
            added.push(id);
        } else {
            existing += 1;
        }
    }
    if start && !added.is_empty() {
        set_running(&tx, true)?;
    }
    tx.commit()?;
    crate::runtime_log::push("info",&format!("Queued {} recordings for transcription; {unavailable} unavailable, {existing} already queued",added.len()));
    Ok(json!({"added":added.len(),"ids":added,"unavailable":unavailable,"alreadyQueued":existing}))
}
fn media_state(db: &Connection, job: &str) -> Result<()> {
    db.execute("UPDATE media SET status=COALESCE((SELECT CASE j.status WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN CASE WHEN media.path IS NULL THEN 'cancelled' ELSE 'ready' END WHEN 'queued' THEN 'pending' WHEN 'retry' THEN 'pending' WHEN 'waiting_live' THEN 'pending' ELSE media.status END FROM jobs j WHERE j.id=?1),status) WHERE id=(SELECT media_id FROM jobs WHERE id=?1) AND transcript IS NULL",[job])?;
    Ok(())
}
pub(super) fn insert(
    db: &Connection,
    media: &str,
    title: &str,
    kind: &str,
    device: &str,
    diarize: bool,
) -> Result<Option<String>> {
    let id = uuid::Uuid::new_v4().to_string();
    let n=db.execute("INSERT OR IGNORE INTO jobs(id,media_id,title,status,message) VALUES (?1,?2,?3,'queued','Waiting in the processing queue')",params![id,media,title])?;
    if n == 0 {
        return Ok(None);
    }
    db.execute(
        "INSERT INTO pipeline_work(id,kind,device,diarize) VALUES (?1,?2,?3,?4)",
        params![id, kind, device, diarize],
    )?;
    media_state(db, &id)?;
    Ok(Some(id))
}
pub fn snapshot(root: &Path) -> Result<Value> {
    let db = db::open(root)?;
    Ok(
        json!({"running":running(&db)?,"config":config(root)?,"sources":super::sources::list(root)?,"overview":super::overview(root)?,
        "jobs":db::rows(&db,"SELECT j.*,p.kind,p.diarize,p.device,p.attempts,p.retry_at,p.finished_at,p.cancelled,m.channel,m.path FROM pipeline_work p JOIN jobs j ON j.id=p.id JOIN media m ON m.id=j.media_id ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'retry' THEN 2 ELSE 3 END,j.rowid",[])?,
        "channels":db::rows(&db,"SELECT DISTINCT channel FROM media ORDER BY channel",[])?}),
    )
}
pub fn action(root: &Path, control: &Control, action: &str, id: Option<&str>) -> Result<()> {
    let active = control.gate.lock().unwrap();
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    match action {
        "start" => set_running(&tx, true)?,
        "pause" => set_running(&tx, false)?,
        "stop" => {
            control.scanner.cancel();
            set_running(&tx, false)?;
            if let Some(id) = active.as_deref() {
                tx.execute("UPDATE pipeline_work SET cancelled=1 WHERE id=?1", [id])?;
                control.speech.cancel();
            }
        }
        "cancel" => {
            let id = id.context("Choose a queue item")?;
            tx.execute("UPDATE pipeline_work SET cancelled=1 WHERE id=?1", [id])?;
            if active.as_deref() == Some(id) {
                control.speech.cancel();
            } else {
                let changed=tx.execute("UPDATE jobs SET status='cancelled',message='Removed from the queue' WHERE id=?1 AND status IN ('queued','retry','waiting_live')",[id])?;
                if changed > 0 {
                    media_state(&tx, id)?;
                }
            }
        }
        "cancel-pending" => {
            let pending=db::rows(&tx,"SELECT id FROM jobs WHERE status IN ('queued','retry','waiting_live') AND id IN (SELECT id FROM pipeline_work)",[])?;
            tx.execute("UPDATE pipeline_work SET cancelled=1 WHERE id IN (SELECT id FROM jobs WHERE status IN ('queued','retry','waiting_live'))",[])?;
            tx.execute("UPDATE jobs SET status='cancelled',message='Removed from the queue' WHERE id IN (SELECT id FROM pipeline_work) AND status IN ('queued','retry','waiting_live')",[])?;
            for row in pending {
                media_state(&tx, row["id"].as_str().unwrap())?;
            }
        }
        "retry" => {
            let id = id.context("Choose a queue item")?;
            let changed=tx.execute("UPDATE jobs SET status='queued',message='Waiting to retry' WHERE id=?1 AND id IN (SELECT id FROM pipeline_work) AND status IN ('failed','cancelled','interrupted')",[id])?;
            anyhow::ensure!(
                changed == 1,
                "This job is not retryable, or the recording is already queued"
            );
            tx.execute("UPDATE pipeline_work SET attempts=0,retry_at=0,cancelled=0,finished_at=NULL WHERE id=?1",[id])?;
            media_state(&tx, id)?;
        }
        "clear" => {
            tx.execute("DELETE FROM jobs WHERE id IN (SELECT id FROM pipeline_work) AND status IN ('complete','failed','cancelled','interrupted')",[])?;
        }
        _ => anyhow::bail!("Unknown queue action"),
    }
    tx.commit()?;
    // Keep the mutex held through the commit so a cancelled job cannot be claimed.
    Ok(())
}
pub fn recover(root: &Path) -> Result<()> {
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    tx.execute("UPDATE jobs SET status='cancelled',message='Cancelled before Concord closed' WHERE id IN (SELECT id FROM pipeline_work WHERE cancelled=1) AND status IN ('running','queued','retry','waiting_live')",[])?;
    tx.execute("UPDATE pipeline_work SET attempts=max(0,attempts-1) WHERE id IN (SELECT id FROM jobs WHERE status IN ('running','interrupted'))",[])?;
    tx.execute("UPDATE jobs SET status='queued',message='Resuming after Concord closed; the previous transcript is preserved' WHERE status IN ('running','interrupted') AND id IN (SELECT id FROM pipeline_work WHERE cancelled=0)",[])?;
    tx.execute("UPDATE channels SET check_status='interrupted',check_message='Source check was interrupted; check again to continue' WHERE check_status='checking'",[])?;
    tx.commit()?;
    Ok(())
}
pub(super) fn claim(root: &Path, at: i64) -> Result<Option<Value>> {
    let cfg = config(root)?;
    let downloads_ready = super::downloader::available(root);
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if !running(&tx)? {
        return Ok(None);
    }
    let limited = super::download::daily_count(&tx)? >= cfg.daily_limit;
    let rows=db::rows(&tx,"SELECT j.*,p.kind,p.diarize,p.device,p.attempts,m.path,m.url,m.source_id FROM jobs j JOIN pipeline_work p ON p.id=j.id JOIN media m ON m.id=j.media_id WHERE p.cancelled=0 AND (j.status='queued' OR (j.status IN ('retry','waiting_live') AND p.retry_at<=?1)) ORDER BY j.rowid",[at])?;
    if !downloads_ready {
        for r in rows
            .iter()
            .filter(|r| r["kind"] == "download" && !available(r))
        {
            tx.execute("UPDATE jobs SET message='Waiting for YouTube downloads to be enabled in Settings' WHERE id=?1",[r["id"].as_str()])?;
        }
    }
    let row = rows
        .into_iter()
        .find(|r| r["kind"] != "download" || available(r) || (downloads_ready && !limited));
    if let Some(row) = &row {
        let id = row["id"].as_str().unwrap();
        tx.execute(
            "UPDATE jobs SET status='running',message='Preparing recording' WHERE id=?1",
            [id],
        )?;
        tx.execute(
            "UPDATE pipeline_work SET attempts=attempts+1 WHERE id=?1",
            [id],
        )?;
    }
    tx.commit()?;
    Ok(row)
}
pub(super) fn finish(
    root: &Path,
    id: &str,
    result: Result<()>,
    control: &Control,
    at: i64,
) -> Result<()> {
    let cfg = config(root)?;
    let downloads_enabled = super::downloader::enabled(root)?;
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (attempts, cancelled): (u32, bool) = tx.query_row(
        "SELECT attempts,cancelled FROM pipeline_work WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let closing = control.closing.load(Ordering::SeqCst);
    // Publication is atomic. If it completed just before cancellation, report success.
    let (status, message) = match result {
        Ok(()) => ("complete", "Transcript and speakers are ready".into()),
        Err(_) if cancelled => (
            "cancelled",
            "Cancelled; the previous transcript is preserved".into(),
        ),
        Err(_) if closing => (
            "queued",
            "Resuming after Concord closed; the previous transcript is preserved".into(),
        ),
        Err(_)
            if !downloads_enabled
                && control.speech.is_cancelled()
                && tx.query_row(
                    "SELECT kind='download' FROM pipeline_work WHERE id=?1",
                    [id],
                    |r| r.get::<_, bool>(0),
                )? =>
        {
            (
                "queued",
                "Waiting for YouTube downloads to be enabled in Settings".into(),
            )
        }
        Err(e) if attempts <= cfg.retries => (
            "retry",
            format!(
                "{e:#}\nRetrying in {} minutes (attempt {attempts} of {})",
                cfg.retry_minutes,
                cfg.retries + 1
            ),
        ),
        Err(e) => ("failed", format!("{e:#}")),
    };
    tx.execute(
        "UPDATE jobs SET status=?1,message=?2 WHERE id=?3",
        params![status, message, id],
    )?;
    tx.execute("UPDATE pipeline_work SET retry_at=?1,finished_at=CASE WHEN ?2 IN ('complete','failed','cancelled') THEN datetime('now') ELSE NULL END WHERE id=?3",params![at+i64::from(cfg.retry_minutes)*60,status,id])?;
    if status == "queued" {
        tx.execute(
            "UPDATE pipeline_work SET attempts=max(0,attempts-1) WHERE id=?1",
            [id],
        )?;
    }
    media_state(&tx, id)?;
    if status == "complete" {
        tx.execute_batch("SAVEPOINT automatic_ai")?;
        if let Err(e) = crate::ai::automation::enqueue(&tx, id) {
            tx.execute_batch("ROLLBACK TO automatic_ai")?;
            crate::runtime_log::push(
                "error",
                &format!("Transcript saved but automatic AI could not be queued: {e:#}"),
            );
        }
        tx.execute_batch("RELEASE automatic_ai")?;
    }
    tx.commit()?;
    crate::runtime_log::push(
        if status == "failed" { "error" } else { "info" },
        &format!("Queue {id}: {status} · {message}"),
    );
    Ok(())
}
pub fn enqueue_one(root: &Path, control: &Control, id: String, device: String) -> Result<String> {
    let media = db::media(root, &id)?;
    if media["path"].is_null()
        && super::download::youtube_url(media["url"].as_str().unwrap_or("")).is_ok()
    {
        validate_device(&device)?;
        let _guard = control.gate.lock().unwrap();
        let mut db = db::open(root)?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let diarize: bool = tx.query_row(
            "SELECT COALESCE((SELECT diarize FROM channels WHERE id=?1),1)",
            [media["source_id"].as_str()],
            |r| r.get(0),
        )?;
        let job = insert(
            &tx,
            &id,
            media["title"].as_str().unwrap(),
            "download",
            &device,
            diarize,
        )?
        .context("This recording is already queued")?;
        set_running(&tx, true)?;
        tx.commit()?;
        return Ok(job);
    }
    let r = enqueue(
        root,
        control,
        &Batch {
            ids: vec![id],
            device,
            ..Default::default()
        },
        true,
    )?;
    r["ids"][0]
        .as_str()
        .map(str::to_owned)
        .context("This recording is already queued or its media file is unavailable")
}
pub const WAITING_FOR_SPEECH: &str = "Waiting for the speech engine to finish installing";
/// Leave queued work in place while speech is missing, so it starts once setup finishes.
pub(super) fn wait_for_speech(root: &Path) -> Result<()> {
    db::open(root)?.execute(
        "UPDATE jobs SET message=?1 WHERE status='queued' AND message<>?1 AND id IN (SELECT id FROM pipeline_work)",
        [WAITING_FOR_SPEECH],
    )?;
    Ok(())
}
/// Speech setup failed, so work waiting for it fails with the reason instead of waiting forever.
pub(super) fn fail_waiting_for_speech(root: &Path, message: &str) -> Result<()> {
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    let waiting = "SELECT id FROM jobs WHERE status='queued' AND message=?1 AND id IN (SELECT id FROM pipeline_work)";
    tx.execute(
        &format!("UPDATE pipeline_work SET finished_at=datetime('now') WHERE id IN ({waiting})"),
        [WAITING_FOR_SPEECH],
    )?;
    tx.execute(
        &format!("UPDATE jobs SET status='failed',message=?2 WHERE id IN ({waiting})"),
        params![WAITING_FOR_SPEECH, message],
    )?;
    tx.commit()?;
    Ok(())
}
pub(super) fn tick_time() -> i64 {
    now()
}
pub(super) fn wait_for_live(root: &Path, id: &str, at: i64) -> Result<()> {
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    tx.execute("UPDATE jobs SET status='waiting_live',message='Live or scheduled video; checking again in 5 minutes' WHERE id=?1",[id])?;
    tx.execute(
        "UPDATE pipeline_work SET attempts=max(0,attempts-1),retry_at=?1 WHERE id=?2",
        params![at + 300, id],
    )?;
    tx.commit()?;
    Ok(())
}
