//! Range export: rendered transcript text (txt, md, srt) and media clips through ffmpeg.
use crate::db;
use anyhow::{bail, ensure, Context, Result};
use std::{
    collections::HashMap,
    ffi::OsString,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaFormat {
    M4a,
    Mp3,
    Mp4Fast,
    Mp4Accurate,
}
impl MediaFormat {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "m4a" => Self::M4a,
            "mp3" => Self::Mp3,
            "mp4-fast" => Self::Mp4Fast,
            "mp4-accurate" => Self::Mp4Accurate,
            _ => bail!("Unknown export format: {s}"),
        })
    }
    pub fn needs_video(self) -> bool {
        matches!(self, Self::Mp4Fast | Self::Mp4Accurate)
    }
    fn muxer(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            _ => "mp4",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextFormat {
    Txt,
    Md,
    Srt,
}
impl TextFormat {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "txt" => Self::Txt,
            "md" => Self::Md,
            "srt" => Self::Srt,
            _ => bail!("Unknown transcript format: {s}"),
        })
    }
}

pub struct Line {
    pub start: f64,
    pub end: f64,
    pub speaker: String,
    pub text: String,
}
pub struct Excerpt {
    pub title: String,
    pub channel: String,
    pub date: String,
    pub start: f64,
    pub end: f64,
    pub lines: Vec<Line>,
}

/// One export at a time; the flag lets the UI stop a long accurate encode.
#[derive(Default)]
pub struct ExportControl {
    pub busy: Mutex<()>,
    pub cancel: AtomicBool,
}

pub fn clock(seconds: f64) -> String {
    let v = seconds.max(0.).floor() as u64;
    if v >= 3600 {
        format!("{}:{:02}:{:02}", v / 3600, v / 60 % 60, v % 60)
    } else {
        format!("{}:{:02}", v / 60, v % 60)
    }
}

fn srt_time(seconds: f64) -> String {
    let ms = (seconds.max(0.) * 1000.).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

fn pretty_date(s: &str) -> String {
    if s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
        format!("{}-{}-{}", &s[..4], &s[4..6], &s[6..])
    } else {
        s.to_owned()
    }
}

pub fn validate_range(start: f64, end: f64, duration: f64) -> Result<()> {
    ensure!(
        start.is_finite() && end.is_finite() && start >= 0. && end > start,
        "Choose a range whose end is after its start"
    );
    ensure!(duration <= 0. || end <= duration + 0.5, "The range ends after the recording");
    Ok(())
}

pub fn excerpt(root: &Path, id: &str, start: f64, end: f64) -> Result<Excerpt> {
    let data = db::transcript(root, id)?;
    let media = &data["media"];
    let duration = data["segments"].as_array().into_iter().flatten()
        .filter_map(|s| s["end"].as_f64())
        .fold(media["duration"].as_f64().unwrap_or(0.), f64::max);
    validate_range(start, end, duration)?;
    let end = if duration > 0. { end.min(duration) } else { end };
    let names: HashMap<String, String> = data["assignments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["local_id"].as_str()?.to_owned(), a["name"].as_str()?.to_owned())))
        .collect();
    let lines = data["segments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let (a, b) = (s["start"].as_f64()?, s["end"].as_f64()?);
            if !(b > start && a < end) {
                return None;
            }
            let local = s["speaker"].as_str().unwrap_or("");
            Some(Line {
                start: a,
                end: b,
                speaker: names.get(local).cloned().unwrap_or_else(|| {
                    local.strip_prefix('S').and_then(|n| n.parse::<u64>().ok())
                        .map(|n| format!("Speaker {}", n.saturating_add(1))).unwrap_or_else(|| local.to_owned())
                }),
                text: s["text"].as_str().unwrap_or("").trim().to_owned(),
            })
        })
        .collect();
    Ok(Excerpt {
        title: media["title"].as_str().unwrap_or("Recording").to_owned(),
        channel: media["channel"].as_str().unwrap_or("").to_owned(),
        date: pretty_date(media["date"].as_str().unwrap_or("")),
        start,
        end,
        lines,
    })
}

