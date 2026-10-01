//! App-managed, CPU-only embedding service. No Python, API key or external AI app required.
use super::config::Provider;
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
pub const MODEL: &str = "Qwen3-Embedding-0.6B-Q8_0";
const FILE: &str = "Qwen3-Embedding-0.6B-Q8_0.gguf";
const HASH: &str = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439";
const SIZE: u64 = 639150592;
const URL:&str="https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf";
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();
static SERVER: Mutex<Option<Server>> = Mutex::new(None);
struct Server {
    child: Child,
    provider: Provider,
    root: PathBuf,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub fn initialize(path: PathBuf) {
    let _ = RESOURCES.set(path);
}
pub fn stop() {
    if let Ok(mut server) = SERVER.try_lock() {
        *server = None;
    }
}
fn model_path(root: &Path) -> PathBuf {
    root.join("models/embedding").join(FILE)
}
pub fn ready(root: &Path) -> bool {
    fs::metadata(model_path(root)).is_ok_and(|m| m.len() == SIZE)
}
pub fn default_provider() -> Provider {
    Provider {
        account_id: String::new(),
        enabled: true,
        kind: "builtin".into(),
        base_url: "http://127.0.0.1".into(),
        model: MODEL.into(),
        api_key: String::new(),
    }
}
fn verify(path: &Path) -> Result<()> {
    ensure!(
        fs::metadata(path)?.len() == SIZE,
        "Embedding model is incomplete; remove it and download again"
    );
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    ensure!(
        format!("{:x}", hash.finalize()) == HASH,
        "Embedding model checksum does not match the pinned release"
    );
    Ok(())
}
pub fn provider(root: &Path, mut progress: impl FnMut(&str) -> Result<()>) -> Result<Provider> {
    let mut server = SERVER.lock().unwrap();
    if let Some(s) = server.as_mut() {
        if s.root == root && s.child.try_wait()?.is_none() {
            return Ok(s.provider.clone());
        }
    }
    *server = None;
    let model = model_path(root);
    if !model.exists() {
        progress("Downloading local semantic-search model (639 MB)")?;
        fs::create_dir_all(model.parent().unwrap())?;
        let partial = model.with_extension("download");
        let result = (|| -> Result<()> {
            let client = reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(1800))
                .build()?;
            let mut response = client
                .get(URL)
                .send()
                .context("Cannot download semantic-search model; check your connection and retry")?
                .error_for_status()?;
            let mut file = fs::File::create(&partial)?;
            let mut bytes = 0u64;
            let mut buffer = vec![0; 1024 * 1024];
            let mut last = Instant::now();
            loop {
                let n = response.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                bytes += n as u64;
                ensure!(
                    bytes <= SIZE,
                    "Embedding download exceeds its expected size"
                );
                file.write_all(&buffer[..n])?;
                if last.elapsed() > Duration::from_millis(500) {
                    progress(&format!(
                        "Downloading local model · {} of 639 MB",
                        bytes / 1_000_000
                    ))?;
                    last = Instant::now();
                }
            }
            file.sync_all()?;
            verify(&partial)?;
            fs::rename(&partial, &model)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result?;
    }
    progress("Starting local semantic search on CPU")?;
    verify(&model)?;
    let bin_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let packaged = RESOURCES.get().map(|r| r.join("embedding").join(bin_name));
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../build/binaries/embedding")
        .join(bin_name);
    let binary = packaged.filter(|p| p.is_file()).unwrap_or(dev);
    ensure!(binary.is_file(),"Local embedding runtime is missing. Reinstall Concord or run scripts/build-embedding-runtime.sh for a development build.");
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    let token = uuid::Uuid::new_v4().to_string();
    let mut provider = default_provider();
    provider.base_url = format!("http://127.0.0.1:{port}/v1");
    provider.api_key = token.clone();
    let mut cmd = Command::new(&binary);
    cmd.args(["--model"]).arg(&model).args([
        "--embedding",
        "--pooling",
        "last",
        "--ctx-size",
        "2048",
        "--batch-size",
        "2048",
        "--ubatch-size",
        "2048",
        "--parallel",
        "1",
        "--n-gpu-layers",
        "0",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--no-webui",
        "--offline",
        "--alias",
        MODEL,
        "--threads",
        &std::thread::available_parallelism()
            .map(|n| n.get().min(8))
            .unwrap_or(2)
            .to_string(),
    ]);
    #[cfg(target_os = "linux")]
    cmd.env("LD_LIBRARY_PATH", binary.parent().unwrap());
    cmd.env("LLAMA_API_KEY", token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as i32;
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::other("Concord exited"));
                }
                Ok(())
            });
        }
    }
    let child = cmd
        .spawn()
        .context("Cannot start local embedding runtime")?;
    let mut running = Server {
        child,
        provider: provider.clone(),
        root: root.to_owned(),
    };
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()?;
    let started = Instant::now();
    loop {
        ensure!(
            running.child.try_wait()?.is_none(),
            "Local embedding runtime exited during startup"
        );
        if client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        ensure!(
            started.elapsed() < Duration::from_secs(90),
            "Local embedding runtime took too long to start"
        );
        progress("Starting local semantic search on CPU")?;
        std::thread::sleep(Duration::from_millis(200));
    }
    *server = Some(running);
    Ok(provider)
}
