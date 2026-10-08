use super::{subprocess, Config};
use crate::{db, speech};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
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
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../build/binaries/downloads")
        .join(name);
    packaged
        .filter(|p| p.is_file())
        .or_else(|| dev.is_file().then_some(dev))
        .unwrap_or_else(|| PathBuf::from(name))
}
pub fn status(root: &Path) -> Value {
    let enabled = super::downloader::enabled(root).unwrap_or(false);
    let binary = super::downloader::binary(root);
    let version = |path: &Path, arg: &str| {
        let mut cmd = Command::new(path);
        subprocess::host(&mut cmd);
        cmd.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
        cmd.arg(arg)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_owned()
            })
    };
    let yt = binary.as_ref().ok().and_then(|p| version(p, "--version"));
    let node = version(&tool("node"), "--version");
    let ffmpeg = version(Path::new("ffmpeg"), "-version");
    let missing = [
        ("yt-dlp", yt.is_none()),
        ("JavaScript runtime", node.is_none()),
        ("FFmpeg", ffmpeg.is_none()),
    ]
    .into_iter()
    .filter_map(|(n, m)| m.then_some(n))
    .collect::<Vec<_>>();
    json!({"enabled":enabled,"ready":enabled && missing.is_empty(),"version":yt,"path":binary.as_ref().ok(),"javascriptVersion":node,"javascriptPath":tool("node"),"ffmpeg":ffmpeg,
        "error":if !enabled {Some("YouTube downloads are off. Enable them in Settings → YouTube downloads.".to_owned())} else {(!missing.is_empty()).then(||format!("Download tools unavailable: {}. Open Settings → YouTube downloads to install yt-dlp; install FFmpeg if missing.",missing.join(", ")))}})
}
pub fn command(root: &Path, cfg: &Config) -> Result<Command> {
    Ok(command_using(root, cfg, &super::downloader::binary(root)?))
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
    cmd.arg("--js-runtimes")
        .arg(format!("node:{}", tool("node").display()))
        .arg("--no-remote-components");
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
/// Players that still hand out plain stream links when YouTube refuses the default ones.
const FALLBACK_PLAYERS: &str = "tv_simply,mweb";
/// YouTube refused the media request outright.
pub fn forbidden(error: &str) -> bool {
    error.contains("HTTP Error 403")
}
/// YouTube's servers failed partway; a different codec usually comes from elsewhere.
fn servers_failed(error: &str) -> bool {
    let mut rest = error;
    while let Some(i) = rest.find("HTTP Error 5") {
        if rest[i + 12..].chars().take(2).all(|c| c.is_ascii_digit()) {
            return true;
        }
        rest = &rest[i + 12..];
    }
    error.contains("Giving up after")
}
/// The codecs to try, the chosen one first, as Concord did.
pub fn codec_chain(codec: &str) -> Vec<&'static str> {
    match codec {
        "av01" => vec!["av01", "avc1", "vp9"],
        "vp9" => vec!["vp9", "avc1"],
        "avc1" => vec!["avc1"],
        _ => vec!["any"],
    }
}
fn sanitize(name: &str) -> String {
    let kept: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || c.is_whitespace() || *c == '_' || *c == '-').collect();
    kept.split_whitespace().collect::<Vec<_>>().join("_").chars().take(100).collect()
}
/// A channel's download folder, named as Concord named it.
pub fn channel_folder(channel: &str) -> String {
    Some(sanitize(channel.trim())).filter(|s| !s.is_empty()).unwrap_or_else(|| "Manual".into())
}
/// "2026-10-05 - Title" as Concord named downloads; the video id when the title has no usable characters.
pub fn video_name(title: &str, upload_date: &str, id: &str) -> String {
    let title = Some(sanitize(title)).filter(|s| !s.is_empty()).unwrap_or_else(|| id.to_owned());
    if upload_date.len() == 8 && upload_date.bytes().all(|b| b.is_ascii_digit()) {
        format!("{}-{}-{} - {title}", &upload_date[..4], &upload_date[4..6], &upload_date[6..])
    } else {
        title
    }
}
const FINISHED: [&str; 11] = ["mp4", "mkv", "webm", "mov", "ogg", "wav", "mp3", "m4a", "flac", "aac", "opus"];
/// The name to save under, adding the video id when another video's finished file already has it.
pub fn unique_name(folder: &Path, name: &str, id: &str) -> String {
    let taken = FINISHED.iter().any(|ext| folder.join(format!("{name}.{ext}")).is_file());
    if taken { format!("{name} [{id}]") } else { name.to_owned() }
}
/// Remove what a failed attempt left (format pieces, .part and .ytdl files) so the next one
/// starts clean instead of resuming a refused link.
fn clean_partials(folder: &Path, name: &str) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let piece = file.starts_with(&format!("{name}.f"));
        let partial = file.starts_with(&format!("{name}.")) && (file.ends_with(".part") || file.ends_with(".ytdl"));
        if piece || partial {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
pub fn format(cfg: &Config) -> String {
    format_for(cfg, &cfg.codec)
}
fn format_for(cfg: &Config, codec: &str) -> String {
    let audio = if cfg.audio_language.is_empty() {
        "bestaudio".into()
    } else {
        format!("bestaudio[language={}]/bestaudio", cfg.audio_language)
    };
    if cfg.audio_only {
        return audio;
    }
    let preferred = match codec {
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
    /// Not wanted after all; the reason is for the log.
    Skipped(String),
}
/// Days since 1970-01-01 for a calendar date (Howard Hinnant's days_from_civil).
fn days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}
/// Whether a video was posted before a channel was followed (unix seconds), allowing a day
/// either side for time zones and premieres. Unknown dates count as new.
pub fn posted_before(metadata: &Value, since: i64) -> bool {
    if since <= 0 {
        return false;
    }
    let posted = metadata["timestamp"].as_i64().or_else(|| metadata["release_timestamp"].as_i64()).or_else(|| {
        let date = metadata["upload_date"].as_str()?;
        if date.len() != 8 || !date.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let part = |r: std::ops::Range<usize>| date[r].parse::<i64>().ok();
        // A bare date could be any time that day; count it from the day's end.
        Some((days(part(0..4)?, part(4..6)?, part(6..8)?) + 1) * 86_400)
    });
    posted.is_some_and(|t| t < since - 86_400)
}
pub fn fetch(root: &Path, control: &speech::Control, row: &Value, cfg: &Config) -> Result<Outcome> {
    if let Some(path) = row["path"]
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return Ok(Outcome::File(path));
    }
    fetch_using(root, control, row, cfg, &super::downloader::binary(root)?)
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
    // A followed channel only adds what was posted after following; anything older that slipped
    // into a listing (a removed newer video, a tab that failed to list before) is dropped here.
    if let Some(source) = row["source_id"].as_str() {
        let since: i64 = db::open(root)?
            .query_row("SELECT since FROM channels WHERE id=?1", [source], |r| r.get(0))
            .optional()?
            .unwrap_or(0);
        if posted_before(&metadata, since) {
            return Ok(Outcome::Skipped(format!(
                "Skipped {} from a followed channel: it was posted before following",
                metadata["title"].as_str().unwrap_or("a video")
            )));
        }
    }
    let remote = video_id(&metadata).context("YouTube did not return a valid recording ID")?;
    let base = if cfg.download_directory.is_empty() {
        root.join("media")
    } else {
        PathBuf::from(&cfg.download_directory)
    };
    if !cfg.download_directory.is_empty() {
        anyhow::ensure!(base.is_dir(),"The download folder is unavailable. Reconnect its drive or choose a folder in Settings → Processing & downloads.");
    }
    // Saved like Concord: a folder per channel, files named by date and title.
    let channel = metadata["channel"].as_str().or_else(|| metadata["uploader"].as_str()).unwrap_or("");
    let folder = base.join(channel_folder(channel));
    std::fs::create_dir_all(&folder).context(
        "Cannot create the download folder. Reconnect its drive or choose another in Settings → Processing & downloads.",
    )?;
    let folder = folder.canonicalize()?;
    let name = unique_name(
        &folder,
        &video_name(metadata["title"].as_str().unwrap_or(""), metadata["upload_date"].as_str().unwrap_or(""), remote),
        remote,
    );
    let attempt = |codec: &str, players: Option<&str>| -> Result<String> {
        let mut cmd = command_using(root, cfg, executable);
        cmd.args(["--no-playlist","--no-simulate","--no-overwrites","--continue","--newline","--progress","--progress-delta","1","--progress-template","CONCORD_PROGRESS:%(progress._percent_str)s · %(progress._speed_str)s · %(progress._eta_str)s remaining","--print","after_move:CONCORD_FILE:%(filepath)j","--restrict-filenames","--format"])
            .arg(format_for(cfg, codec)).arg("--output").arg(folder.join(format!("{name}.%(ext)s")));
        if let Some(players) = players {
            cmd.arg("--extractor-args").arg(format!("youtube:player_client={players}"));
        }
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
        subprocess::run(root, control, cmd, Some(job), Duration::from_secs(12 * 3600))
    };
    let note = |message: &str| -> Result<()> {
        db::open(root)?.execute("UPDATE jobs SET message=?1 WHERE id=?2", params![message, job])?;
        crate::runtime_log::push("warn", &format!("Download {remote}: {message}"));
        Ok(())
    };
    // As Concord did: when YouTube's servers fail partway on one codec, try the next; when
    // YouTube refuses the stream outright (it wants a token Concord can't make), try once with
    // players that still serve a plain, usually 360p, stream. Partial files go first each
    // time, so a refused stream is never resumed.
    let chain = codec_chain(&cfg.codec);
    let mut output = None;
    let mut last = None;
    for (i, codec) in chain.iter().enumerate() {
        match attempt(codec, None) {
            Ok(text) => {
                output = Some(text);
                break;
            }
            Err(e) if control.is_cancelled() => return Err(e),
            Err(e) => {
                let text = format!("{e:#}");
                if forbidden(&text) {
                    clean_partials(&folder, &name);
                    note("YouTube refused the full-quality stream, so a lower-quality one is downloading instead")?;
                    output = Some(attempt(chain[0], Some(FALLBACK_PLAYERS))?);
                    break;
                }
                last = Some(e);
                if !servers_failed(&text) || i + 1 == chain.len() {
                    break;
                }
                clean_partials(&folder, &name);
                note(&format!("YouTube's servers failed on {codec}; trying {}", chain[i + 1]))?;
            }
        }
    }
    let output = match (output, last) {
        (Some(text), _) => text,
        (None, Some(e)) => return Err(e),
        (None, None) => anyhow::bail!("Download did not run"),
    };
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
 print(json.dumps({'id':'fixture1234','title':'Remote title','channel':'Tuesday Study','duration':25,'upload_date':'20250930','live_status':'not_live'}))
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
        // Saved like Concord: a folder per channel, named by date and title.
        assert_eq!(path, root.join("media/Tuesday_Study/2025-09-30 - Remote_title.mp4").canonicalize().unwrap());
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

    #[test]
    #[cfg(unix)]
    fn a_codec_youtubes_servers_fail_on_falls_back_to_the_next_one() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let fake = root.join("yt-dlp-fixture.py");
        std::fs::write(&fake,r#"#!/usr/bin/env python3
import sys,json,pathlib
args=sys.argv[1:]
if '--dump-single-json' in args:
 print(json.dumps({'id':'fixture1234','title':'Remote title','channel':'Tuesday Study','upload_date':'20250930','live_status':'not_live'}))
 sys.exit(0)
out=pathlib.Path(args[args.index('--output')+1].replace('%(ext)s','mp4'))
fmt=args[args.index('--format')+1]
if fmt.startswith('bestvideo[vcodec^=av01]'):
 pathlib.Path(str(out).replace('.mp4','.f399.mp4.part')).write_bytes(b'bad partial')
 print('ERROR: unable to download video data: HTTP Error 503: Service Unavailable',file=sys.stderr)
 sys.exit(1)
assert fmt.startswith('bestvideo[vcodec^=avc1]'), fmt
assert not pathlib.Path(str(out).replace('.mp4','.f399.mp4.part')).exists()
out.write_bytes(b'h264 media')
print('CONCORD_FILE:'+json.dumps(str(out)))
"#).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let db = db::open(root).unwrap();
        db.execute("INSERT INTO media(id,title,url) VALUES ('remote','Pending','https://www.youtube.com/watch?v=fixture1234')",[]).unwrap();
        db.execute("INSERT INTO jobs(id,media_id,title,status) VALUES ('job','remote','Pending','running')",[]).unwrap();
        let row = json!({"id":"job","media_id":"remote","url":"https://www.youtube.com/watch?v=fixture1234","source_id":null,"path":null});
        let cfg = Config { codec: "av01".into(), ..Default::default() };
        let Outcome::File(path) = fetch_using(root, &speech::Control::default(), &row, &cfg, &fake).unwrap() else {
            panic!("unexpected outcome");
        };
        assert_eq!(std::fs::read(&path).unwrap(), b"h264 media");
        assert_eq!(codec_chain("av01"), ["av01", "avc1", "vp9"]);
        assert_eq!(codec_chain("vp9"), ["vp9", "avc1"]);
        assert_eq!(codec_chain("any"), ["any"]);
    }

    #[test]
    fn files_and_folders_are_named_like_concord() {
        assert_eq!(channel_folder("Ellen McFarlane"), "Ellen_McFarlane");
        assert_eq!(channel_folder("Café — Talks!"), "Caf_Talks");
        assert_eq!(channel_folder("  "), "Manual");
        assert_eq!(video_name("The Angels Got Their Orders — You’re Walking", "20261005", "zvFoXZaWtmw"), "2026-10-05 - The_Angels_Got_Their_Orders_Youre_Walking");
        assert_eq!(video_name("No date", "", "id"), "No_date");
        assert_eq!(video_name("——", "20261005", "zvFoXZaWtmw"), "2026-10-05 - zvFoXZaWtmw");
    }

    #[test]
    fn a_new_download_never_takes_over_another_videos_file() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path();
        assert_eq!(unique_name(folder, "2026-10-05 - Talk", "abc"), "2026-10-05 - Talk");
        std::fs::write(folder.join("2026-10-05 - Talk.f399.mp4.part"), b"partial").unwrap();
        assert_eq!(unique_name(folder, "2026-10-05 - Talk", "abc"), "2026-10-05 - Talk", "a partial of the same name is resumed");
        std::fs::write(folder.join("2026-10-05 - Talk.mp4"), b"another video").unwrap();
        assert_eq!(unique_name(folder, "2026-10-05 - Talk", "abc"), "2026-10-05 - Talk [abc]");
    }

    #[test]
    #[cfg(unix)]
    fn a_download_youtube_refuses_is_retried_with_other_players_from_a_clean_start() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let fake = root.join("yt-dlp-fixture.py");
        std::fs::write(&fake,r#"#!/usr/bin/env python3
import sys,json,pathlib
args=sys.argv[1:]
if '--dump-single-json' in args:
 print(json.dumps({'id':'fixture1234','title':'Remote title','channel':'Tuesday Study','duration':25,'upload_date':'20250930','live_status':'not_live'}))
 sys.exit(0)
out=pathlib.Path(args[args.index('--output')+1].replace('%(ext)s','mp4'))
if 'youtube:player_client=tv_simply,mweb' not in args:
 pathlib.Path(str(out).replace('.mp4','.f399.mp4.part')).write_bytes(b'bad partial')
 print('ERROR: unable to download video data: HTTP Error 403: Forbidden',file=sys.stderr)
 sys.exit(1)
assert not pathlib.Path(str(out).replace('.mp4','.f399.mp4.part')).exists(), 'the refused partial must not be resumed'
out.write_bytes(b'fixture media')
print('CONCORD_FILE:'+json.dumps(str(out)))
"#).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let db = db::open(root).unwrap();
        db.execute("INSERT INTO media(id,title,url) VALUES ('remote','Pending','https://www.youtube.com/watch?v=fixture1234')",[]).unwrap();
        db.execute("INSERT INTO jobs(id,media_id,title,status) VALUES ('job','remote','Pending','running')",[]).unwrap();
        let row = json!({"id":"job","media_id":"remote","url":"https://www.youtube.com/watch?v=fixture1234","source_id":null,"path":null});
        let Outcome::File(path) = fetch_using(root, &speech::Control::default(), &row, &Config::default(), &fake).unwrap() else {
            panic!("unexpected outcome");
        };
        assert_eq!(std::fs::read(&path).unwrap(), b"fixture media");
        assert!(forbidden("Download tool failed: ERROR: unable to download video data: HTTP Error 403: Forbidden"));
        assert!(!forbidden("Download tool failed: HTTP Error 404: Not Found"));
    }
}
