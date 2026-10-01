//! Optional, local ASR preview. Capture never waits for inference and remains recoverable.
use super::{process, recorder};
use crate::{pipeline, speech};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
const RATE: u64 = 16_000;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub start: f64,
    pub end: f64,
    pub text: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Tape {
    samples: u64,
    passages: Vec<Passage>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub id: String,
    pub running: bool,
    pub message: String,
    pub error: String,
    pub device: String,
    pub processed_seconds: f64,
    pub lag_seconds: f64,
    pub passages: Vec<Passage>,
}
#[derive(Default)]
pub struct Control {
    gate: Mutex<()>,
    state: Mutex<State>,
    pub stop: AtomicBool,
}
pub fn snapshot(c: &Control) -> State {
    c.state.lock().unwrap().clone()
}
pub fn busy(c: &Control, id: &str) -> bool {
    let s = c.state.lock().unwrap();
    s.running && s.id == id
}
pub fn stop(c: &Control) {
    c.stop.store(true, Ordering::SeqCst);
}
fn read(dir: &Path) -> Result<Tape> {
    let path = dir.join("preview.json");
    if !path.is_file() {
        return Ok(Tape::default());
    }
    ensure!(
        path.metadata()?.len() <= 5_000_000,
        "Saved preview is too large"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
pub fn recent(dir: &Path) -> Vec<Passage> {
    read(dir)
        .map(|t| {
            t.passages
                .into_iter()
                .rev()
                .take(30)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default()
}
struct Reservation(Arc<pipeline::Control>);
impl Drop for Reservation {
    fn drop(&mut self) {
        self.0.previewing.store(false, Ordering::SeqCst);
    }
}
struct Work(PathBuf);
impl Drop for Work {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn start(
    root: PathBuf,
    c: Arc<Control>,
    recorder: Arc<recorder::Control>,
    queue: Arc<pipeline::Control>,
    runtime: speech::Runtime,
    id: String,
    device: String,
) -> Result<()> {
    let _guard = c.gate.lock().unwrap();
    pipeline::validate_device(&device)?;
    ensure!(
        recorder::active_id(&recorder).as_deref() == Some(&id),
        "Start a recording before enabling its live preview"
    );
    ensure!(
        !snapshot(&c).running,
        "A live transcript preview is already running"
    );
    let dir = recorder::folder(&root, &id)?;
    let tape = read(&dir)?;
    let _gate = queue.gate.lock().unwrap();
    ensure!(!queue.closing.load(Ordering::SeqCst), "Concord is closing");
    ensure!(
        !queue.previewing.swap(true, Ordering::SeqCst),
        "Another live preview is already using speech processing"
    );
    drop(_gate);
    c.stop.store(false, Ordering::SeqCst);
    *c.state.lock().unwrap() = State {
        id: id.clone(),
        running: true,
        message: "Preparing local transcription preview".into(),
        processed_seconds: tape.samples as f64 / RATE as f64,
        passages: recent(&dir),
        ..State::default()
    };
    let worker = c.clone();
    std::thread::spawn(move || {
        let _reservation = Reservation(queue.clone());
        let result = run(
            &root,
            &dir,
            &worker,
            &recorder,
            &queue,
            &runtime.for_root(&root),
            &id,
            &device,
            tape,
        );
        drop(_reservation);
        let mut state = worker.state.lock().unwrap();
        state.running = false;
        if worker.stop.load(Ordering::SeqCst) {
            state.message = "Live preview stopped; captured audio is retained".into();
        } else if let Err(e) = result {
            state.error = format!("{e:#}");
            state.message = "Preview unavailable. Captured audio is unaffected.".into();
            crate::runtime_log::push("warn", &format!("Voice transcript preview: {e:#}"));
        } else {
            state.message = "Preview complete. Transcribe the saved recording for the final transcript and speakers.".into();
        }
    });
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn run(
    root: &Path,
    dir: &Path,
    c: &Control,
    recorder: &recorder::Control,
    queue: &pipeline::Control,
    runtime: &speech::Runtime,
    id: &str,
    device: &str,
    mut tape: Tape,
) -> Result<()> {
    runtime.verify()?;
    let status = runtime.status();
    ensure!(
        status["runtimeReady"] == true,
        "Prepare speech in Settings before using live preview"
    );
    let device = if device == "auto" {
        status["device"].as_str().unwrap_or("cpu")
    } else {
        device
    };
    c.state.lock().unwrap().device = device.into();
    let language = pipeline::config(root)?.speech_language;
    let work = Work(dir.join(format!("preview-work-{}", uuid::Uuid::new_v4())));
    super::private_dir(&work.0)?;
    let source = dir.join("recording.wav");
    loop {
        if c.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let available = source.metadata()?.len().saturating_sub(44) / 2;
        let recording = recorder::active_id(recorder).as_deref() == Some(id);
        ensure!(
            available >= tape.samples,
            "Captured audio changed while previewing"
        );
        let remaining = available - tape.samples;
        {
            let mut s = c.state.lock().unwrap();
            s.lag_seconds = remaining as f64 / RATE as f64;
            s.message = if queue.speech.busy.load(Ordering::SeqCst) {
                "Waiting for the current archive job to finish"
            } else {
                "Listening for the next transcript section"
            }
            .into();
        }
        if !recording && remaining < RATE / 4 {
            return Ok(());
        }
        if queue.speech.busy.load(Ordering::SeqCst) || (recording && remaining < RATE * 10) {
            std::thread::sleep(Duration::from_millis(150));
            continue;
        }
        let count = remaining.min(RATE * 30);
        let wav = work.0.join("section.wav");
        chunk(&source, &wav, tape.samples, count)?;
        c.state.lock().unwrap().message = "Transcribing captured audio locally".into();
        let result = transcribe(runtime, &work.0, &wav, device, &language, &c.stop)?;
        if c.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let passage = normalize(&result, tape.samples, count)?;
        if !passage.text.is_empty() {
            tape.passages.push(passage);
        }
        tape.samples += count;
        ensure!(tape.passages.iter().map(|p| p.text.len()).sum::<usize>() <= 2_000_000, "The live preview reached its text limit. Audio capture is unaffected; use full transcription after saving.");
        crate::ai::config::private_write(dir, "preview.json", &serde_json::to_vec(&tape)?)?;
        let mut state = c.state.lock().unwrap();
        state.processed_seconds = tape.samples as f64 / RATE as f64;
        state.passages = tape
            .passages
            .iter()
            .rev()
            .take(30)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
    }
}
fn chunk(source: &Path, target: &Path, offset: u64, count: u64) -> Result<()> {
    ensure!(
        count > 0 && count <= RATE * 30,
        "Invalid preview section length"
    );
    let mut input = File::open(source)?;
    input.seek(SeekFrom::Start(44 + offset * 2))?;
    let mut audio = vec![0; count as usize * 2];
    input.read_exact(&mut audio)?;
    let mut file = File::create(target)?;
    recorder::header(&mut file, count * 2)?;
    file.write_all(&audio)?;
    Ok(())
}
fn transcribe(
    runtime: &speech::Runtime,
    dir: &Path,
    wav: &Path,
    device: &str,
    language: &str,
    stop: &AtomicBool,
) -> Result<Value> {
    let output = dir.join("section.json");
    if output.exists() {
        fs::remove_file(&output)?;
    }
    let mut cmd = Command::new(&runtime.binary);
    cmd.arg("transcribe")
        .arg(wav)
        .arg("--model")
        .arg(runtime.models.join(speech::ASR))
        .args([
            "--device",
            device,
            "--language",
            language,
            "--stream",
            "--asr.streaming.rnnt_right_context",
            "13",
            "--format",
            "json",
            "--no-batching",
            "--output",
        ])
        .arg(&output)
        .env("OMP_NUM_THREADS", "8")
        .env("MKL_NUM_THREADS", "8");
    process::run_speech(
        cmd,
        &dir.join("preview.log"),
        stop,
        Duration::from_secs(240),
        runtime
            .binary
            .parent()
            .context("Speech runtime has no directory")?,
    )?;
    ensure!(!stop.load(Ordering::SeqCst), "Preview stopped");
    ensure!(
        output.metadata()?.len() <= 10_000_000,
        "Speech preview result is too large"
    );
    Ok(serde_json::from_reader(File::open(output)?)?)
}
fn normalize(raw: &Value, offset: u64, count: u64) -> Result<Passage> {
    let duration = count as f64 / RATE as f64;
    let mut text = Vec::new();
    for word in raw["words"]
        .as_array()
        .context("Speech preview did not return timed words")?
    {
        let start = word["start"].as_f64().context("Invalid word start")?;
        let end = word["end"].as_f64().context("Invalid word end")?;
        ensure!(
            start.is_finite() && end.is_finite() && end >= start,
            "Invalid speech-preview word interval"
        );
        if start < duration && end > 0. {
            text.push(word["word"].as_str().context("Invalid word text")?.trim());
        }
    }
    Ok(Passage {
        start: offset as f64 / RATE as f64,
        end: (offset + count) as f64 / RATE as f64,
        text: text.join(" "),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_preview_models_release_the_queue_without_stopping_audio_capture() {
        let tmp = tempfile::tempdir().unwrap();
        let recorder = Arc::new(recorder::Control::default());
        let id = recorder::begin(
            tmp.path().into(),
            recorder.clone(),
            "Synthetic voice".into(),
            "personal".into(),
            recorder::synthetic_command(),
        )
        .unwrap();
        let queue = Arc::new(pipeline::Control::new(Arc::new(speech::Control::default())));
        let preview = Arc::new(Control::default());
        let runtime = speech::Runtime {
            binary: tmp.path().join("missing-runtime"),
            script: tmp.path().join("script"),
            python: tmp.path().join("python"),
            models: tmp.path().join("no-models"),
        };
        start(
            tmp.path().into(),
            preview.clone(),
            recorder.clone(),
            queue.clone(),
            runtime,
            id.clone(),
            "cpu".into(),
        )
        .unwrap();
        let deadline = std::time::Instant::now();
        while snapshot(&preview).running {
            assert!(deadline.elapsed() < Duration::from_secs(4));
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(snapshot(&preview).error.contains("Speech model"));
        assert!(!queue.previewing.load(Ordering::SeqCst));
        assert_eq!(recorder::active_id(&recorder).as_deref(), Some(id.as_str()));
        std::thread::sleep(Duration::from_millis(400));
        recorder::stop(&recorder);
        while recorder::active_id(&recorder).is_some() {
            assert!(deadline.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            recorder::folder(tmp.path(), &id)
                .unwrap()
                .join("recording.wav")
                .metadata()
                .unwrap()
                .len()
                > 44
        );
    }
    #[test]
    fn wav_sections_use_committed_sample_offsets_and_do_not_touch_capture() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("capture.wav");
        let mut file = File::create(&source).unwrap();
        recorder::header(&mut file, 12).unwrap();
        file.write_all(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
            .unwrap();
        drop(file);
        let original = fs::read(&source).unwrap();
        let target = tmp.path().join("section.wav");
        chunk(&source, &target, 2, 3).unwrap();
        let data = fs::read(&target).unwrap();
        assert_eq!(&data[44..], &[4, 5, 6, 7, 8, 9]);
        assert_eq!(u32::from_le_bytes(data[40..44].try_into().unwrap()), 6);
        assert_eq!(fs::read(&source).unwrap(), original);
    }
    #[test]
    fn padding_words_are_not_attached_to_the_next_preview_section() {
        let raw = serde_json::json!({"words":[{"start":0,"end":1,"word":"Hello"},{"start":9.5,"end":11,"word":"world"},{"start":10,"end":12,"word":"padding"}]});
        let p = normalize(&raw, RATE * 20, RATE * 10).unwrap();
        assert_eq!(p.text, "Hello world");
        assert_eq!((p.start, p.end), (20., 30.));
        assert!(normalize(
            &serde_json::json!({"words":[{"start":5,"end":2,"word":"bad"}]}),
            0,
            RATE * 10
        )
        .is_err());
    }
}
