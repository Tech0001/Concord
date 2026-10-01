use super::{private_dir, process};
use crate::{export::ExportControl, media_files};
use anyhow::{ensure, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub source: String,
    pub destination: String,
    pub progress: f64,
    pub message: String,
    pub error: String,
    pub complete: bool,
    pub bytes: u64,
    pub duration: f64,
}
#[derive(Default)]
pub struct Control {
    pub status: Mutex<Status>,
    pub cancel: AtomicBool,
}
impl Control {
    pub fn snapshot(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
}

pub fn start(
    root: PathBuf,
    control: Arc<Control>,
    exports: Arc<ExportControl>,
    source: String,
    destination: String,
    format: String,
) -> Result<()> {
    ensure!(
        ["m4a", "mp3"].contains(&format.as_str()),
        "Choose M4A or MP3"
    );
    let source = Path::new(&source)
        .canonicalize()
        .context("The source file is unavailable")?;
    ensure!(source.is_file(), "Choose an audio or video file");
    let destination = PathBuf::from(destination);
    ensure!(destination.is_absolute(), "Choose an absolute output path");
    ensure!(
        destination
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(&format)),
        "Use the .{format} extension for this format"
    );
    ensure!(
        !destination.try_exists()?,
        "That output already exists. Choose a different filename."
    );
    let parent = destination
        .parent()
        .context("Choose an output folder")?
        .canonicalize()?;
    let destination = parent.join(
        destination
            .file_name()
            .context("Choose an output filename")?,
    );
    {
        let mut state = control.status.lock().unwrap();
        ensure!(!state.running, "An audio extraction is already running");
        control.cancel.store(false, Ordering::SeqCst);
        *state = Status {
            running: true,
            source: source.to_string_lossy().into_owned(),
            destination: destination.to_string_lossy().into_owned(),
            message: "Checking audio…".into(),
            ..Default::default()
        };
    }
    std::thread::spawn(move || {
        let result = (|| {
            let _guard = exports
                .busy
                .try_lock()
                .map_err(|_| anyhow::anyhow!("Wait for the current media export to finish"))?;
            encode(&root, &control, &source, &destination, &format)
        })();
        let mut state = control.status.lock().unwrap();
        state.running = false;
        match result {
            Ok((bytes, duration)) => {
                state.complete = true;
                state.progress = 1.;
                state.bytes = bytes;
                state.duration = duration;
                state.message = "Audio extracted".into();
            }
            Err(e) => {
                let cancelled = control.cancel.load(Ordering::SeqCst);
                state.message = if cancelled {
                    "Extraction cancelled"
                } else {
                    "Extraction failed"
                }
                .into();
                if !cancelled {
                    state.error = format!("{e:#}");
                }
            }
        }
        crate::runtime_log::push(
            if state.error.is_empty() {
                "info"
            } else {
                "error"
            },
            &format!(
                "{}{}",
                state.message,
                if state.error.is_empty() {
                    String::new()
                } else {
                    format!(": {}", state.error)
                }
            ),
        );
    });
    Ok(())
}

