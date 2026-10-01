//! One-click, private speech installation. Publish a tested environment atomically.
use crate::{pipeline, runtime_log, speech};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    future::Future,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub status: String,
    pub message: String,
    #[serde(default)]
    pub details: String,
}
#[derive(Default)]
pub struct Control {
    pub process: speech::Control,
    state: Mutex<Status>,
}
pub struct Artifact {
    pub name: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub hash: &'static str,
}
pub const ARTIFACTS: [Artifact; 3] = [
    Artifact { name: "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf", url: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/1c8deaecc64b91f034d73e08dd8b64625eb3395d/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf", bytes: 741548352, hash: "a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae" },
    Artifact { name: "Nemotron-3-Diarization.q8_0.gguf", url: "https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/f667ed73aee57d40cc39428eb768b4fd87a0a29e/Nemotron-3-Diarization.q8_0.gguf", bytes: 107012128, hash: "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1" },
    Artifact { name: "titanet-l.nemo", url: "https://api.ngc.nvidia.com/v2/models/nvidia/nemo/titanet_large/versions/v1/files/titanet-l.nemo", bytes: 101621760, hash: "e838520693f269e7984f55bc8eb3c2d60ccf246bf4b896d4be9bcabe3e4b0fe3" },
];
pub fn models(root: &Path) -> PathBuf {
    root.join("models/nemo")
}
fn log_path(root: &Path) -> PathBuf {
    root.join("logs/speech-setup.log")
}
fn status_path(root: &Path) -> PathBuf {
    root.join("speech/setup.json")
}
pub fn python(folder: &Path) -> PathBuf {
    folder.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    })
}
pub fn active(root: &Path) -> Option<PathBuf> {
    let id = fs::read_to_string(root.join("speech/active")).ok()?;
    let id = uuid::Uuid::parse_str(id.trim()).ok()?;
    let path = root.join("speech/environments").join(id.to_string());
    (path.join("verified").is_file() && python(&path).is_file()).then_some(path)
}
fn publish(root: &Path, environment: &Path) -> Result<()> {
    ensure!(
        environment.parent() == Some(root.join("speech/environments").as_path()),
        "Invalid speech environment"
    );
    let id = environment
        .file_name()
        .context("Missing environment name")?
        .to_string_lossy();
    uuid::Uuid::parse_str(&id)?;
    ensure!(
        environment.join("verified").is_file() && python(environment).is_file(),
        "Speech environment is not verified"
    );
    let temp = root.join("speech/active.tmp");
    fs::write(&temp, id.as_bytes())?;
    fs::File::open(&temp)?.sync_all()?;
    fs::rename(temp, root.join("speech/active"))?;
    Ok(())
}
pub fn status(root: &Path, control: &Control) -> Status {
    let mut state = control.state.lock().unwrap().clone();
    if state.status.is_empty() {
        state = fs::read(status_path(root))
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_default();
        if state.status == "running" {
            state.status = "interrupted".into();
            state.message =
                "Setup was interrupted. Prepare speech to resume; verified models are kept.".into();
        }
    }
    state.details = fs::read_to_string(log_path(root))
        .unwrap_or_default()
        .chars()
        .rev()
        .take(8000)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    state
}
fn report(root: &Path, control: &Control, status: &str, message: &str) -> Result<()> {
    let value = Status {
        status: status.into(),
        message: message.into(),
        details: String::new(),
    };
    fs::create_dir_all(root.join("speech"))?;
    let temp = root.join("speech/setup.tmp");
    fs::write(&temp, serde_json::to_vec(&value)?)?;
    fs::rename(temp, status_path(root))?;
    *control.state.lock().unwrap() = value;
    Ok(())
}
fn check(control: &Control) -> Result<()> {
    ensure!(!control.process.is_cancelled(), "Setup cancelled");
    Ok(())
}
fn verify(path: &Path, artifact: &Artifact) -> Result<()> {
    ensure!(
        fs::metadata(path)?.len() == artifact.bytes,
        "Model size does not match {}",
        artifact.name
    );
    let mut f = fs::File::open(path)?;
    let mut sha = Sha256::new();
    let mut buf = [0u8; 1024 * 128];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
    }
    ensure!(
        format!("{:x}", sha.finalize()) == artifact.hash,
        "Model checksum does not match {}",
        artifact.name
    );
    Ok(())
}
async fn cancellable<T>(
    control: &Control,
    future: impl Future<Output = reqwest::Result<T>>,
) -> Result<T> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return Ok(result?),
            _ = tokio::time::sleep(Duration::from_millis(200)) => check(control)?,
        }
    }
}
fn download(
    root: &Path,
    control: &Control,
    artifact: &Artifact,
    reuse: Option<&Path>,
) -> Result<()> {
    check(control)?;
    let destination = models(root).join(artifact.name);
    report(
        root,
        control,
        "running",
        &format!("Verifying {}", artifact.name),
    )?;
    if verify(&destination, artifact).is_ok() {
        return Ok(());
    }
    fs::create_dir_all(models(root))?;
    let partial = destination.with_extension(format!("{}.partial", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        if let Some(source) = reuse.filter(|p| verify(p, artifact).is_ok()) {
            check(control)?;
            report(
                root,
                control,
                "running",
                &format!("Copying verified model {}", artifact.name),
            )?;
            fs::copy(source, &partial)?;
        } else {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(async {
                    let client = reqwest::Client::builder()
                        .connect_timeout(Duration::from_secs(20))
                        .timeout(Duration::from_secs(3600))
                        .build()?;
                    let mut response = cancellable(control, client.get(artifact.url).send())
                        .await?
                        .error_for_status()?;
                    let mut file = fs::File::create(&partial)?;
                    let mut bytes = 0u64;
                    let mut last = Instant::now() - Duration::from_secs(1);
                    while let Some(chunk) = cancellable(control, response.chunk()).await? {
                        check(control)?;
                        bytes += chunk.len() as u64;
                        ensure!(
                            bytes <= artifact.bytes,
                            "Model download exceeds its expected size"
                        );
                        file.write_all(&chunk)?;
                        if last.elapsed() > Duration::from_millis(500) {
                            report(
                                root,
                                control,
                                "running",
                                &format!(
                                    "Downloading {} · {} / {} MB",
                                    artifact.name,
                                    bytes / 1_000_000,
                                    artifact.bytes / 1_000_000
                                ),
                            )?;
                            last = Instant::now();
                        }
                    }
                    file.sync_all()?;
                    Ok::<(), anyhow::Error>(())
                })?;
        }
        check(control)?;
        verify(&partial, artifact)?;
        fs::rename(&partial, &destination)?;
        Ok(())
    })();
    let _ = fs::remove_file(&partial);
    result
}
fn host(command: &mut Command) {
    command
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("VIRTUAL_ENV");
    command
        .env("OMP_NUM_THREADS", "8")
        .env("MKL_NUM_THREADS", "8");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("UV_") {
            command.env_remove(key);
        }
    }
}
fn run(root: &Path, control: &Control, mut command: Command) -> Result<()> {
    check(control)?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(root))?;
    host(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .context("Cannot start speech setup dependency")?;
    control.process.set_pid(child.id() as i32);
    let started = Instant::now();
    let result = (|| -> Result<()> {
        loop {
            check(control)?;
            ensure!(
                started.elapsed() < Duration::from_secs(3600),
                "Speech setup dependency timed out"
            );
            if let Some(status) = child.try_wait()? {
                ensure!(
                    status.success(),
                    "Speech setup failed. See the setup log for details."
                );
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    })();
    if result.is_err() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    control.process.set_pid(0);
    result
}
fn uv(runtime: &speech::Runtime, root: &Path) -> Result<Command> {
    let resource = runtime
        .binary
        .parent()
        .and_then(Path::parent)
        .context("Missing speech resources")?;
    let tool = resource.join("setup/uv");
    ensure!(tool.is_file(),"Speech installer is missing. Reinstall Concord or stage the setup runtime in a development build.");
    let mut cmd = Command::new(tool);
    cmd.arg("--no-config")
        .arg("--cache-dir")
        .arg(root.join("cache/speech-packages"));
    Ok(cmd)
}
fn install(root: &Path, runtime: &speech::Runtime, control: &Control) -> Result<()> {
    ensure!(
        cfg!(target_os = "linux"),
        "Speech setup currently supports Linux"
    );
    let runtime_status = runtime.status();
    ensure!(runtime_status["runtimeReady"]==true,"The bundled speech runtime is unavailable. Check the runtime error before installing models.");
    ensure!(
        runtime_status["mediaToolsReady"] == true,
        "Install FFmpeg using your Linux package manager before preparing speech."
    );
    let reuse = runtime.models.clone();
    for a in &ARTIFACTS {
        download(root, control, a, Some(&reuse.join(a.name)))?;
    }
    report(root, control, "running", "Preparing private Python 3.12")?;
    let mut cmd = uv(runtime, root)?;
    cmd.args(["python", "install", "3.12.14", "--no-bin", "--install-dir"])
        .arg(root.join("speech/python"));
    run(root, control, cmd)?;
    // The managed interpreter path is discoverable without modifying PATH or the system.
    let interpreter = fs::read_dir(root.join("speech/python"))?
        .filter_map(Result::ok)
        .map(|e| e.path().join("bin/python3.12"))
        .find(|p| p.is_file())
        .context("Private Python installation is incomplete")?;
    let environment = root
        .join("speech/environments")
        .join(uuid::Uuid::new_v4().to_string());
    let result = (|| -> Result<()> {
        let mut cmd = uv(runtime, root)?;
        cmd.args(["venv", "--python"])
            .arg(interpreter)
            .arg(&environment);
        run(root, control, cmd)?;
        report(
            root,
            control,
            "running",
            "Installing CPU-capable voice matching · this can take several minutes",
        )?;
        let resource = runtime.binary.parent().and_then(Path::parent).unwrap();
        let lock_name = if cfg!(target_arch = "aarch64") {
            "requirements-linux-arm64.lock"
        } else {
            "requirements-linux-x64.lock"
        };
        let packaged = resource.join("speech-setup").join(lock_name);
        let lock = if packaged.is_file() {
            packaged
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../speech")
                .join(lock_name)
        };
        ensure!(lock.is_file(), "Voice dependency manifest is missing");
        let mut cmd = uv(runtime, root)?;
        cmd.args(["pip", "install", "--python"])
            .arg(python(&environment))
            .args(["--torch-backend", "cpu", "--require-hashes", "-r"])
            .arg(lock);
        run(root, control, cmd)?;
        report(
            root,
            control,
            "running",
            "Checking voice model and extracting a test fingerprint",
        )?;
        let mut cmd = Command::new(python(&environment));
        cmd.arg("-c").arg("import sys,torch; from nemo.collections.asr.models import EncDecSpeakerLabelModel; m=EncDecSpeakerLabelModel.restore_from(sys.argv[1],map_location='cpu'); m.eval(); x=torch.sin(torch.arange(32000)*0.07).unsqueeze(0); z=m.forward(input_signal=x,input_signal_length=torch.tensor([32000]))[1]; assert z.numel()==192 and bool(torch.isfinite(z).all()); print('Concord voice matching verified on CPU')").arg(models(root).join("titanet-l.nemo"));
        run(root, control, cmd)?;
        check(control)?;
        fs::write(
            environment.join("verified"),
            "nemo=2.7.3 torch=2.13.0+cpu fingerprint=192\n",
        )?;
        publish(root, &environment)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(environment);
    }
    result
}
pub fn start(
    root: PathBuf,
    runtime: speech::Runtime,
    control: Arc<Control>,
    pipeline: Arc<pipeline::Control>,
) -> Result<()> {
    let gate = pipeline.gate.lock().unwrap();
    ensure!(
        !pipeline.closing.load(Ordering::SeqCst),
        "Concord is closing"
    );
    ensure!(
        !pipeline.speech.busy.load(Ordering::SeqCst),
        "Wait for the active recording to finish before preparing speech"
    );
    ensure!(
        !pipeline.previewing.load(Ordering::SeqCst),
        "Stop the live transcript preview before preparing speech"
    );
    ensure!(
        !control.process.busy.load(Ordering::SeqCst),
        "Speech setup is already running"
    );
    fs::create_dir_all(root.join("logs"))?;
    fs::write(log_path(&root), "")?;
    report(&root, &control, "running", "Preparing speech setup")?;
    control.process.begin();
    pipeline.speech.busy.store(true, Ordering::SeqCst);
    drop(gate);
    std::thread::spawn(move || {
        let result = install(&root, &runtime, &control);
        let (status,message)=match result {Ok(())=>("complete","Speech is ready. Models and voice matching are installed independently of Electron.".into()),Err(e) if control.process.is_cancelled()=>("cancelled",format!("{e:#}")),Err(e)=>("failed",format!("{e:#}"))};
        let _ = report(&root, &control, status, &message);
        runtime_log::push(
            if status == "failed" { "error" } else { "info" },
            &format!("Speech setup: {message}"),
        );
        control.process.busy.store(false, Ordering::SeqCst);
        pipeline.speech.busy.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    #[test]
    fn setup_cannot_replace_models_under_a_live_preview() {
        let root = tempfile::tempdir().unwrap();
        let pipeline = Arc::new(pipeline::Control::new(Arc::new(speech::Control::default())));
        pipeline.previewing.store(true, Ordering::SeqCst);
        let result = start(root.path().into(), speech::Runtime::resolve(None), Arc::new(Control::default()), pipeline.clone());
        assert!(result.unwrap_err().to_string().contains("Stop the live transcript preview"));
        assert!(!pipeline.speech.busy.load(Ordering::SeqCst));
        assert!(!root.path().join("speech").exists());
    }
    #[test]
    fn only_a_verified_private_environment_can_become_active() {
        let root = tempfile::tempdir().unwrap();
        let environment = root
            .path()
            .join("speech/environments")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(python(&environment).parent().unwrap()).unwrap();
        fs::write(python(&environment), "fixture").unwrap();
        assert!(publish(root.path(), &environment).is_err());
        assert!(active(root.path()).is_none());
        fs::write(environment.join("verified"), "checked").unwrap();
        publish(root.path(), &environment).unwrap();
        assert_eq!(active(root.path()).unwrap(), environment);
        fs::write(root.path().join("speech/active"), "../../outside").unwrap();
        assert!(active(root.path()).is_none());
    }
    fn server(body: &'static str) -> (String, std::thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model", server.server_addr());
        let task = std::thread::spawn(move || {
            if let Some(req) = server.recv_timeout(Duration::from_secs(10)).unwrap() {
                let _ = req.respond(tiny_http::Response::from_string(body));
            }
        });
        (url, task)
    }
    #[test]
    fn model_download_is_checked_before_replacing_existing_data() {
        let root = tempfile::tempdir().unwrap();
        let control = Control::default();
        fs::create_dir_all(models(root.path())).unwrap();
        let path = models(root.path()).join("fixture");
        fs::write(&path, "previous").unwrap();
        let (url, thread) = server("bad");
        let artifact = Artifact {
            name: "fixture",
            url: Box::leak(url.into_boxed_str()),
            bytes: 3,
            hash: Box::leak(format!("{:x}", Sha256::digest(b"new")).into_boxed_str()),
        };
        assert!(download(root.path(), &control, &artifact, None).is_err());
        thread.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"previous");
        assert_eq!(fs::read_dir(models(root.path())).unwrap().count(), 1);
        let (url, thread) = server("new");
        let artifact = Artifact {
            url: Box::leak(url.into_boxed_str()),
            ..artifact
        };
        download(root.path(), &control, &artifact, None).unwrap();
        thread.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        control.process.cancel();
        assert!(download(root.path(), &control, &artifact, None).is_err());
    }
    #[test]
    fn interrupted_setup_is_actionable_after_restart() {
        let root = tempfile::tempdir().unwrap();
        report(root.path(), &Control::default(), "running", "Downloading").unwrap();
        let saved = status(root.path(), &Control::default());
        assert_eq!(saved.status, "interrupted");
        assert!(saved.message.contains("resume"));
    }
    #[test]
    #[ignore = "downloads and installs a private voice runtime; requires CONCORD_TEST_AUDIO"]
    fn real_independent_install_runs_a_diarized_recording() {
        let input = std::env::var("CONCORD_TEST_AUDIO").expect("CONCORD_TEST_AUDIO");
        let root = tempfile::Builder::new()
            .prefix("concord-speech-setup-")
            .tempdir()
            .unwrap()
            .keep();
        println!("Speech setup scratch library: {}", root.display());
        fs::create_dir_all(root.join("logs")).unwrap();
        let runtime = speech::Runtime::resolve(None);
        install(&root, &runtime, &Control::default()).unwrap();
        let own = runtime.for_root(&root);
        assert!(own.python.starts_with(&root));
        assert!(own.models.starts_with(&root));
        assert_eq!(own.status()["ready"], true);
        db::import_files(&root, std::slice::from_ref(&input)).unwrap();
        let id = db::library(&root, &db::LibraryFilter::default()).unwrap()["items"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        db::open(&root).unwrap().execute("INSERT INTO jobs(id,media_id,title,status) VALUES ('setup-check',?1,'Setup check','running')",[&id]).unwrap();
        speech::process(
            &root,
            &runtime,
            &speech::Control::default(),
            "setup-check",
            &id,
            Path::new(&input),
            "auto",
        )
        .unwrap();
        let result = db::transcript(&root, &id).unwrap();
        assert!(!result["segments"].as_array().unwrap().is_empty());
        assert!(!result["assignments"].as_array().unwrap().is_empty());
        println!(
            "Independent models, Python and voice fingerprints verified: {}",
            root.display()
        );
    }
}
