//! Optional AI work after successful transcription. Speech never waits for an AI provider.
use super::{
    config::{self, Provider},
    index, summary, Control,
};
use crate::{db, runtime_log};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    kind: String,
    base_url: String,
    model: String,
    account_id: String,
}
impl From<&Provider> for Target {
    fn from(p: &Provider) -> Self {
        Self {
            kind: p.kind.clone(),
            base_url: p.base_url.clone(),
            model: p.model.clone(),
            account_id: p.account_id.clone(),
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
struct Policy {
    embedding: Option<Target>,
    summary: Option<Target>,
}
impl Policy {
    fn target(&self, action: &str) -> Option<&Target> {
        if action == "embedding" {
            self.embedding.as_ref()
        } else {
            self.summary.as_ref()
        }
    }
}
fn policy(db: &Connection) -> Result<Policy> {
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='ai.automation'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or_default())
}
fn ready(root: &Path, p: &Provider) -> bool {
    p.validate(true).is_ok()
        && (p.kind != "chatgpt" || super::chatgpt::available(root, &p.account_id))
}
pub fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS ai_followups(
        id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('embedding','summary')), target TEXT NOT NULL, transcript TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', message TEXT NOT NULL DEFAULT 'Waiting for AI processing', child_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(parent_id,action));
        CREATE INDEX IF NOT EXISTS ai_followups_status ON ai_followups(status);")?;
    Ok(())
}
pub fn state(root: &Path) -> Result<Value> {
    let db = db::open(root)?;
    let saved = policy(&db)?;
    let providers = config::read(root)?;
    let expose = |action: &str, p: &Provider| {
        json!({
            "enabled":saved.target(action).is_some(), "approved":saved.target(action),
            "current":Target::from(p), "ready":ready(root,p),
            "needsReview":saved.target(action).is_some_and(|t| *t != Target::from(p)),
            "local":p.kind=="builtin" || p.is_loopback(),
        })
    };
    let jobs = db::rows(&db,"SELECT f.*,m.title,coalesce(a.done,s.done,0) AS done,coalesce(a.total,s.total,0) AS total,
        CASE WHEN f.status='running' THEN coalesce(a.message,s.message,f.message) ELSE f.message END AS progress_message
        FROM ai_followups f JOIN media m ON m.id=f.media_id
        LEFT JOIN ai_jobs a ON f.action='embedding' AND a.id=f.child_id
        LEFT JOIN summary_jobs s ON f.action='summary' AND s.id=f.child_id
        ORDER BY CASE f.status WHEN 'running' THEN 0 WHEN 'blocked' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,f.created_at DESC,f.rowid DESC LIMIT 100",[])?;
    Ok(
        json!({"embedding":expose("embedding",&providers.embedding),"summary":expose("summary",&providers.chat),"jobs":jobs}),
    )
}
pub fn save(root: &Path, control: &Control, embedding: bool, summary: bool) -> Result<Value> {
    let _gate = control.automation_gate.lock().unwrap();
    let db = db::open(root)?;
    reconcile(&db)?;
    let providers = config::read(root)?;
    let mut saved = Policy::default();
    for (action, enabled, p) in [
        ("embedding", embedding, &providers.embedding),
        ("summary", summary, &providers.chat),
    ] {
        if enabled {
            ensure!(
                ready(root, p),
                "Configure an available {action} model in Settings first"
            );
        }
        let target = enabled.then(|| Target::from(p));
        if action == "embedding" {
            saved.embedding = target;
        } else {
            saved.summary = target;
        }
    }
    db.execute("INSERT INTO settings VALUES('ai.automation',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&saved)?])?;
    // Turning an action off cancels only automatic work, never a manually started job.
    for action in ["embedding", "summary"] {
        if saved.target(action).is_none() {
            for row in db::rows(
                &db,
                "SELECT * FROM ai_followups WHERE action=?1 AND status='running'",
                [action],
            )? {
                stop_child(control, &row);
            }
            db.execute("UPDATE ai_followups SET status='cancelled',message='Automatic action turned off' WHERE action=?1 AND status IN ('queued','blocked')",[action])?;
        }
    }
    state(root)
}
/// Called in the speech-completion transaction; no network or model work happens here.
pub fn enqueue(db: &Connection, parent: &str) -> Result<()> {
    let saved = policy(db)?;
    for action in ["embedding", "summary"] {
        if let Some(target) = saved.target(action) {
            db.execute("INSERT OR IGNORE INTO ai_followups(id,parent_id,media_id,action,target,transcript)
                SELECT ?1,j.id,j.media_id,?2,?3,m.transcript FROM jobs j JOIN media m ON m.id=j.media_id
                WHERE j.id=?4 AND j.status='complete' AND m.transcript IS NOT NULL",
                params![uuid::Uuid::new_v4().to_string(),action,serde_json::to_string(target)?,parent])?;
        }
    }
    Ok(())
}
/// Link the child job atomically with its creation, before its worker starts.
pub(super) fn attach(db: &Connection, followup: Option<&str>, child: &str) -> Result<()> {
    if let Some(id) = followup {
        ensure!(db.execute("UPDATE ai_followups SET status='running',child_id=?2,message='AI processing started' WHERE id=?1 AND status='queued'",params![id,child])? == 1,"Automatic job is no longer queued");
    }
    Ok(())
}
fn reconcile(db: &Connection) -> Result<()> {
    for (action, table) in [("embedding", "ai_jobs"), ("summary", "summary_jobs")] {
        db.execute(&format!("UPDATE ai_followups SET status=(SELECT status FROM {table} WHERE id=child_id),message=(SELECT message FROM {table} WHERE id=child_id)
            WHERE action=?1 AND status='running' AND EXISTS(SELECT 1 FROM {table} WHERE id=child_id AND status!='running')"),[action])?;
    }
    Ok(())
}
pub fn recover(db: &Connection) -> Result<()> {
    reconcile(db)?;
    db.execute("UPDATE ai_followups SET status='interrupted',message='Concord closed during AI processing. Retry explicitly to avoid duplicate requests.' WHERE status='running'",[])?;
    Ok(())
}
fn stop_child(control: &Control, row: &Value) {
    if row["action"] == "embedding" {
        let active = control.index_job.lock().unwrap();
        if active.as_deref() == row["child_id"].as_str() {
            control.cancel_index.store(true, Ordering::SeqCst);
        }
    } else {
        if let Some(task) = control
            .summaries
            .lock()
            .unwrap()
            .get(row["media_id"].as_str().unwrap())
        {
            if Some(task.id.as_str()) == row["child_id"].as_str() {
                task.cancel.store(true, Ordering::SeqCst);
            }
        }
    }
}
pub fn action(root: &Path, control: &Control, id: &str, action: &str) -> Result<()> {
    let _gate = control.automation_gate.lock().unwrap();
    let db = db::open(root)?;
    reconcile(&db)?;
    let row = db::rows(&db, "SELECT * FROM ai_followups WHERE id=?1", [id])?
        .pop()
        .ok_or_else(|| anyhow::anyhow!("AI job no longer exists"))?;
    match action {
        "cancel" => {
            if row["status"] == "running" {
                stop_child(control, &row);
            } else {
                db.execute("UPDATE ai_followups SET status='cancelled',message='Cancelled' WHERE id=?1 AND status IN ('queued','blocked')",[id])?;
            }
        }
        "retry" => {
            ensure!(
                ["failed", "interrupted", "blocked", "cancelled"]
                    .contains(&row["status"].as_str().unwrap_or_default()),
                "This AI job cannot be retried"
            );
            let saved = policy(&db)?;
            let target = saved
                .target(row["action"].as_str().unwrap())
                .ok_or_else(|| {
                    anyhow::anyhow!("Enable this automatic action in Pipeline Setup first")
                })?;
            let providers = config::read(root)?;
            let provider = if row["action"] == "embedding" {
                &providers.embedding
            } else {
                &providers.chat
            };
            ensure!(
                *target == Target::from(provider) && ready(root, provider),
                "Review and save the AI actions in Pipeline Setup first"
            );
            ensure!(current_transcript(&db,&row)?,"A newer transcript replaced this job's source. Use the recording's AI controls for the new transcript.");
            db.execute("UPDATE ai_followups SET status='queued',message='Queued again with the approved provider',target=?2,child_id=NULL WHERE id=?1",params![id,serde_json::to_string(target)?])?;
        }
        _ => anyhow::bail!("Unknown automatic AI action"),
    }
    Ok(())
}
fn current_transcript(db: &Connection, row: &Value) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM media WHERE id=?1 AND transcript=?2)",
        params![row["media_id"].as_str(), row["transcript"].as_str()],
        |r| r.get(0),
    )?)
}
pub(crate) fn tick(root: &Path, control: &Arc<Control>) -> Result<()> {
    let _gate = control.automation_gate.lock().unwrap();
    let db = db::open(root)?;
    reconcile(&db)?;
    if control.closing.load(Ordering::SeqCst) {
        return Ok(());
    }
    let saved = policy(&db)?;
    let providers = config::read(root)?;
    for row in db::rows(
        &db,
        "SELECT * FROM ai_followups WHERE status='queued' ORDER BY rowid",
        [],
    )? {
        let id = row["id"].as_str().unwrap();
        let media = row["media_id"].as_str().unwrap();
        let action = row["action"].as_str().unwrap();
        let target: Target = serde_json::from_str(row["target"].as_str().unwrap())?;
        let provider = if action == "embedding" {
            &providers.embedding
        } else {
            &providers.chat
        };
        let blocked = if saved.target(action) != Some(&target) || target != Target::from(provider) {
            Some("AI settings changed. Review Pipeline Setup, then retry with its approved provider.")
        } else if !ready(root, provider) {
            Some("The approved AI provider is unavailable. Reconnect it, then retry.")
        } else {
            None
        };
        if let Some(message) = blocked {
            db.execute(
                "UPDATE ai_followups SET status='blocked',message=?2 WHERE id=?1",
                params![id, message],
            )?;
            continue;
        }
        if !current_transcript(&db, &row)? {
            db.execute("UPDATE ai_followups SET status='skipped',message='A newer transcript replaced this source' WHERE id=?1",[id])?;
            continue;
        }
        if action == "summary"
            && db.query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_summaries WHERE media_id=?1)",
                [media],
                |r| r.get::<_, bool>(0),
            )?
        {
            db.execute("UPDATE ai_followups SET status='skipped',message='A saved summary already exists; it was kept' WHERE id=?1",[id])?;
            continue;
        }
        if (action == "embedding" && control.indexing.load(Ordering::SeqCst))
            || (action == "summary" && !control.summaries.lock().unwrap().is_empty())
        {
            continue;
        }
        let started = if action == "embedding" {
            index::start_recording(
                root.into(),
                control.clone(),
                provider.clone(),
                media.into(),
                id,
            )
        } else {
            summary::start_automatic(
                root.into(),
                control.clone(),
                provider.clone(),
                media.into(),
                id,
            )
        };
        if let Err(e) = started {
            // A manual job can win the slot between the check and start. Keep this queued.
            if (action == "embedding" && control.indexing.load(Ordering::SeqCst))
                || (action == "summary" && !control.summaries.lock().unwrap().is_empty())
            {
                continue;
            }
            db.execute("UPDATE ai_followups SET status='failed',message=?2 WHERE id=?1 AND status='queued'",params![id,format!("{e:#}")])?;
        }
    }
    Ok(())
}
pub fn shutdown(control: &Control) {
    let _gate = control.automation_gate.lock().unwrap();
    control.closing.store(true, Ordering::SeqCst);
}
pub fn launch(root: PathBuf, control: Arc<Control>) {
    std::thread::spawn(move || {
        while !control.closing.load(Ordering::SeqCst) {
            if let Err(e) = tick(&root, &control) {
                runtime_log::push("error", &format!("Automatic AI: {e:#}"));
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
