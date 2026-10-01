//! Durable, single-recording processing. Queue state survives application restarts.
pub mod download;
pub mod downloader;
pub mod links;
mod queue;
pub mod sources;
pub(crate) mod subprocess;
#[cfg(test)]
mod tests;
mod worker;
use anyhow::Result;
pub use queue::{action, candidates, enqueue, enqueue_one, recover, snapshot, Batch, WAITING_FOR_SPEECH};
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
    pub download_directory: String,
    pub quality: String,
    pub codec: String,
    pub audio_language: String,
    pub audio_only: bool,
    pub speed: String,
    pub rate_mib: u32,
    pub daily_limit: u32,
    pub check_minutes: u32,
    pub automatic_checks: bool,
    pub cookies_file: String,
    pub cookies_browser: String,
    pub speech_language: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            device: "auto".into(),
            retries: 2,
            retry_minutes: 5,
            download_directory: String::new(),
            quality: "1080".into(),
            codec: "any".into(),
            audio_language: "en".into(),
            audio_only: false,
            speed: "conservative".into(),
            rate_mib: 3,
            daily_limit: 200,
            check_minutes: 1440,
            automatic_checks: false,
            cookies_file: String::new(),
            cookies_browser: String::new(),
            speech_language: "en-US".into(),
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
    anyhow::ensure!(
        ["best", "4320", "2160", "1440", "1080", "720", "480", "360"]
            .contains(&value.quality.as_str()),
        "Choose a supported download quality"
    );
    anyhow::ensure!(
        ["any", "avc1", "av01", "vp9"].contains(&value.codec.as_str()),
        "Choose a supported codec preference"
    );
    anyhow::ensure!(
        ["conservative", "balanced", "fast"].contains(&value.speed.as_str()),
        "Choose a download speed preset"
    );
    anyhow::ensure!(
        ["", "firefox", "chrome", "chromium", "brave", "edge", "vivaldi", "safari"]
            .contains(&value.cookies_browser.as_str()),
        "Choose a supported browser for cookies"
    );
    anyhow::ensure!(
        value.audio_language.len() <= 20
            && value
                .audio_language
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "Audio language must be a language code, such as en"
    );
    anyhow::ensure!(
        !value.speech_language.is_empty()
            && value.speech_language.len() <= 20
            && value
                .speech_language
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "Transcription language must be a language code, such as en-US"
    );
    anyhow::ensure!((1..=10000).contains(&value.daily_limit)&&(5..=10080).contains(&value.check_minutes)&&value.rate_mib<=1000,"Use a daily limit of 1–10,000, a check interval of 5–10,080 minutes, and a rate up to 1,000 MiB/s (0 is unlimited)");
    anyhow::ensure!(
        value.download_directory.is_empty() || Path::new(&value.download_directory).is_absolute(),
        "Choose an absolute download folder path"
    );
    anyhow::ensure!(
        value.cookies_file.is_empty() || Path::new(&value.cookies_file).is_file(),
        "The cookies file is unavailable"
    );
    crate::db::open(root)?.execute("INSERT INTO settings VALUES ('pipeline.config',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(value)?])?;
    Ok(())
}
/// Import files and queue them for transcription. They wait in the queue until speech is ready.
pub fn import_and_queue(root: &Path, control: &Control, paths: &[String], category: &str, device: &str) -> Result<usize> {
    validate_device(device)?;
    let ids = crate::db::import_media_ids(root, paths, category)?;
    if !ids.is_empty() {
        enqueue(root, control, &Batch { ids: ids.clone(), device: device.into(), ..Default::default() }, true)?;
    }
    Ok(ids.len())
}
/// The one stored speech device preference, used by the queue and by manual transcription.
pub fn device(root: &Path) -> Result<String> {
    Ok(config(root)?.device)
}
/// Changes only the device, so unrelated settings that have gone stale (a moved cookies
/// file, for example) cannot block it.
pub fn set_device(root: &Path, device: &str) -> Result<()> {
    validate_device(device)?;
    let value = Config { device: device.into(), ..config(root)? };
    crate::db::open(root)?.execute("INSERT INTO settings VALUES ('pipeline.config',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&value)?])?;
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
pub fn migrate_sources(db: &Connection) -> Result<()> {
    for (table, name, kind) in [
        ("channels", "kind", "TEXT NOT NULL DEFAULT 'youtube'"),
        ("channels", "last_check", "INTEGER NOT NULL DEFAULT 0"),
        ("channels", "check_message", "TEXT NOT NULL DEFAULT ''"),
        ("channels", "check_status", "TEXT NOT NULL DEFAULT ''"),
        ("pipeline_work", "diarize", "INTEGER NOT NULL DEFAULT 1"),
    ] {
        let exists: bool = db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"),
            [name],
            |r| r.get(0),
        )?;
        if !exists {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {kind}"))?;
        }
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS pipeline_downloads(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,day TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS pipeline_download_day ON pipeline_downloads(day);
        UPDATE channels SET kind='collection' WHERE url='' AND kind='youtube';")?;
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
    let config = config(root)?;
    let daily = download::daily_count(&db)?;
    Ok(
        serde_json::json!({"running":running(&db)?,"active":count("running"),"queued":count("queued"),"retry":count("retry"),"waitingLive":count("waiting_live"),"failed":count("failed"),"dailyDownloads":daily,"dailyLimit":config.daily_limit,"atDailyLimit":daily>=config.daily_limit}),
    )
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
