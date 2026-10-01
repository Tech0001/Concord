//! Durable, single-recording processing. Queue state survives application restarts.
mod queue;
#[cfg(test)]
mod tests;
mod worker;
use anyhow::Result;
pub use queue::{action, candidates, enqueue, enqueue_one, recover, snapshot, Batch};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
pub use worker::{launch, Control};

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub device: String,
    pub retries: u32,
    pub retry_minutes: u32,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            device: "auto".into(),
            retries: 2,
            retry_minutes: 5,
        }
    }
}
pub fn config(root: &Path) -> Result<Config> {
    let db = crate::db::open(root)?;
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='pipeline.config'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or_default())
}
pub fn save_config(root: &Path, value: &Config) -> Result<()> {
    validate_device(&value.device)?;
    anyhow::ensure!(
        value.retries <= 10 && (1..=1440).contains(&value.retry_minutes),
        "Use 0–10 retries and a delay of 1–1440 minutes"
    );
    crate::db::open(root)?.execute("INSERT INTO settings VALUES ('pipeline.config',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(value)?])?;
    Ok(())
}
pub fn validate_device(device: &str) -> Result<()> {
    anyhow::ensure!(
        device == "auto"
            || device == "cpu"
            || device
                .strip_prefix("vulkan:")
                .is_some_and(|s| !s.is_empty() && s.parse::<u32>().is_ok()),
        "Unsupported speech device"
    );
    Ok(())
}
pub fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS pipeline_work(
        id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'transcribe', device TEXT NOT NULL DEFAULT 'auto',
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
        finished_at TEXT, cancelled INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS pipeline_retry ON pipeline_work(retry_at);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_media ON jobs(media_id)
        WHERE status IN ('queued','running','retry','waiting_live');",
    )?;
    Ok(())
}
fn running(db: &Connection) -> Result<bool> {
    Ok(db.query_row(
        "SELECT COALESCE((SELECT value FROM settings WHERE key='pipeline.running'),'false')='true'",
        [],
        |r| r.get(0),
    )?)
}
fn set_running(db: &Connection, value: bool) -> Result<()> {
    db.execute("INSERT INTO settings VALUES ('pipeline.running',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [if value { "true" } else { "false" }])?;
    Ok(())
}
pub fn overview(root: &Path) -> Result<serde_json::Value> {
    let db = crate::db::open(root)?;
    let counts=crate::db::rows(&db,"SELECT j.status,count(*) AS count FROM jobs j JOIN pipeline_work p ON p.id=j.id GROUP BY j.status",[])?;
    let count = |status: &str| {
        counts
            .iter()
            .find(|r| r["status"] == status)
            .and_then(|r| r["count"].as_i64())
            .unwrap_or(0)
    };
    Ok(
        serde_json::json!({"running":running(&db)?,"active":count("running"),"queued":count("queued"),"retry":count("retry"),"failed":count("failed")}),
    )
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