pub fn render(e: &Excerpt, format: TextFormat) -> String {
    let range = format!("{}–{}", clock(e.start), clock(e.end));
    let source = [e.channel.as_str(), e.date.as_str(), range.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    match format {
        TextFormat::Txt => {
            let header = format!("{}\n{}\n", e.title, source);
            let body: Vec<String> = e
                .lines
                .iter()
                .map(|l| {
                    if l.speaker.is_empty() {
                        format!("[{}] {}", clock(l.start), l.text)
                    } else {
                        format!("[{}] {}: {}", clock(l.start), l.speaker, l.text)
                    }
                })
                .collect();
            if body.is_empty() {
                header
            } else {
                format!("{header}\n{}\n", body.join("\n"))
            }
        }
        TextFormat::Md => {
            let mut out = format!("# {}\n\n{}\n", e.title, source);
            let mut i = 0;
            while i < e.lines.len() {
                let speaker = &e.lines[i].speaker;
                let mut j = i;
                while j < e.lines.len() && &e.lines[j].speaker == speaker {
                    j += 1;
                }
                let text = e.lines[i..j].iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" ");
                let who = if speaker.is_empty() { String::new() } else { format!("**{speaker}** · ") };
                out += &format!("\n{who}{}\n\n> {text}\n", clock(e.lines[i].start));
                i = j;
            }
            out
        }
        TextFormat::Srt => e
            .lines
            .iter()
            .enumerate()
            .map(|(n, l)| {
                let a = (l.start - e.start).max(0.);
                let b = (l.end.min(e.end) - e.start).max(a);
                let text = if l.speaker.is_empty() { l.text.clone() } else { format!("{}: {}", l.speaker, l.text) };
                format!("{}\n{} --> {}\n{}\n\n", n + 1, srt_time(a), srt_time(b), text)
            })
            .collect(),
    }
}

fn partial_path(dest: &Path) -> Result<PathBuf> {
    dest.file_name().context("Choose a file name for the export")?;
    let folder = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    ensure!(folder.is_dir(), "The export folder does not exist");
    Ok(folder.join(format!(".concord-export-{}.partial", uuid::Uuid::new_v4())))
}

/// Covers write, decode, cancellation, and final rename errors without leaving temp files.
struct PartialCleanup(PathBuf);
impl Drop for PartialCleanup {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

fn protect_source(dest: &Path, source: &Path) -> Result<()> {
    if let (Ok(dest), Ok(source)) = (dest.canonicalize(), source.canonicalize()) {
        ensure!(dest != source, "Choose a different file; the export cannot replace its source");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let (a, b) = (dest.metadata()?, source.metadata()?);
            ensure!(a.dev() != b.dev() || a.ino() != b.ino(), "The export cannot replace a link to its source");
        }
    }
    Ok(())
}

pub fn export_transcript(root: &Path, id: &str, start: f64, end: f64, format: TextFormat, dest: &Path) -> Result<PathBuf> {
    let media = db::media(root, id)?;
    for key in ["path", "transcript"] {
        if let Some(source) = media[key].as_str() { protect_source(dest, Path::new(source))?; }
    }
    let text = render(&excerpt(root, id, start, end)?, format);
    let partial = partial_path(dest)?;
    let _cleanup = PartialCleanup(partial.clone());
    std::fs::write(&partial, text)?;
    std::fs::rename(&partial, dest)?;
    Ok(dest.to_path_buf())
}

