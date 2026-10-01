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

// AppImage's media framework exports Python paths for its own helpers. Our speech
// coordinator runs in a separate venv; inheriting them hides that venv's stdlib.
fn isolate_python(command: &mut Command) {
    command.env_remove("PYTHONHOME").env_remove("PYTHONPATH");
}

pub const MODEL: &str = "nvidia/nemotron-3.5-asr-streaming-0.6b";
pub(crate) const ASR: &str = "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf";
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
    pub fn for_root(&self, root: &Path) -> Self {
        let mut value=self.clone();
        if let Some(environment)=crate::speech_setup::active(root) {
            if std::env::var_os("CONCORD_SPEAKER_PYTHON").is_none() {value.python=crate::speech_setup::python(&environment);}
            if std::env::var_os("CONCORD_NEMO_MODELS").is_none() {value.models=crate::speech_setup::models(root);}
        }
        value
    }
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
    fn isolate(&self, command: &mut Command) {
        // The AppImage's WebKit/GStreamer libraries must not shadow ggml or the
        // host GPU driver when probing or launching the independent speech runtime.
        #[cfg(target_os = "linux")]
        if let Some(folder) = self.binary.parent() {
            command.env("LD_LIBRARY_PATH", folder);
        }
        isolate_python(command);
    }
    pub fn status(&self) -> Value {
        let mut command = Command::new(&self.binary);
        self.isolate(&mut command);
        command.args(["doctor", "--json"]);
        let (doctor, error) = match command.output() {
            Ok(output) => match serde_json::from_slice::<Value>(&output.stdout) {
                // Doctor exits 1 when GPU support is compiled but no GPU exists.
                // Its valid CPU device remains usable on lower-spec machines.
                Ok(doctor) => (doctor, None),
                Err(_) => (Value::Null, Some(format!("Speech runtime check failed: {}", String::from_utf8_lossy(&output.stderr).chars().take(1500).collect::<String>()))),
            },
            Err(e) => (Value::Null, Some(format!("Cannot start the speech runtime: {e}"))),
        };
        let mut status=self.status_from_doctor(&doctor, error);
        let media=Command::new("ffmpeg").env_remove("LD_LIBRARY_PATH").arg("-version").output().is_ok_and(|o|o.status.success());
        status["mediaToolsReady"]=json!(media);
        if !media {status["ready"]=json!(false);if status["runtimeError"].is_null() {status["runtimeError"]=json!("FFmpeg is unavailable. Install FFmpeg using your Linux package manager, then check again.");}}
        status
    }
    fn status_from_doctor(&self, doctor: &Value, error: Option<String>) -> Value {
        let devices = doctor["devices"].as_array();
        let gpu = devices.and_then(|ds| ds.iter().find(|d| {
            ["gpu", "integrated-gpu"].contains(&d["type"].as_str().unwrap_or(""))
                && d["name"].as_str().unwrap_or("").starts_with("Vulkan")
        }));
        let device = gpu.map(|g| format!("vulkan:{}", g["name"].as_str().unwrap().trim_start_matches("Vulkan"))).unwrap_or_else(|| "cpu".into());
        let cpu = devices.is_some_and(|ds| ds.iter().any(|d| d["type"] == "cpu"));
        let runtime_ready = doctor["features"]["asr"]==true && doctor["features"]["diarization"]==true && (cpu || gpu.is_some());
        let error = error.or_else(|| (!runtime_ready).then(|| "Speech runtime could not load its transcription, diarization, or compute backends.".to_owned()));
        let models = self.models_installed();
        let managed = self.managed();
        let voice = self.voice_installed();
        json!({"ready":runtime_ready&&models&&voice,"runtimeReady":runtime_ready,"runtimeError":error,"managed":managed,
          "device":device,"gpu":gpu.and_then(|g|g["description"].as_str()),"modelsReady":models,"voiceMatchingReady":voice,
          "binary":self.binary,"python":self.python,"models":self.models,"model":MODEL})
    }
    fn models_installed(&self) -> bool {
        self.models.join(ASR).is_file() && self.models.join(DIAR).is_file()
    }
    fn managed(&self) -> bool {
        self.python.parent().and_then(Path::parent).is_some_and(|p| p.join("verified").is_file())
    }
    fn voice_installed(&self) -> bool {
        self.python.is_file() && (!self.managed() || self.models.join("titanet-l.nemo").is_file())
    }
    /// Whether models and voice matching are on disk. Unlike `status`, this does not start the
    /// runtime, so the queue can check it every second.
    pub fn installed(&self) -> bool {
        self.models_installed() && self.voice_installed()
    }
    pub(crate) fn verify(&self) -> Result<()> {
        for (name, expected) in HASHES {
            let mut f = fs::File::open(self.models.join(name)).with_context(|| {
                format!("Speech model {name} is missing. Prepare speech in Settings.")
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
                bail!("Model checksum failed for {name}. Repair speech setup in Settings.");
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
    pub(crate) fn is_cancelled(&self) -> bool {self.cancelled.load(Ordering::SeqCst)}
    pub(crate) fn set_pid(&self, pid: i32) {self.pid.store(pid, Ordering::SeqCst);}
    pub(crate) fn begin(&self) {
        self.busy.store(true, Ordering::SeqCst);
        self.cancelled.store(false, Ordering::SeqCst);
    }
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
    crate::runtime_log::push(if status=="failed" {"error"} else {"info"},&format!("Speech · {text}"));
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
    crate::pipeline::validate_device(&device)?;
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

pub(crate) fn process(
    root: &Path,
    runtime: &Runtime,
    control: &Control,
    job: &str,
    id: &str,
    media: &Path,
    device: &str,
) -> Result<()> {
    process_options(root,runtime,control,job,id,media,&Options{device,language:"en-US",diarize:true})
}
pub(crate) struct Options<'a> {pub device:&'a str,pub language:&'a str,pub diarize:bool}
pub(crate) fn process_options(root:&Path,runtime:&Runtime,control:&Control,job:&str,id:&str,media:&Path,options:&Options<'_>)->Result<()> {
    let runtime=runtime.for_root(root);
    anyhow::ensure!(media.is_file(),"The media file is unavailable. Reconnect its drive before retrying.");
    let device=options.device;
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
        let embedding_gpu = if options.diarize && device != "cpu" && status["managed"] != true {
            let mut probe=Command::new(&runtime.python);runtime.isolate(&mut probe);
            probe.args(["-c","import torch; print('cuda' if torch.cuda.is_available() else 'cpu')"]).output().is_ok_and(|o|o.status.success()&&String::from_utf8_lossy(&o.stdout).trim()=="cuda")
        } else {false};
        let raw = work.join("transcript.json");
        let diar = work.join("diar.json");
        let mut cmd = Command::new(&runtime.python);
        runtime.isolate(&mut cmd);
        cmd.env("OMP_NUM_THREADS","8").env("MKL_NUM_THREADS","8");
        let titanet=runtime.models.join("titanet-l.nemo");
        if titanet.is_file() {cmd.env("CONCORD_TITANET_MODEL",titanet);}
        cmd.arg(&runtime.script)
            .arg(&audio)
            .arg("--output-json")
            .arg(&raw)
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
                options.language,
                "--embedding-device",
                if embedding_gpu { "cuda" } else { "cpu" },
            ])
            .env("PYTHONUNBUFFERED", "1")
            .env("OMP_NUM_THREADS", "8")
            .env("MKL_NUM_THREADS", "8");
        if options.diarize {cmd.arg("--diar-output").arg(&diar);}
        if !embedding_gpu {
            cmd.env("CUDA_VISIBLE_DEVICES", "");
        }
        run_process(root, job, control, cmd, &work.join("speech.log"))?;
        let diar: Value = if options.diarize {serde_json::from_reader(fs::File::open(diar)?)?}else{json!({"segments":[],"speakerProfiles":[]})};
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
    let manual=crate::speech_labels::read(&tx,id)?;
    tx.execute("DELETE FROM speaker_training WHERE media_id=?1",[id])?;
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
        let preserved=crate::speech_labels::matching(&manual,local,&centroid,raw["segments"].as_array().unwrap());
        let assigned=preserved.or_else(||best.map(|b|b.0.as_str()));
        let confidence=if preserved.is_some(){None}else{best.map(|b|b.1)};
        let bytes: Vec<u8> = centroid.iter().flat_map(|x| x.to_le_bytes()).collect();
        tx.execute("INSERT INTO assignments(media_id,local_id,speaker_id,centroid,airtime,start,end,confidence) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
          params![id,local,assigned,bytes,profile["airtimeSeconds"].as_f64().unwrap_or(0.),profile["sampleStart"].as_f64(),profile["sampleEnd"].as_f64(),confidence])?;
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
    crate::health::indexed(&tx,id,md)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn installed_needs_both_models_and_voice_matching() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            binary: dir.path().join("nemo-speech"),
            script: dir.path().join("transcribe.py"),
            python: dir.path().join("venv/bin/python"),
            models: dir.path().join("models"),
        };
        assert!(!runtime.installed());
        fs::create_dir_all(&runtime.models).unwrap();
        fs::write(runtime.models.join(ASR), b"asr").unwrap();
        fs::write(runtime.models.join(DIAR), b"diar").unwrap();
        assert!(!runtime.installed());
        fs::create_dir_all(runtime.python.parent().unwrap()).unwrap();
        fs::write(&runtime.python, b"python").unwrap();
        assert!(runtime.installed());
    }
    use super::*;
    #[test]
    fn replacement_keeps_manual_labels_on_new_voice_numbers_and_rolls_back_on_error() {
        let dir=tempfile::tempdir().unwrap();let root=dir.path();
        let db=db::open(root).unwrap();
        db.execute("INSERT INTO media(id,title,transcript,status) VALUES ('m','Meeting','old.md','complete')",[]).unwrap();
        db.execute("INSERT INTO speakers(id,name) VALUES ('alice','Alice'),('bob','Bob')",[]).unwrap();
        db.execute("INSERT INTO assignments(media_id,local_id,speaker_id) VALUES ('m','S0','alice'),('m','S1','alice'),('m','S2','bob')",[]).unwrap();
        db.execute("INSERT INTO segments(media_id,start,end,speaker,text) VALUES ('m',0,5,'S0','Alice first'),('m',5,10,'S1','Alice second'),('m',10,20,'S2','Bob next')",[]).unwrap();
        let md=root.join("new.md");fs::write(&md,"New transcript").unwrap();
        let raw=json!({"word_count":4,"duration_seconds":20.,"segments":[{"speaker":"new_9","start":0.,"end":10.,"text":"Alice replacement"},{"speaker":"new_3","start":10.,"end":20.,"text":"Bob replacement"}]});
        let bad=json!({"speakerProfiles":[{"localSpeaker":"new_9"}]});
        assert!(persist(root,"m",&md,&raw,&bad).is_err());
        assert_eq!(db::media(root,"m").unwrap()["transcript"],"old.md");
        assert_eq!(db.query_row("SELECT count(*) FROM assignments",[],|r|r.get::<_,i64>(0)).unwrap(),3);
        let diar=json!({"speakerProfiles":[{"localSpeaker":"new_9","centroid":[1.,0.],"airtimeSeconds":10.},{"localSpeaker":"new_3","centroid":[0.,1.],"airtimeSeconds":10.}]});
        persist(root,"m",&md,&raw,&diar).unwrap();
        let rows=db::rows(&db,"SELECT local_id,speaker_id,confidence FROM assignments ORDER BY local_id",[]).unwrap();
        assert_eq!(rows,json!([{"local_id":"new_3","speaker_id":"bob","confidence":null},{"local_id":"new_9","speaker_id":"alice","confidence":null}]).as_array().unwrap().to_vec());
        assert_eq!(db::media(root,"m").unwrap()["transcript"],md.to_string_lossy().as_ref());
    }
    #[test]
    #[cfg(unix)]
    fn speech_python_ignores_appimage_python_paths() {
        let mut command = Command::new("python3");
        command.env("PYTHONHOME", "/missing/concord-appimage/usr")
            .env("PYTHONPATH", "/missing/concord-appimage/usr/share/pyshared")
            .args(["-c", "import encodings, os; assert 'PYTHONHOME' not in os.environ; assert 'PYTHONPATH' not in os.environ; print('stdlib available')"]);
        isolate_python(&mut command);
        let result = command.output().expect("python3 is required for speech runtime tests");
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "stdlib available");
    }
    #[test]
    fn cpu_only_machine_remains_ready_without_a_gpu() {
        let dir = tempfile::tempdir().unwrap();
        for name in [ASR, DIAR, "python"] { fs::write(dir.path().join(name), b"fixture").unwrap(); }
        let runtime = Runtime { binary: dir.path().join("nemo-speech"), script: dir.path().join("coordinator.py"), python: dir.path().join("python"), models: dir.path().to_owned() };
        let doctor = json!({"features":{"asr":true,"diarization":true},"driver_runtime_compatible":false,"devices":[{"type":"cpu","name":"CPU"}]});
        let status = runtime.status_from_doctor(&doctor,None);
        assert_eq!(status["ready"],true);assert_eq!(status["device"],"cpu");
        let bad = runtime.status_from_doctor(&json!({"features":{"asr":true,"diarization":true},"devices":[]}),None);
        assert_eq!(bad["ready"],false);assert!(bad["runtimeError"].is_string());
        let gpu = runtime.status_from_doctor(&json!({"features":{"asr":true,"diarization":true},"devices":[{"type":"gpu","name":"Vulkan0","description":"Test GPU"}]}),None);
        assert_eq!(gpu["device"],"vulkan:0");assert_eq!(gpu["gpu"],"Test GPU");
    }
    #[test]
    #[cfg(target_os="linux")]
    fn speech_process_uses_private_libraries_instead_of_appimage_helpers() {
        let runtime=Runtime::resolve(None);
        let mut command=Command::new("python3");
        command.env("LD_LIBRARY_PATH","/missing/appimage/usr/lib").env("PYTHONHOME","/missing/appimage/usr");
        runtime.isolate(&mut command);
        command.args(["-c","import os, encodings; print(os.environ['LD_LIBRARY_PATH'])"]);
        let output=command.output().unwrap();assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(),runtime.binary.parent().unwrap().to_string_lossy());
    }
    #[test]
    #[ignore = "requires installed speech models and CONCORD_TEST_AUDIO"]
    fn real_transcription_only_job_has_words_without_speaker_assignments() {
        let input = std::env::var("CONCORD_TEST_AUDIO").expect("CONCORD_TEST_AUDIO");
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        db::import_files(root, std::slice::from_ref(&input)).unwrap();
        let id = db::library(root, &db::LibraryFilter::default()).unwrap()["items"][0]["id"].as_str().unwrap().to_owned();
        db::open(root).unwrap().execute("INSERT INTO jobs(id,media_id,title,status) VALUES ('asr-only',?1,'Fixture','running')",[&id]).unwrap();
        process_options(root, &Runtime::resolve(None), &Control::default(), "asr-only", &id, Path::new(&input), &Options {device:"auto",language:"en-US",diarize:false}).unwrap();
        let result = db::transcript(root, &id).unwrap();
        assert!(!result["segments"].as_array().unwrap().is_empty());
        assert!(result["assignments"].as_array().unwrap().is_empty());
    }
    #[test]
    #[ignore = "requires installed speech models and CONCORD_TEST_AUDIO"]
    fn real_speech_job_publishes_only_to_new_library() {
        let input = std::env::var("CONCORD_TEST_AUDIO").expect("CONCORD_TEST_AUDIO");
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        db::import_files(root, &[input]).unwrap();
        let items = db::library(root, &db::LibraryFilter::default()).unwrap();
        let id = items["items"][0]["id"].as_str().unwrap().to_owned();
        let control = Arc::new(Control::default());
        let job = start(
            root.to_path_buf(),
            Runtime::resolve(None),
            control.clone(),
            id.clone(),
            std::env::var("CONCORD_TEST_DEVICE").unwrap_or_else(|_|"auto".into()),
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
