//! Allowlisted support diagnostics. Never send raw settings, paths, logs, or source content.
use crate::{ai, db, onboarding, pipeline, speech, speech_setup};
use anyhow::Result;
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::Ordering};
pub const GUIDE: &str = include_str!("help-guide.md");
pub fn error_category(error: &str) -> &'static str {
    let e = error.to_ascii_lowercase();
    if e.trim().is_empty() {
        "none"
    } else if e.contains("encodings") || e.contains("python runtime") {
        "speech-python-environment"
    } else if e.contains("out of memory") || e.contains("allocation") {
        "insufficient-memory"
    } else if e.contains("no space") || e.contains("disk full") {
        "disk-full"
    } else if e.contains("ffmpeg") {
        "media-tools"
    } else if e.contains("401")
        || e.contains("403")
        || e.contains("sign in")
        || e.contains("unauthorized")
    {
        "authentication"
    } else if e.contains("429") || e.contains("rate limit") || e.contains("quota") {
        "provider-limit"
    } else if e.contains("dimension") {
        "embedding-dimensions"
    } else if e.contains("permission denied") {
        "permission-denied"
    } else if e.contains("not found") || e.contains("no such file") || e.contains("unavailable") {
        "missing-dependency-or-file"
    } else if e.contains("timed out") || e.contains("timeout") {
        "timeout"
    } else if e.contains("connection") || e.contains("network") || e.contains("http") {
        "network-or-provider"
    } else {
        "unclassified"
    }
}
fn state(v: &str) -> &str {
    match v {
        "idle" | "ready" | "queued" | "running" | "complete" | "completed" | "failed" | "cancelled"
        | "interrupted" | "retry" | "checking" | "paused" | "waiting" | "missing" | "blocked" => v,
        _ => "unknown",
    }
}
pub fn prompt(topic: &str, error: &str) -> String {
    let topic = match topic {
        "speech" => "speech setup and GPU/CPU processing",
        "recordings" => "adding recordings and scanning folders",
        "ai" => "search and chat setup",
        "look" => "appearance and transcript settings",
        "library" => "starting or importing a library",
        "ready" => "finishing setup",
        "source" => "a source that isn't bringing in recordings",
        "queue" => "a processing job",
        "index" => "semantic indexing",
        "health" => "archive health or repair",
        _ => "Concord setup",
    };
    let issue = error_category(error);
    format!(
        "Help me troubleshoot {topic}.{} What should I check next?",
        if issue == "none" {
            String::new()
        } else {
            format!(" Error category: {issue}.")
        }
    )
}
fn safe_provider(p: &ai::config::Provider) -> Value {
    let model = if p.model.len() <= 100
        && !p.model.starts_with("sk-")
        && !p.model.starts_with('/')
        && !p.model.contains(":/")
        && p.model.split('/').count() <= 2
        && p.model.split('/').all(|part| !matches!(part, "" | "." | ".."))
        && p.model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:/".contains(c))
    {
        p.model.as_str()
    } else {
        "custom model"
    };
    json!({"kind":match p.kind.as_str(){"builtin"|"codex"|"claude-code"|"chatgpt"|"local"|"openrouter"|"custom"=>p.kind.as_str(),_=>"unknown"},"enabled":p.enabled,"model":model,"keyConfigured":!p.api_key.is_empty()})
}
/// Reuses setup readiness, then picks fields explicitly instead of attempting to redact a dump.
pub fn snapshot(
    root: &Path,
    runtime: &speech::Runtime,
    setup: &speech_setup::Control,
    control: &pipeline::Control,
) -> Result<Value> {
    let status = onboarding::status(
        root,
        runtime,
        setup,
        Path::new("/nonexistent-concord-help-legacy"),
    )?;
    let runtime = runtime.for_root(root).status();
    let db = db::open(root)?;
    let count = |sql: &str| -> Result<i64> { Ok(db.query_row(sql, [], |r| r.get(0))?) };
    let configuration = pipeline::config(root);
    let configuration_readable = configuration.is_ok();
    let cfg = configuration.unwrap_or_default();
    let mut sources = Vec::new();
    for (i, s) in pipeline::sources::list(root)?.iter().enumerate().take(30) {
        sources.push(json!({"sourceNumber":i+1,"kind":match s["kind"].as_str(){Some("folder")=>"folder",Some("youtube")=>"youtube",_=>"collection"},"enabled":s["enabled"]==1,"recordings":s["recordings"].as_i64().unwrap_or(0),"folderAvailable":if s["kind"]=="folder"{Some(Path::new(s["url"].as_str().unwrap_or("")).is_dir())}else{None},"hasBeenChecked":s["last_check"].as_i64().unwrap_or(0)>0,"checkStatus":state(s["check_status"].as_str().unwrap_or("")),"errorCategory":if s["check_status"]=="failed"{error_category(s["check_message"].as_str().unwrap_or(""))}else{"none"}}));
    }
    let folders=db::rows(&db,"SELECT path,enabled,last_scan,error FROM document_roots ORDER BY label COLLATE NOCASE LIMIT 30",[])?;
    let folders=folders.iter().enumerate().map(|(i,f)|json!({"folderNumber":i+1,"enabled":f["enabled"]==1,"available":Path::new(f["path"].as_str().unwrap_or("")).is_dir(),"scanned":!f["last_scan"].is_null(),"errorCategory":error_category(f["error"].as_str().unwrap_or(""))})).collect::<Vec<_>>();
    let errors=db::rows(&db,"SELECT 'processing' AS area,status,message,created_at FROM jobs WHERE status IN ('failed','retry') UNION ALL SELECT 'semantic-index',status,message,created_at FROM ai_jobs WHERE status='failed' UNION ALL SELECT 'maintenance',status,message,created_at FROM maintenance_jobs WHERE status='failed' ORDER BY created_at DESC LIMIT 20",[])?;
    let errors=errors.iter().map(|e|json!({"area":e["area"],"status":state(e["status"].as_str().unwrap_or("")),"category":error_category(e["message"].as_str().unwrap_or(""))})).collect::<Vec<_>>();
    let providers = ai::config::read(root)?;
    let device = ai::builtin::device(root);
    Ok(
        json!({"version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"capturedAt":crate::health::now(),
      "setup":{"completed":status["progress"]["completed"],"step":status["progress"]["step"]},
      "library":{"recordings":status["library"]["media"],"documents":status["library"]["docs"],"notes":status["library"]["notes"]},
      "speech":{"runtimeErrorCategory":error_category(runtime["runtimeError"].as_str().unwrap_or("")),"installed":status["speech"]["installed"],"ready":runtime["ready"],"modelsReady":runtime["modelsReady"],"voiceMatchingReady":runtime["voiceMatchingReady"],"ffmpegReady":runtime["mediaToolsReady"],"gpuDetected":runtime["gpu"].is_string(),"detectedDevice":runtime["device"],"selectedDevice":if pipeline::validate_device(&cfg.device).is_ok(){cfg.device.as_str()}else{"unknown"},"setupStatus":state(status["speech"]["setup"]["status"].as_str().unwrap_or("")),"setupErrorCategory":if status["speech"]["setup"]["status"]=="failed"{error_category(status["speech"]["setup"]["message"].as_str().unwrap_or(""))}else{"none"}},
      "pipeline":{"configurationReadable":configuration_readable,"running":count("SELECT COALESCE((SELECT value FROM settings WHERE key='pipeline.running'),'false')='true'")?!=0,"checkingSources":control.checking.load(Ordering::SeqCst),"queued":count("SELECT count(*) FROM jobs WHERE status IN ('queued','retry')")?,"runningJobs":count("SELECT count(*) FROM jobs WHERE status='running'")?,"automaticChecks":cfg.automatic_checks,"checkMinutes":cfg.check_minutes,"dailyDownloadLimit":cfg.daily_limit,"downloaderEnabled":pipeline::downloader::enabled(root)?,"downloaderReady":pipeline::downloader::available(root),"sources":sources,"sourceCount":count("SELECT count(*) FROM channels")?},
      "documents":{"folders":folders,"folderCount":count("SELECT count(*) FROM document_roots")?},
      "search":{"provider":safe_provider(&providers.embedding),"modelReady":status["search"]["modelReady"],"runtimeDevice":device,"indexedSources":db.query_row("SELECT count(*) FROM ai_sources WHERE signature=?1",[providers.embedding.signature()],|r|r.get::<_,i64>(0))?,"downloadStatus":state(status["search"]["download"]["status"].as_str().unwrap_or(""))},
      "chat":{"provider":safe_provider(&providers.chat),"configured":status["chat"]["connected"]},"recentErrors":errors,
      "omitted":"No paths, source names/URLs, recording/document/note text, raw logs, credentials, or account identifiers. Error samples are limited and generalized."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_omit_private_data_and_classify_errors() {
        let root = tempfile::tempdir().unwrap();
        let db = db::open(root.path()).unwrap();
        let secret = "NEVER_SEND_THIS_PRIVATE_VALUE";
        db.execute("INSERT INTO channels(id,name,url,kind,check_status,check_message) VALUES('s',?1,?1,'folder','failed',?2)",rusqlite::params![secret,format!("Permission denied: {secret}")]).unwrap();
        db.execute(
            "INSERT INTO document_roots(id,path,label,error) VALUES('d',?1,?1,?2)",
            rusqlite::params![secret, format!("No such file: {secret}")],
        )
        .unwrap();
        let config = json!({"embedding":{"kind":"builtin","enabled":true,"model":ai::builtin::MODEL,"baseUrl":"http://localhost","apiKey":secret},"chat":{"kind":"custom","enabled":true,"baseUrl":format!("https://{secret}.example/v1"),"model":format!("/home/private/{secret}.gguf"),"apiKey":secret,"accountId":secret}});
        std::fs::write(root.path().join("ai-providers.json"), config.to_string()).unwrap();
        let runtime = speech::Runtime {
            binary: root.path().join(secret),
            script: root.path().join(secret),
            python: root.path().join(secret),
            models: root.path().join(secret),
        };
        let control = pipeline::Control::new(std::sync::Arc::new(speech::Control::default()));
        let data = snapshot(
            root.path(),
            &runtime,
            &speech_setup::Control::default(),
            &control,
        )
        .unwrap();
        let text = data.to_string();
        assert!(!text.contains(secret));
        assert!(!text.contains(root.path().to_str().unwrap()));
        assert_eq!(
            data["pipeline"]["sources"][0]["errorCategory"],
            "permission-denied"
        );
        assert_eq!(
            data["documents"]["folders"][0]["errorCategory"],
            "missing-dependency-or-file"
        );
        assert!(!prompt("queue", &format!("HTTP 401 token={secret}")).contains(secret));
        assert!(prompt("queue", "HTTP 401").contains("authentication"));
    }
}
