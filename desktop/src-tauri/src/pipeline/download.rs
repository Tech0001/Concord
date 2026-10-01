use super::{subprocess, Config};
use crate::{db, speech};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::Duration,
};

static RESOURCES: OnceLock<PathBuf> = OnceLock::new();
pub fn initialize(path: PathBuf) {
    let _ = RESOURCES.set(path);
}
fn tool(name: &str) -> PathBuf {
    let packaged = RESOURCES.get().map(|r| r.join("downloads").join(name));
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../build/binaries/downloads").join(name);
    packaged.filter(|p| p.is_file()).or_else(|| dev.is_file().then_some(dev)).unwrap_or_else(|| PathBuf::from(name))
}
pub fn binary() -> PathBuf {
    std::env::var_os("CONCORD_YTDLP_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| tool("yt-dlp"))
}
pub fn status() -> Value {
    let version = |path: &Path, arg: &str| {
        let mut cmd = Command::new(path);
        subprocess::host(&mut cmd);
        cmd.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
        cmd.arg(arg).output().ok().filter(|o|o.status.success()).map(|o|String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").to_owned())
    };
    let yt = version(&binary(), "--version");
    let node = version(&tool("node"), "--version");
    let ffmpeg = version(Path::new("ffmpeg"), "-version");
    let missing = [("yt-dlp",yt.is_none()),("JavaScript runtime",node.is_none()),("FFmpeg",ffmpeg.is_none())].into_iter().filter_map(|(n,m)|m.then_some(n)).collect::<Vec<_>>();
    json!({"ready":missing.is_empty(),"version":yt,"path":binary(),"javascriptVersion":node,"javascriptPath":tool("node"),"ffmpeg":ffmpeg,
        "error":(!missing.is_empty()).then(||format!("Download tools unavailable: {}. Check the Concord installation and install FFmpeg if missing.",missing.join(", ")))})
}
pub fn command(root: &Path, cfg: &Config) -> Command {
    command_using(root, cfg, &binary())
}
fn command_using(root: &Path, cfg: &Config, executable: &Path) -> Command {
    let mut cmd = Command::new(executable);
    cmd.args([
        "--ignore-config",
        "--no-exec",
        "--no-warnings",
        "--no-colors",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--no-mark-watched",
    ])
    .arg("--cache-dir")
    .arg(root.join("cache/yt-dlp"));
    if !cfg.cookies_file.is_empty() {
        cmd.arg("--cookies").arg(&cfg.cookies_file);
    } else if !cfg.cookies_browser.is_empty() {
        cmd.arg("--cookies-from-browser").arg(&cfg.cookies_browser);
    }
    // Bundled Node handles YouTube's JS challenges without installing remote code.
    cmd.arg("--js-runtimes").arg(format!("node:{}",tool("node").display())).arg("--no-remote-components");
    cmd.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    cmd
}
pub fn youtube_url(value: &str) -> Result<url::Url> {
    let parsed = url::Url::parse(value.trim())?;
    anyhow::ensure!(
        ["https", "http"].contains(&parsed.scheme())
            && [
                "youtube.com",
                "www.youtube.com",
                "m.youtube.com",
                "youtu.be"
            ]
            .contains(&parsed.host_str().unwrap_or(""))
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.port().is_none(),
        "Enter a YouTube channel, playlist, or video URL"
    );
    let mut parsed = parsed;
    parsed.set_scheme("https").unwrap();
    parsed.set_fragment(None);
    Ok(parsed)
}
pub fn scan_urls(value: &str, shorts: bool) -> Result<Vec<String>> {
    let mut url = youtube_url(value)?;
    let path = url.path().trim_end_matches('/');
    let path = ["/videos", "/streams", "/shorts"]
        .iter()
        .find_map(|end| path.strip_suffix(end))
        .unwrap_or(path)
        .to_owned();
    if path.starts_with("/@")
        || path.starts_with("/channel/")
        || path.starts_with("/c/")
        || path.starts_with("/user/")
    {
        url.set_query(None);
        Ok(if shorts {
            vec!["videos", "streams", "shorts"]
        } else {
            vec!["videos", "streams"]
        }
        .into_iter()
        .map(|tab| {
            url.set_path(&format!("{path}/{tab}"));
            url.to_string()
        })
        .collect())
    } else {
        Ok(vec![url.to_string()])
    }
}
pub fn video_id(v: &Value) -> Option<&str> {
    v["id"].as_str().filter(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}
pub fn format(cfg: &Config) -> String {
    let audio = if cfg.audio_language.is_empty() {
        "bestaudio".into()
    } else {
        format!("bestaudio[language={}]/bestaudio", cfg.audio_language)
    };
    if cfg.audio_only {
        return audio;
    }
    let preferred = match cfg.codec.as_str() {
        "avc1" => "bestvideo[vcodec^=avc1]",
        "av01" => "bestvideo[vcodec^=av01]",
        "vp9" => "bestvideo[vcodec^=vp9]",
        _ => "bestvideo",
    };
    // These are declared preferences, matching Electron's codec/language behavior.
    let lang = if cfg.audio_language.is_empty() {
        "bestaudio".into()
    } else {
        format!("bestaudio[language={}]", cfg.audio_language)
    };
    format!("{preferred}+{lang}/{preferred}+bestaudio/bestvideo+{lang}/bestvideo+bestaudio/best")
}
pub fn daily_count(db: &Connection) -> Result<u32> {
    Ok(db.query_row(
        "SELECT count(*) FROM pipeline_downloads WHERE day=date('now','localtime')",
        [],
        |r| r.get(0),
    )?)
}
pub enum Outcome {
    File(PathBuf),
    Waiting,
}
pub fn fetch(root: &Path, control: &speech::Control, row: &Value, cfg: &Config) -> Result<Outcome> {
    fetch_using(root, control, row, cfg, &binary())
}
fn fetch_using(
    root: &Path,
    control: &speech::Control,
    row: &Value,
    cfg: &Config,
    executable: &Path,
) -> Result<Outcome> {
    if let Some(path) = row["path"]
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return Ok(Outcome::File(path));
    }
    let job = row["id"].as_str().context("Queue item missing")?;
    let media = row["media_id"].as_str().context("Recording missing")?;
    let url = youtube_url(
        row["url"]
            .as_str()
            .context("Recording has no download URL")?,
    )?;
    db::open(root)?.execute(
        "UPDATE jobs SET message='Checking video availability' WHERE id=?1",
        [job],
    )?;
    let mut probe = command_using(root, cfg, executable);
    probe
        .args([
            "--dump-single-json",
            "--skip-download",
            "--no-playlist",
            "--",
        ])
        .arg(url.as_str());
    let output = subprocess::run(root, control, probe, Some(job), Duration::from_secs(180))?;
    let metadata: Value = serde_json::from_str(output.trim())
        .context("YouTube returned unreadable video metadata")?;
    if metadata["is_live"] == true
        || ["is_live", "is_upcoming", "post_live"]
            .contains(&metadata["live_status"].as_str().unwrap_or(""))
    {
        return Ok(Outcome::Waiting);
    }
    let remote = video_id(&metadata).context("YouTube did not return a valid recording ID")?;
    let base = if cfg.download_directory.is_empty() {
        root.join("media")
    } else {
        PathBuf::from(&cfg.download_directory)
    };
    if !cfg.download_directory.is_empty() {
        anyhow::ensure!(base.is_dir(),"The download folder is unavailable. Reconnect its drive or choose a folder in Pipeline setup.");
    }
    let source = row["source_id"].as_str().unwrap_or("links");
    let folder = base.join(&format!("source-{:x}", Sha256::digest(source.as_bytes()))[..23]);
    std::fs::create_dir_all(&folder).context(
        "Cannot create the download folder. Reconnect its drive or update Pipeline setup.",
    )?;
    let folder = folder.canonicalize()?;
    let mut cmd = command_using(root, cfg, executable);
    cmd.args(["--no-playlist","--no-simulate","--no-overwrites","--continue","--newline","--progress","--progress-delta","1","--progress-template","CONCORD_PROGRESS:%(progress._percent_str)s · %(progress._speed_str)s · %(progress._eta_str)s remaining","--print","after_move:CONCORD_FILE:%(filepath)j","--restrict-filenames","--format"])
        .arg(format(cfg)).arg("--output").arg(folder.join(format!("{remote}.%(ext)s")));
    if cfg.quality != "best" {
        cmd.arg("--format-sort").arg(format!("res:{}", cfg.quality));
    }
    if !cfg.audio_only {
        cmd.args(["--merge-output-format", "mp4"]);
    }
    if cfg.rate_mib > 0 {
        cmd.arg("--limit-rate").arg(format!("{}M", cfg.rate_mib));
    }
    let (min, max) = match cfg.speed.as_str() {
        "fast" => (0, 0),
        "balanced" => (2, 5),
        _ => (5, 10),
    };
    cmd.args([
        "--sleep-interval",
        &min.to_string(),
        "--max-sleep-interval",
        &max.to_string(),
        "--",
    ])
    .arg(url.as_str());
    let output = subprocess::run(
        root,
        control,
        cmd,
        Some(job),
        Duration::from_secs(12 * 3600),
    )?;
    let path = output
        .lines()
        .rev()
        .find_map(|s| s.strip_prefix("CONCORD_FILE:"))
        .context("Download finished without a media file")?;
    let path = PathBuf::from(serde_json::from_str::<String>(path)?).canonicalize()?;
    anyhow::ensure!(
        path.starts_with(&folder) && path.is_file() && path.metadata()?.len() > 0,
        "Download output is not a valid media file in the selected folder"
    );
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute("UPDATE media SET path=?1,duration=?2,date=CASE WHEN ?3<>'' THEN ?3 ELSE date END,title=CASE WHEN ?4<>'' THEN ?4 ELSE title END WHERE id=?5",params![path.to_string_lossy(),metadata["duration"].as_f64().unwrap_or(0.),metadata["upload_date"].as_str().unwrap_or(""),metadata["title"].as_str().unwrap_or(""),media])?;
    tx.execute(
        "INSERT INTO pipeline_downloads(job_id,day) VALUES (?1,date('now','localtime'))",
        [job],
    )?;
    tx.commit()?;
    Ok(Outcome::File(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn download_publishes_the_exact_completed_path_and_reuses_it_on_retry() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let fake = root.join("yt-dlp-fixture.py");
        std::fs::write(&fake,r#"#!/usr/bin/env python3
import sys,json,pathlib,os
assert 'PYTHONHOME' not in os.environ
args=sys.argv[1:]
assert '--ignore-config' in args and '--no-exec' in args
if '--dump-single-json' in args:
 print(json.dumps({'id':'fixture1234','title':'Remote title','duration':25,'upload_date':'20250930','live_status':'not_live'}))
else:
 assert args[args.index('--format-sort')+1]=='res:720'
 out=pathlib.Path(args[args.index('--output')+1].replace('%(ext)s','mp4'))
 out.write_bytes(b'fixture media')
 print('CONCORD_PROGRESS:100%')
 print('CONCORD_FILE:'+json.dumps(str(out)))
"#).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let db = db::open(root).unwrap();
        db.execute("INSERT INTO media(id,title,url) VALUES ('remote','Pending','https://www.youtube.com/watch?v=fixture1234')",[]).unwrap();
        db.execute("INSERT INTO jobs(id,media_id,title,status) VALUES ('job','remote','Pending','running')",[]).unwrap();
        let row = json!({"id":"job","media_id":"remote","url":"https://www.youtube.com/watch?v=fixture1234","source_id":"channel","path":null});
        let cfg = Config {
            quality: "720".into(),
            ..Default::default()
        };
        let control = speech::Control::default();
        let Outcome::File(path) = fetch_using(root, &control, &row, &cfg, &fake).unwrap() else {
            panic!("unexpected live wait");
        };
        assert!(path.starts_with(root.join("media")));
        assert!(path.is_file());
        assert_eq!(daily_count(&db).unwrap(), 1);
        let media = db::media(root, "remote").unwrap();
        assert_eq!(media["title"], "Remote title");
        assert_eq!(media["duration"], 25.);
        let mut retry = row;
        retry["path"] = json!(path);
        std::fs::remove_file(fake).unwrap();
        assert!(matches!(
            fetch_using(root, &control, &retry, &cfg, Path::new("/missing/tool")).unwrap(),
            Outcome::File(_)
        ));
        assert_eq!(daily_count(&db).unwrap(), 1);
    }
}