pub fn ffmpeg_args(source: &Path, start: f64, end: f64, format: MediaFormat, output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-nostdin", "-hide_banner", "-v", "error", "-progress", "pipe:1", "-nostats", "-y", "-ss"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(format!("{start:.3}").into());
    args.push("-i".into());
    args.push(source.into());
    args.push("-t".into());
    args.push(format!("{:.3}", end - start).into());
    let tail: &[&str] = match format {
        MediaFormat::M4a => &["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"],
        MediaFormat::Mp3 => &["-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "2"],
        MediaFormat::Mp4Fast => &[
            "-map", "0:V:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-avoid_negative_ts",
            "make_zero", "-movflags", "+faststart",
        ],
        MediaFormat::Mp4Accurate => &[
            "-map", "0:V:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt",
            "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        ],
    };
    args.extend(tail.iter().map(OsString::from));
    args.push("-f".into());
    args.push(format.muxer().into());
    args.push(output.into());
    args
}

fn has_video(source: &Path) -> Result<bool> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "V:0", "-show_entries", "stream=index", "-of", "csv=p=0"])
        .arg(source)
        .output()
        .context("FFprobe is required to export media")?;
    Ok(out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

fn stderr_tail(s: &str) -> String {
    let t = s.trim();
    let start = t.char_indices().rev().nth(399).map(|(i, _)| i).unwrap_or(0);
    t[start..].to_owned()
}

// Mirrors the IPC command's arguments one-to-one.
#[allow(clippy::too_many_arguments)]
pub fn export_media(
    root: &Path,
    id: &str,
    start: f64,
    end: f64,
    format: MediaFormat,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<PathBuf> {
    let media = db::media(root, id)?;
    validate_range(start, end, media["duration"].as_f64().unwrap_or(0.))?;
    let source = Path::new(media["path"].as_str().context("This recording has no local media file")?)
        .canonicalize()
        .context("Media unavailable. Reconnect its drive or import a copy.")?;
    protect_source(dest, &source)?;
    if format.needs_video() {
        ensure!(has_video(&source)?, "This recording has no video. Export audio instead.");
    }
    let partial = partial_path(dest)?;
    let _cleanup = PartialCleanup(partial.clone());
    let mut child = Command::new("ffmpeg")
        .args(ffmpeg_args(&source, start, end, format, &partial))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("FFmpeg is required to export media")?;
    let mut stderr = child.stderr.take().context("FFmpeg error stream unavailable")?;
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let total = (end - start).max(0.001);
    let stdout = child.stdout.take().context("FFmpeg progress stream unavailable")?;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = errors.join();
                return Err(error.into());
            }
        };
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            break;
        }
        if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
            if let Ok(us) = v.trim().parse::<f64>() {
                progress((us / 1_000_000. / total).clamp(0., 1.));
            }
        }
    }
    let status = child.wait()?;
    let stderr = errors.join().unwrap_or_default();
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&partial);
        bail!("Export cancelled");
    }
    if !status.success() {
        let _ = std::fs::remove_file(&partial);
        bail!("FFmpeg could not export this range: {}", stderr_tail(&stderr));
    }
    std::fs::rename(&partial, dest)?;
    progress(1.);
    Ok(dest.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Excerpt {
        Excerpt {
            title: "Oct 7".into(),
            channel: "Meetings".into(),
            date: "2025-10-07".into(),
            start: 723.,
            end: 735.,
            lines: vec![
                Line { start: 720., end: 726., speaker: "Sarah".into(), text: "First thought.".into() },
                Line { start: 726., end: 730., speaker: "Sarah".into(), text: "Second thought.".into() },
                Line { start: 730., end: 740., speaker: String::new(), text: "Unnamed reply.".into() },
            ],
        }
    }

    #[test]
    fn renders_plain_text() {
        assert_eq!(
            render(&sample(), TextFormat::Txt),
            "Oct 7\nMeetings · 2025-10-07 · 12:03–12:15\n\n[12:00] Sarah: First thought.\n[12:06] Sarah: Second thought.\n[12:10] Unnamed reply.\n"
        );
    }

    #[test]
    fn renders_markdown_grouped_by_speaker() {
        assert_eq!(
            render(&sample(), TextFormat::Md),
            "# Oct 7\n\nMeetings · 2025-10-07 · 12:03–12:15\n\n**Sarah** · 12:00\n\n> First thought. Second thought.\n\n12:10\n\n> Unnamed reply.\n"
        );
    }

    #[test]
    fn renders_srt_relative_to_the_range() {
        assert_eq!(
            render(&sample(), TextFormat::Srt),
            "1\n00:00:00,000 --> 00:00:03,000\nSarah: First thought.\n\n2\n00:00:03,000 --> 00:00:07,000\nSarah: Second thought.\n\n3\n00:00:07,000 --> 00:00:12,000\nUnnamed reply.\n\n"
        );
    }

    #[test]
    fn empty_excerpt_renders_header_only() {
        let mut e = sample();
        e.lines.clear();
        assert_eq!(render(&e, TextFormat::Txt), "Oct 7\nMeetings · 2025-10-07 · 12:03–12:15\n");
        assert_eq!(render(&e, TextFormat::Srt), "");
    }

    #[test]
    fn rejects_bad_ranges() {
        assert!(validate_range(5., 5., 100.).is_err());
        assert!(validate_range(-1., 5., 100.).is_err());
        assert!(validate_range(10., 200., 100.).is_err());
        assert!(validate_range(f64::NAN, 20., 0.).is_err());
        assert!(validate_range(10., 20., 0.).is_ok());
        assert!(validate_range(10., 100.3, 100.).is_ok());
    }

    #[test]
    fn export_paths_are_short_unique_and_never_replace_a_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.ogg");
        std::fs::write(&source, "keep me").unwrap();
        assert!(protect_source(&source, &source).is_err());
        #[cfg(unix)]
        {
            let link = dir.path().join("alias.ogg");
            std::fs::hard_link(&source, &link).unwrap();
            assert!(protect_source(&link, &source).is_err());
        }
        let dest = dir.path().join(format!("{}.txt", "語".repeat(80)));
        let a = partial_path(&dest).unwrap();
        let b = partial_path(&dest).unwrap();
        assert_ne!(a, b);
        assert!(a.file_name().unwrap().len() < 80);
        {
            let _cleanup = PartialCleanup(a.clone());
            std::fs::write(&a, "unfinished").unwrap();
        }
        assert!(!a.exists());
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "keep me");
    }

    #[test]
    fn parses_formats() {
        assert_eq!(MediaFormat::parse("mp4-accurate").unwrap(), MediaFormat::Mp4Accurate);
        assert!(MediaFormat::parse("gif").is_err());
        assert_eq!(TextFormat::parse("srt").unwrap(), TextFormat::Srt);
    }

    #[test]
    fn builds_ffmpeg_arguments() {
        let args: Vec<String> = ffmpeg_args(Path::new("/in.ogg"), 1.5, 4., MediaFormat::M4a, Path::new("/out.part"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|w| w == ["-ss", "1.500"]));
        assert!(args.windows(2).any(|w| w == ["-t", "2.500"]));
        assert!(args.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert_eq!(&args[args.len() - 3..], ["-f", "mp4", "/out.part"]);
        let video: Vec<String> = ffmpeg_args(Path::new("/in.mkv"), 0., 1., MediaFormat::Mp4Fast, Path::new("/o"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(video.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(video.windows(2).any(|w| w == ["-map", "0:V:0"]));
    }

    fn ffmpeg_available() -> bool {
        Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
    }
    fn probe_duration(path: &Path) -> f64 {
        let out = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
    }
    fn media_fixture(dir: &Path) -> PathBuf {
        let root = dir.join("next");
        let audio = dir.join("tone.ogg");
        let video = dir.join("bars.mp4");
        assert!(Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:a", "libvorbis"])
            .arg(&audio)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("ffmpeg")
            .args([
                "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=20:size=320x240:rate=25", "-f", "lavfi", "-i",
                "sine=duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            ])
            .arg(&video)
            .status()
            .unwrap()
            .success());
        db::open(&root)
            .unwrap()
            .execute(
                "INSERT INTO media(id,title,path,duration) VALUES ('audio','Tone',?1,20),('video','Bars',?2,20),('gone','Gone','/nowhere/x.ogg',20)",
                rusqlite::params![audio.to_string_lossy(), video.to_string_lossy()],
            )
            .unwrap();
        root
    }

    #[test]
    fn exports_real_media_ranges() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg not installed");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = media_fixture(tmp.path());
        let cancel = AtomicBool::new(false);
        for (id, format, ext) in [
            ("audio", MediaFormat::M4a, "m4a"),
            ("audio", MediaFormat::Mp3, "mp3"),
            ("video", MediaFormat::Mp4Accurate, "mp4"),
            ("video", MediaFormat::M4a, "m4a"),
        ] {
            let dest = tmp.path().join(format!("{id}-{ext}.{ext}"));
            let mut last = 0.;
            export_media(&root, id, 5., 9.5, format, &dest, &cancel, |p| last = p).unwrap();
            assert!((probe_duration(&dest) - 4.5).abs() < 0.2, "{id} {ext}: {}", probe_duration(&dest));
            assert_eq!(last, 1.);
        }
        let fast = tmp.path().join("fast.mp4");
        export_media(&root, "video", 5., 9.5, MediaFormat::Mp4Fast, &fast, &cancel, |_| {}).unwrap();
        assert!(fast.metadata().unwrap().len() > 0);
        let err = export_media(&root, "audio", 1., 2., MediaFormat::Mp4Accurate, &tmp.path().join("x.mp4"), &cancel, |_| {}).unwrap_err();
        assert!(format!("{err:#}").contains("no video"));
        let err = export_media(&root, "gone", 1., 2., MediaFormat::M4a, &tmp.path().join("g.m4a"), &cancel, |_| {}).unwrap_err();
        assert!(format!("{err:#}").contains("Media unavailable"));
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".partial"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn cancelled_export_leaves_no_file() {
        if !ffmpeg_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = media_fixture(tmp.path());
        let cancel = AtomicBool::new(true);
        let dest = tmp.path().join("c.mp4");
        let err = export_media(&root, "video", 0., 20., MediaFormat::Mp4Accurate, &dest, &cancel, |_| {}).unwrap_err();
        assert!(format!("{err:#}").contains("cancelled"));
        assert!(!dest.exists());
        assert!(!tmp.path().join(".c.mp4.partial").exists());
    }

    #[test]
    fn transcript_export_writes_the_rendered_text() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        let db = db::open(&root).unwrap();
        db.execute_batch(
            "INSERT INTO media(id,title,channel,date,duration) VALUES ('m','Talk','Meetings','20251007',100);
             INSERT INTO segments(media_id,start,end,speaker,text) VALUES ('m',1,4,'S0','Hello there.'),('m',50,52,'S1','Much later.');
             INSERT INTO speakers(id,name) VALUES ('s','Ada');
             INSERT INTO assignments(media_id,local_id,speaker_id) VALUES ('m','S0','s');",
        )
        .unwrap();
        let dest = tmp.path().join("talk.txt");
        export_transcript(&root, "m", 0., 10., TextFormat::Txt, &dest).unwrap();
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "Talk\nMeetings · 2025-10-07 · 0:00–0:10\n\n[0:01] Ada: Hello there.\n"
        );
    }
}
