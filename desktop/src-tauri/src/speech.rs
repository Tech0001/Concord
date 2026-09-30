use crate::{db, transcript};
use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc,
    },
    time::Duration,
};

pub const MODEL: &str = "nvidia/nemotron-3.5-asr-streaming-0.6b";
const ASR: &str = "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf";
const DIAR: &str = "Nemotron-3-Diarization.q8_0.gguf";
const HASHES: [(&str, &str); 2] = [
    (
        ASR,
        "a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae",
    ),
    (
        DIAR,
        "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1",
    ),
];

#[derive(Clone)]
pub struct Runtime {
    pub binary: PathBuf,
    pub script: PathBuf,
    pub python: PathBuf,
    pub models: PathBuf,
}
impl Runtime {
    pub fn resolve(resources: Option<PathBuf>) -> Self {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let resource = resources.unwrap_or_default();
        let pick =
            |packaged: PathBuf, dev: PathBuf| if packaged.is_file() { packaged } else { dev };
        Self {
            binary: std::env::var_os("CONCORD_NEMO_BIN")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    pick(
                        resource.join("nemo/nemo-speech"),
                        source.join("build/binaries/nemo/nemo-speech"),
                    )
                }),
            script: pick(
                resource.join("speech/transcribe-nemo.py"),
                source.join("server/transcription-engines/transcribe-nemo.py"),
            ),
            python: std::env::var_os("CONCORD_SPEAKER_PYTHON")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    db::legacy_root().join(if cfg!(windows) {
                        "venv/Scripts/python.exe"
                    } else {
                        "venv/bin/python"
                    })
                }),
            models: std::env::var_os("CONCORD_NEMO_MODELS")
                .map(PathBuf::from)
                .unwrap_or_else(|| db::legacy_root().join("models/nemo")),
        }
    }
    pub fn status(&self) -> Value {
        let doctor = Command::new(&self.binary)
            .args(["doctor", "--json"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
            .unwrap_or(Value::Null);
        let gpu = doctor["devices"]
            .as_array()
            .and_then(|ds| ds.iter().find(|d| d["type"] == "gpu"));
        let device = if gpu.is_some_and(|g| g["name"].as_str().unwrap_or("").starts_with("Vulkan"))
        {
            "vulkan:0"
        } else {
            "cpu"
        };
        let models = self.models.join(ASR).is_file() && self.models.join(DIAR).is_file();
        json!({"ready":doctor["features"]["asr"]==true&&doctor["features"]["diarization"]==true&&models&&self.python.is_file(),
          "device":device,"gpu":gpu.and_then(|g|g["description"].as_str()),"modelsReady":models,"voiceMatchingReady":self.python.is_file(),
          "binary":self.binary,"python":self.python,"models":self.models,"model":MODEL})
    }
    fn verify(&self) -> Result<()> {
        for (name, expected) in HASHES {
            let mut f = fs::File::open(self.models.join(name)).with_context(|| {
                format!("Install the Nemotron model {name} in the stable Concord app first")
            })?;
            let mut sha = Sha256::new();
            let mut buf = [0u8; 1024 * 128];
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                sha.update(&buf[..n]);
            }
            if format!("{:x}", sha.finalize()) != expected {
                bail!("Model checksum failed for {name}. Repair the model in the stable app.");
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Control {
    pub busy: AtomicBool,
    cancelled: AtomicBool,
    pid: AtomicI32,
}
impl Control {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        {
            let pid = self.pid.load(Ordering::SeqCst);
            if pid > 0 {
                unsafe {
                    libc::kill(-pid, libc::SIGTERM);
                }
            }
        }
    }
}

fn message(root: &Path, id: &str, status: &str, text: &str) -> Result<()> {
    db::open(root)?.execute(
        "UPDATE jobs SET status=?1,message=?2 WHERE id=?3",
        params![status, text, id],
    )?;
    Ok(())
}

fn run_process(
    root: &Path,
    job: &str,
    control: &Control,
    mut command: Command,
    log: &Path,
) -> Result<()> {
    if control.cancelled.load(Ordering::SeqCst) {
        bail!("Cancelled");
    }
    let f = fs::File::create(log)?;
    command
        .stdout(Stdio::from(f.try_clone()?))
        .stderr(Stdio::from(f));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().context("Cannot start speech dependency")?;
    control.pid.store(child.id() as i32, Ordering::SeqCst);
    let mut ticks = 0;
    let status = loop {
        if control.cancelled.load(Ordering::SeqCst) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            break child.wait()?;
        }
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if ticks % 4 == 0 {
            if let Ok(text) = fs::read_to_string(log) {
                if let Some(last) = text.lines().rev().find(|l| !l.trim().is_empty()) {
                    let _ = message(
                        root,
                        job,
                        "running",
                        &last.chars().take(220).collect::<String>(),
                    );
                }
            }
        }
        ticks += 1;
        std::thread::sleep(Duration::from_millis(250));
    };
    control.pid.store(0, Ordering::SeqCst);
    if control.cancelled.load(Ordering::SeqCst) {
        bail!("Cancelled");
    }
    if !status.success() {
        let text = fs::read_to_string(log).unwrap_or_default();
        let tail = text
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        bail!("Processing failed: {tail}");
    }
    Ok(())
}

pub fn start(
    root: PathBuf,
    runtime: Runtime,
    control: Arc<Control>,
    id: String,
    device: String,
) -> Result<String> {
    if !["auto", "cpu", "vulkan:0"].contains(&device.as_str()) {
        bail!("Unsupported device");
    }
    let item = db::media(&root, &id)?;
    let path = PathBuf::from(
        item["path"]
            .as_str()
            .context("This recording has no local media file")?,
    );
    if !path.is_file() {
        bail!("The media file is unavailable. Reconnect its drive or import a local copy.");
    }
    if control.busy.swap(true, Ordering::SeqCst) {
        bail!("A recording is already processing. Wait for it to finish or cancel it.");
    }
    control.cancelled.store(false, Ordering::SeqCst);
    let job = uuid::Uuid::new_v4().to_string();
    let insert = (|| -> Result<()> {
        db::open(&root)?.execute("INSERT INTO jobs(id,media_id,title,status,message) VALUES (?1,?2,?3,'running','Preparing audio')",params![job,id,item["title"].as_str().unwrap_or("Recording")])?;
        Ok(())
    })();
    if let Err(e) = insert {
        control.busy.store(false, Ordering::SeqCst);
        return Err(e);
    }
    let job_id = job.clone();
    std::thread::spawn(move || {
        let result = process(&root, &runtime, &control, &job_id, &id, &path, &device);
        match result {
            Ok(()) => {
                let _ = message(
                    &root,
                    &job_id,
                    "complete",
                    "Transcript and speakers are ready",
                );
            }
            Err(e) => {
                let status = if control.cancelled.load(Ordering::SeqCst) {
                    "cancelled"
                } else {
                    "failed"
                };
                let _ = message(&root, &job_id, status, &format!("{e:#}"));
            }
        }
        control.busy.store(false, Ordering::SeqCst);
    });
    Ok(job)
}

fn process(
    root: &Path,
    runtime: &Runtime,
    control: &Control,
    job: &str,
    id: &str,
    media: &Path,
    device: &str,
) -> Result<()> {
    message(root, job, "running", "Verifying speech models")?;
    runtime.verify()?;
    let status = runtime.status();
    if status["ready"] != true {
        bail!("Nemotron or voice matching is not installed. Review Settings → Speech.");
    }
    let device = if device == "auto" {
        status["device"].as_str().unwrap_or("cpu")
    } else {
        device
    };
    let work = root.join("work").join(job);
    fs::create_dir_all(&work)?;
    let outcome = (|| -> Result<()> {
        let audio = work.join("audio.wav");
        message(root, job, "running", "Preparing audio")?;
        let mut ffmpeg = Command::new("ffmpeg");
        ffmpeg
            .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(media)
            .args([
                "-vn",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-acodec",
                "pcm_s16le",
                "-y",
            ])
            .arg(&audio);
        run_process(root, job, control, ffmpeg, &work.join("audio.log"))?;
        message(
            root,
            job,
            "running",
            "Transcribing and identifying speakers",
        )?;
        let embedding_gpu = device != "cpu"
            && Command::new("nvidia-smi")
                .arg("-L")
                .output()
                .is_ok_and(|o| o.status.success());
        let raw = work.join("transcript.json");
        let diar = work.join("diar.json");
        let mut cmd = Command::new(&runtime.python);
        cmd.arg(&runtime.script)
            .arg(&audio)
            .arg("--output-json")
            .arg(&raw)
            .arg("--diar-output")
            .arg(&diar)
            .arg("--runtime")
            .arg(&runtime.binary)
            .arg("--asr-model")
            .arg(runtime.models.join(ASR))
            .arg("--diar-model")
            .arg(runtime.models.join(DIAR))
            .args([
                "--device",
                device,
                "--language",
                "en-US",
                "--embedding-device",
                if embedding_gpu { "cuda" } else { "cpu" },
            ])
            .env("PYTHONUNBUFFERED", "1")
            .env("OMP_NUM_THREADS", "8")
            .env("MKL_NUM_THREADS", "8");
        if !embedding_gpu {
            cmd.env("CUDA_VISIBLE_DEVICES", "");
        }
        run_process(root, job, control, cmd, &work.join("speech.log"))?;
        let diar: Value = serde_json::from_reader(fs::File::open(diar)?)?;
        let merged = transcript::merge(serde_json::from_reader(fs::File::open(raw)?)?, &diar)?;
        if control.cancelled.load(Ordering::SeqCst) {
            bail!("Cancelled");
        }
        // Unique versions plus a transactional DB pointer keep the previous transcript
        // intact on failure, and never overwrite the stable application's files.
        let out = root.join("transcripts").join(job);
        fs::create_dir_all(&out)?;
        let json_path = out.join("transcript.json");
        let md = out.join("transcript.md");
        fs::write(&json_path, serde_json::to_vec_pretty(&merged)?)?;
        fs::write(&md, transcript::markdown(&merged))?;
        persist(root, id, &md, &merged, &diar)?;
        Ok(())
    })();
    // Keep only small diagnostics, not multi-gigabyte intermediate WAVs.
    if let Ok(text) = fs::read(work.join("speech.log")) {
        let logs = root.join("logs");
        let _ = fs::create_dir_all(&logs);
        let _ = fs::write(logs.join(format!("{job}.log")), text);
    }
    let _ = fs::remove_dir_all(work);
    outcome
}

fn floats(blob: Vec<u8>) -> Vec<f32> {
    blob.as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}
fn persist(root: &Path, id: &str, md: &Path, raw: &Value, diar: &Value) -> Result<()> {
    let mut db = db::open(root)?;
    let voices: Vec<(String, Vec<f32>)> = {
        let mut q = db.prepare("SELECT id,embedding FROM speakers WHERE embedding IS NOT NULL")?;
        let values = q
            .query_map([], |r| Ok((r.get(0)?, floats(r.get(1)?))))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        values
    };
    let tx = db.transaction()?;
    tx.execute("DELETE FROM segments WHERE media_id=?1", [id])?;
    tx.execute("DELETE FROM assignments WHERE media_id=?1", [id])?;
    for s in raw["segments"]
        .as_array()
        .context("No transcript segments")?
    {
        tx.execute(
            "INSERT INTO segments(media_id,start,end,speaker,text) VALUES (?1,?2,?3,?4,?5)",
            params![
                id,
                s["start"].as_f64(),
                s["end"].as_f64(),
                s["speaker"].as_str(),
                s["text"].as_str()
            ],
        )?;
    }
    for profile in diar["speakerProfiles"].as_array().into_iter().flatten() {
        let local = profile["localSpeaker"].as_str().unwrap_or("");
        if !raw["segments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["speaker"] == local)
        {
            continue;
        }
        let centroid: Vec<f32> = profile["centroid"]
            .as_array()
            .context("Missing voice fingerprint")?
            .iter()
            .map(|x| x.as_f64().unwrap_or(0.) as f32)
            .collect();
        let best = voices
            .iter()
            .map(|(id, v)| (id, transcript::cosine(&centroid, v)))
            .filter(|(_, s)| s.is_finite() && *s >= 0.45)
            .max_by(|a, b| a.1.total_cmp(&b.1));
        let bytes: Vec<u8> = centroid.iter().flat_map(|x| x.to_le_bytes()).collect();
        tx.execute("INSERT INTO assignments(media_id,local_id,speaker_id,centroid,airtime,start,end,confidence) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
          params![id,local,best.map(|b|b.0),bytes,profile["airtimeSeconds"].as_f64().unwrap_or(0.),profile["sampleStart"].as_f64(),profile["sampleEnd"].as_f64(),best.map(|b|b.1)])?;
    }
    tx.execute(
        "UPDATE media SET transcript=?1,words=?2,duration=?3,status='complete' WHERE id=?4",
        params![
            md.to_string_lossy(),
            raw["word_count"].as_i64().unwrap_or(0),
            raw["duration_seconds"].as_f64().unwrap_or(0.),
            id
        ],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires installed speech models and CONCORD_TEST_AUDIO"]
    fn real_speech_job_publishes_only_to_new_library() {
        let input = std::env::var("CONCORD_TEST_AUDIO").expect("CONCORD_TEST_AUDIO");
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        db::import_files(root, &[input]).unwrap();
        let items = db::library(root, "", "", 0).unwrap();
        let id = items["items"][0]["id"].as_str().unwrap().to_owned();
        let control = Arc::new(Control::default());
        let job = start(
            root.to_path_buf(),
            Runtime::resolve(None),
            control.clone(),
            id.clone(),
            "auto".into(),
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        while control.busy.load(Ordering::SeqCst) {
            if std::time::Instant::now() > deadline {
                control.cancel();
                panic!("Speech job timed out");
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let row = db::rows(
            &db::open(root).unwrap(),
            "SELECT status,message FROM jobs WHERE id=?1",
            [job],
        )
        .unwrap();
        assert_eq!(row[0]["status"], "complete", "{}", row[0]["message"]);
        let data = db::transcript(root, &id).unwrap();
        assert!(!data["segments"].as_array().unwrap().is_empty());
        assert!(!data["assignments"].as_array().unwrap().is_empty());
        assert!(Path::new(data["media"]["transcript"].as_str().unwrap()).starts_with(root));
        assert!(!db::search(root, "the").unwrap().is_empty());
    }
}