fn probe(root: &Path, source: &Path, stop: &AtomicBool) -> Result<(String, f64)> {
    let mut cmd = Command::new("ffprobe");
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name:format=duration",
        "-of",
        "json",
    ])
    .arg(source);
    let mut json = Vec::new();
    let cancelled = process::run(
        cmd,
        &root.join(format!("probe-{}.log", uuid::Uuid::new_v4())),
        stop,
        Duration::from_secs(20),
        |data| {
            ensure!(
                json.len() + data.len() < 1024 * 1024,
                "Media metadata is too large"
            );
            json.extend_from_slice(data);
            Ok(())
        },
    )?;
    ensure!(!cancelled, "Cancelled");
    let data: Value = serde_json::from_slice(&json)?;
    let codec = data["streams"][0]["codec_name"]
        .as_str()
        .context("This file has no audio track")?
        .to_owned();
    let duration = data["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.)
        .unwrap_or(0.);
    Ok((codec, duration))
}
struct Partial(PathBuf);
impl Drop for Partial {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn encode(
    root: &Path,
    control: &Control,
    source: &Path,
    destination: &Path,
    format: &str,
) -> Result<(u64, f64)> {
    let logs = root.join("tools");
    private_dir(&logs)?;
    let (codec, duration) = probe(&logs, source, &control.cancel)?;
    let copy = format == "m4a" && codec == "aac";
    control.status.lock().unwrap().message = if copy {
        "Copying the original AAC audio…"
    } else {
        "Encoding audio…"
    }
    .into();
    let temporary = Partial(
        destination.with_file_name(format!(".concord-audio-{}.partial", uuid::Uuid::new_v4())),
    );
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i"])
        .arg(source)
        .args(["-map", "0:a:0", "-vn", "-sn", "-dn"]);
    if copy {
        cmd.args(["-c:a", "copy"]);
    } else if format == "mp3" {
        cmd.args(["-c:a", "libmp3lame", "-q:a", "2"]);
    } else {
        cmd.args(["-c:a", "aac", "-b:a", "192k"]);
    }
    if format == "m4a" {
        cmd.args(["-movflags", "+faststart"]);
    }
    cmd.args([
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        if format == "mp3" { "mp3" } else { "mp4" },
    ])
    .arg(&temporary.0);
    let mut pending = String::new();
    let cancelled = process::run(
        cmd,
        &logs.join(format!("extract-{}.log", uuid::Uuid::new_v4())),
        &control.cancel,
        Duration::from_secs(24 * 3600),
        |data| {
            pending.push_str(&String::from_utf8_lossy(data));
            while let Some(end) = pending.find('\n') {
                let line: String = pending.drain(..=end).collect();
                if let Some(micros) = line
                    .trim()
                    .strip_prefix("out_time_us=")
                    .and_then(|v| v.parse::<f64>().ok())
                {
                    if duration > 0. {
                        control.status.lock().unwrap().progress =
                            (micros / 1e6 / duration).clamp(0., 0.99);
                    }
                }
            }
            ensure!(pending.len() < 8192, "Invalid encoder progress");
            Ok(())
        },
    )?;
    ensure!(
        !cancelled && !control.cancel.load(Ordering::SeqCst),
        "Cancelled"
    );
    let file = fs::File::open(&temporary.0)?;
    let bytes = file.metadata()?.len();
    ensure!(bytes > 0, "The encoder produced an empty file");
    file.sync_all()?;
    // Atomic no-replace also prevents a file created during encoding from being overwritten.
    media_files::rename_no_replace(&temporary.0, destination)?;
    Ok((bytes, duration))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_real_audio_rejects_no_audio_and_preserves_existing_output() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let source = root.join("source.wav");
        assert!(Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.3"
            ])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let control = Control::default();
        for format in ["mp3", "m4a"] {
            let target = root.join(format!("audio.{format}"));
            assert!(encode(root, &control, &source, &target, format).unwrap().0 > 0);
            let original = fs::read(&target).unwrap();
            assert!(encode(root, &control, &source, &target, format).is_err());
            assert_eq!(fs::read(&target).unwrap(), original);
        }
        let copied = root.join("copied.m4a");
        encode(root, &control, &root.join("audio.m4a"), &copied, "m4a").unwrap();
        assert!(control.snapshot().message.contains("Copying"));
        let no_audio = root.join("silent.mp4");
        assert!(Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=size=16x16:duration=0.1",
                "-an"
            ])
            .arg(&no_audio)
            .status()
            .unwrap()
            .success());
        assert!(
            encode(root, &control, &no_audio, &root.join("empty.mp3"), "mp3")
                .unwrap_err()
                .to_string()
                .contains("no audio")
        );
        assert!(!root.join("empty.mp3").exists());
        assert!(!fs::read_dir(root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("partial")));
    }
}
