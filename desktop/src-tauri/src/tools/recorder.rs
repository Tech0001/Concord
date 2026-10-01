//! Speech capture goes straight to disk. A periodically refreshed WAV header and a small
//! session journal make captured audio recoverable even after an unclean application exit.
use super::{private_dir, process};
use crate::db;
use anyhow::{ensure, Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const RATE: u32 = 16_000;
const BYTES_PER_SECOND: u64 = RATE as u64 * 2;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub category: String,
    pub created_at: String,
    pub status: String,
    pub error: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Active {
    pub id: String,
    pub seconds: f64,
    pub level: f64,
    pub stopping: bool,
}
#[derive(Default)]
pub struct Control {
    gate: Mutex<()>,
    active: Mutex<Option<Active>>,
    pub stop: AtomicBool,
    pub closing: AtomicBool,
}
fn folder(root: &Path, id: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(id).context("Invalid recording session")?;
    let dir = root.join("voice-recordings").join(id);
    ensure!(
        !dir.is_symlink(),
        "Recording session is not a local directory"
    );
    Ok(dir)
}
fn write_session(root: &Path, s: &Session) -> Result<()> {
    let dir = folder(root, &s.id)?;
    let path = dir.join("session.new");
    let mut file = File::create(&path)?;
    file.write_all(&serde_json::to_vec(s)?)?;
    file.sync_all()?;
    fs::rename(path, dir.join("session.json"))?;
    Ok(())
}
fn read_session(root: &Path, id: &str) -> Result<Session> {
    Ok(serde_json::from_slice(&fs::read(
        folder(root, id)?.join("session.json"),
    )?)?)
}
fn sessions(root: &Path) -> Result<Vec<Session>> {
    let base = root.join("voice-recordings");
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(base)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        match read_session(root, &id) {
            Ok(s) if s.id == id && s.status != "saved" => items.push(s),
            Ok(_) => {}
            Err(e) => crate::runtime_log::push(
                "warn",
                &format!("Cannot read voice recording session {id}: {e:#}"),
            ),
        }
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(items)
}
fn audio_bytes(path: &Path) -> u64 {
    path.metadata()
        .map(|m| m.len().saturating_sub(44) / 2 * 2)
        .unwrap_or(0)
}
fn seconds(path: &Path) -> f64 {
    audio_bytes(path) as f64 / BYTES_PER_SECOND as f64
}
pub fn snapshot(root: &Path, c: &Control) -> Result<Value> {
    let active = c.active.lock().unwrap().clone();
    let mut items = Vec::new();
    for s in sessions(root)? {
        if active.as_ref().is_some_and(|a| a.id == s.id) {
            continue;
        }
        let wav = folder(root, &s.id)?.join("recording.wav");
        let mut v = serde_json::to_value(&s)?;
        v["seconds"] = json!(seconds(&wav));
        items.push(v);
    }
    Ok(json!({"active":active,"sessions":items}))
}
fn header(file: &mut File, bytes: u64) -> Result<()> {
    ensure!(
        bytes <= u32::MAX as u64 - 36,
        "The voice recording is too long for WAV"
    );
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(bytes as u32 + 36).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&RATE.to_le_bytes());
    h.extend_from_slice(&(RATE * 2).to_le_bytes());
    h.extend_from_slice(&2u16.to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&(bytes as u32).to_le_bytes());
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&h)?;
    file.seek(SeekFrom::End(0))?;
    Ok(())
}
fn repair_wav(path: &Path) -> Result<()> {
    let bytes = audio_bytes(path);
    let mut file = OpenOptions::new().write(true).open(path)?;
    file.set_len(44 + bytes)?;
    header(&mut file, bytes)?;
    file.sync_all()?;
    Ok(())
}
pub fn recover(root: &Path) -> Result<()> {
    for mut s in sessions(root)? {
        let wav = folder(root, &s.id)?.join("recording.wav");
        if wav.is_file() {
            repair_wav(&wav)?;
        }
        if s.status == "recording" {
            s.status = "recovered".into();
            s.error="Concord closed during capture. The audio already written to disk is available below.".into();
            write_session(root, &s)?;
        }
    }
    Ok(())
}
pub fn inputs(root: &Path) -> Result<Value> {
    #[cfg(not(target_os = "linux"))]
    anyhow::bail!("Microphone capture is currently supported on Linux");
    let mut cmd = Command::new("pactl");
    cmd.args(["--format=json", "list", "sources"]);
    let mut items = vec![json!({"id":"default","name":"System default microphone"})];
    let output = crate::pipeline::subprocess::capture(
        root,
        &crate::speech::Control::default(),
        cmd,
        None,
        Duration::from_secs(5),
    );
    let mut warning = String::new();
    match output {
        Ok(out) if out.success=>{
            let sources:Vec<Value>=serde_json::from_str(&out.text)?;
            for s in sources {
                if let Some(id)=s["name"].as_str(){
                    // Monitor devices record speaker output, not a microphone.
                    if !id.ends_with(".monitor") {items.push(json!({"id":id,"name":s["description"].as_str().unwrap_or(id)}));}
                }
            }
        }
        _=>warning="Input list unavailable. System default uses the microphone selected in your sound settings.".into(),
    }
    Ok(json!({"inputs":items,"warning":warning}))
}
fn validate(title: &str, category: &str) -> Result<()> {
    ensure!(
        !title.trim().is_empty() && title.len() <= 2048 && !title.chars().any(char::is_control),
        "Enter a recording title of at most 2,048 bytes"
    );
    ensure!(
        ["personal", "work"].contains(&category),
        "Choose Personal or Work"
    );
    Ok(())
}
pub fn start(
    root: PathBuf,
    c: Arc<Control>,
    input: String,
    title: String,
    category: String,
) -> Result<String> {
    #[cfg(not(target_os = "linux"))]
    anyhow::bail!("Microphone capture is currently supported on Linux");
    ensure!(
        !input.is_empty() && input.len() < 512 && !input.chars().any(char::is_control),
        "Choose a microphone input"
    );
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "pulse",
        "-name",
        "Concord voice recorder",
        "-i",
        &input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    // The review harness records a synthetic signal, never the user's microphone.
    #[cfg(debug_assertions)]
    if std::env::var_os("CONCORD_NEXT_TEST_SCRIPT").is_some() && input == "concord-test-tone" {
        cmd = synthetic_command();
    }
    begin(root, c, title, category, cmd)
}
#[cfg(any(test, debug_assertions))]
fn synthetic_command() -> Command {
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-v",
        "error",
        "-nostdin",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    cmd
}
fn begin(
    root: PathBuf,
    c: Arc<Control>,
    title: String,
    category: String,
    cmd: Command,
) -> Result<String> {
    let _gate = c.gate.lock().unwrap();
    ensure!(!c.closing.load(Ordering::SeqCst), "Concord is closing");
    ensure!(
        c.active.lock().unwrap().is_none(),
        "A voice recording is already in progress"
    );
    validate(&title, &category)?;
    let id = uuid::Uuid::new_v4().to_string();
    private_dir(&root.join("voice-recordings"))?;
    let dir = folder(&root, &id)?;
    private_dir(&dir)?;
    let mut wav = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(dir.join("recording.wav"))?;
    header(&mut wav, 0)?;
    wav.sync_all()?;
    let session = Session {
        id: id.clone(),
        title: title.trim().into(),
        category,
        created_at: crate::health::now(),
        status: "recording".into(),
        error: String::new(),
    };
    write_session(&root, &session)?;
    c.stop.store(false, Ordering::SeqCst);
    *c.active.lock().unwrap() = Some(Active {
        id: id.clone(),
        seconds: 0.,
        level: 0.,
        stopping: false,
    });
    let worker = c.clone();
    std::thread::spawn(move || {
        let result = capture(&dir, &worker, wav, cmd);
        let _gate = worker.gate.lock().unwrap();
        let mut s = session;
        s.status = "pending".into();
        if let Err(e) = result {
            s.error = format!("{e:#}");
            crate::runtime_log::push("error", &format!("Voice recording stopped: {e:#}"));
        }
        if let Err(e) =
            repair_wav(&dir.join("recording.wav")).and_then(|_| write_session(&root, &s))
        {
            crate::runtime_log::push("error", &format!("Voice recording needs recovery: {e:#}"));
        }
        *worker.active.lock().unwrap() = None;
    });
    Ok(id)
}
fn capture(dir: &Path, c: &Control, mut wav: File, cmd: Command) -> Result<()> {
    let mut written = 0u64;
    let started = Instant::now();
    let mut sync = Instant::now();
    let mut sound = Instant::now();
    process::run(
        cmd,
        &dir.join("capture.log"),
        &c.stop,
        Duration::from_secs(24 * 3600),
        |data| {
            if !data.is_empty() {
                wav.write_all(data)?;
                written += data.len() as u64;
                let level = data
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|s| i16::from_le_bytes([s[0], s[1]]) as f64 / 32768.)
                    .map(f64::abs)
                    .fold(0., f64::max);
                if let Some(a) = c.active.lock().unwrap().as_mut() {
                    a.seconds = written as f64 / BYTES_PER_SECOND as f64;
                    a.level = level;
                }
                sound = Instant::now();
            }
            if sync.elapsed() >= Duration::from_secs(1) {
                header(&mut wav, written / 2 * 2)?;
                wav.sync_data()?;
                sync = Instant::now();
            }
            if sound.elapsed() > Duration::from_millis(500) {
                if let Some(a) = c.active.lock().unwrap().as_mut() {
                    a.level = 0.;
                }
            }
            ensure!(
                written > 0 || started.elapsed() < Duration::from_secs(15),
                "No audio arrived from the microphone. Check your input in system sound settings."
            );
            Ok(())
        },
    )?;
    ensure!(written > 0, "No audio was captured");
    header(&mut wav, written / 2 * 2)?;
    wav.sync_all()?;
    Ok(())
}
pub fn stop(c: &Control) {
    let _gate = c.gate.lock().unwrap();
    if let Some(active) = c.active.lock().unwrap().as_mut() {
        active.stopping = true;
        c.stop.store(true, Ordering::SeqCst);
    }
}
pub fn save(root: &Path, c: &Control, id: &str, title: &str, category: &str) -> Result<String> {
    let _gate = c.gate.lock().unwrap();
    validate(title, category)?;
    ensure!(
        !c.active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.id == id),
        "Stop recording before saving"
    );
    let mut session = read_session(root, id)?;
    let path = folder(root, id)?.join("recording.wav");
    ensure!(audio_bytes(&path) > 0, "This session has no audio to save");
    repair_wav(&path)?;
    let media_id = format!("voice:{id}");
    let db = db::open(root)?;
    db.execute("INSERT OR IGNORE INTO media(id,title,channel,date,duration,path,category,status) VALUES (?1,?2,'Voice notes',date(?6/1000,'unixepoch','localtime'),?3,?4,?5,'ready')",params![media_id,title.trim(),seconds(&path),path.to_string_lossy(),category,session.created_at.parse::<i64>().context("Invalid recording date")?])?;
    session.status = "saved".into();
    session.title = title.trim().into();
    session.category = category.into();
    write_session(root, &session)?;
    Ok(media_id)
}
pub fn discard(root: &Path, c: &Control, id: &str) -> Result<()> {
    let _gate = c.gate.lock().unwrap();
    ensure!(
        !c.active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.id == id),
        "Stop recording before discarding it"
    );
    let session = read_session(root, id)?;
    let saved: bool = db::open(root)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM media WHERE id=?1)",
        [format!("voice:{id}")],
        |r| r.get(0),
    )?;
    ensure!(
        !saved && session.status != "saved",
        "This recording is in the library. Use its file actions to move it to Trash."
    );
    fs::remove_dir_all(folder(root, id)?)?;
    Ok(())
}
pub fn preview(root: &Path, c: &Control, id: &str) -> Result<PathBuf> {
    let _gate = c.gate.lock().unwrap();
    ensure!(
        !c.active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.id == id),
        "Stop capture before playing it back"
    );
    read_session(root, id)?;
    let path = folder(root, id)?.join("recording.wav");
    ensure!(path.is_file(), "Recording unavailable");
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_stop_save_and_recovery_keep_real_pcm() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let c = Arc::new(Control::default());
        let id = begin(
            root.into(),
            c.clone(),
            "Voice test".into(),
            "work".into(),
            synthetic_command(),
        )
        .unwrap();
        assert!(begin(
            root.into(),
            c.clone(),
            "Second".into(),
            "personal".into(),
            synthetic_command()
        )
        .is_err());
        assert!(save(root, &c, &id, "Voice test", "work").is_err());
        let started = Instant::now();
        while c.active.lock().unwrap().as_ref().unwrap().seconds < 0.3 {
            assert!(started.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(50));
        }
        stop(&c);
        while c.active.lock().unwrap().is_some() {
            assert!(started.elapsed() < Duration::from_secs(15));
            std::thread::sleep(Duration::from_millis(50));
        }
        let path = preview(root, &c, &id).unwrap();
        let audio = fs::read(&path).unwrap();
        assert!(audio.len() > 44);
        let mut s = read_session(root, &id).unwrap();
        s.status = "recording".into();
        write_session(root, &s).unwrap();
        let mut f = OpenOptions::new().write(true).open(&path).unwrap();
        header(&mut f, 0).unwrap();
        drop(f);
        recover(root).unwrap();
        assert_eq!(fs::read(&path).unwrap(), audio);
        assert_eq!(read_session(root, &id).unwrap().status, "recovered");
        let saved = save(root, &c, &id, "Saved voice", "work").unwrap();
        assert_eq!(save(root, &c, &id, "Saved voice", "work").unwrap(), saved);
        let media = db::media(root, &saved).unwrap();
        assert_eq!(media["category"], "work");
        assert_eq!(media["channel"], "Voice notes");
        assert_eq!(
            snapshot(root, &c).unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert!(discard(root, &c, &id).is_err());
        assert!(path.is_file());
    }
    #[test]
    fn discard_only_an_unsaved_session_and_validate_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let c = Control::default();
        assert!(folder(root, "../../elsewhere").is_err());
        let id = uuid::Uuid::new_v4().to_string();
        private_dir(&folder(root, &id).unwrap()).unwrap();
        let s = Session {
            id: id.clone(),
            title: "Empty".into(),
            category: "personal".into(),
            status: "pending".into(),
            created_at: String::new(),
            error: String::new(),
        };
        write_session(root, &s).unwrap();
        assert!(save(root, &c, &id, "Empty", "personal").is_err());
        discard(root, &c, &id).unwrap();
        assert!(!folder(root, &id).unwrap().exists());
    }
}
