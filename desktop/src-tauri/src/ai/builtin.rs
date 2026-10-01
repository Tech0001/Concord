//! App-managed, CPU-only embedding service. No Python, API key or external AI app required.
use super::config::Provider;
use crate::model_download::{self, Pinned};
use anyhow::{ensure, Context, Result};
use serde::Serialize;
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
pub const MODEL: &str = "Qwen3-Embedding-0.6B-Q8_0";
const FILE: &str = "Qwen3-Embedding-0.6B-Q8_0.gguf";
const HASH: &str = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439";
const SIZE: u64 = 639150592;
const URL:&str="https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf";
const PINNED: Pinned<'static> = Pinned { url: URL, bytes: SIZE, hash: HASH };
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
/// Download the model if it is missing, resuming a partial file from an earlier attempt.
pub fn download(
    root: &Path,
    check: &dyn Fn() -> Result<()>,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<()> {
    fetch_model(&model_path(root), &PINNED, check, progress)
}
/// One download at a time: setup's early download and an index job can both ask for the model.
static DOWNLOAD: Mutex<()> = Mutex::new(());
fn fetch_model(
    model: &Path,
    pinned: &Pinned,
    check: &dyn Fn() -> Result<()>,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<()> {
    let _turn = DOWNLOAD.lock().unwrap_or_else(|e| e.into_inner());
    match fs::metadata(model) {
        Ok(m) if m.len() == pinned.bytes => return Ok(()),
        // A model of the wrong size can never verify; replace it.
        Ok(_) => fs::remove_file(model)?,
        Err(_) => {}
    }
    fs::create_dir_all(model.parent().context("Invalid model path")?)?;
    let partial = model.with_extension("download");
    model_download::fetch(pinned, &partial, check, progress)
        .context("Cannot download semantic-search model; check your connection and retry")?;
    if let Err(e) = model_download::verify(&partial, pinned) {
        let _ = fs::remove_file(&partial);
        return Err(e.context("The semantic-search model failed verification"));
    }
    fs::rename(&partial, model)?;
    Ok(())
}

/// A download started ahead of time, so search is ready before the first index.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepare {
    pub status: String,
    pub message: String,
    pub done: u64,
    pub total: u64,
}
static PREPARE: Mutex<Prepare> = Mutex::new(Prepare {
    status: String::new(),
    message: String::new(),
    done: 0,
    total: SIZE,
});
static PREPARE_BUSY: AtomicBool = AtomicBool::new(false);
static PREPARE_CANCEL: AtomicBool = AtomicBool::new(false);
fn set_prepare(status: &str, message: &str, done: u64) {
    *PREPARE.lock().unwrap() = Prepare {
        status: status.into(),
        message: message.into(),
        done,
        total: SIZE,
    };
}
pub fn prepare_status(root: &Path) -> Prepare {
    let mut state = PREPARE.lock().unwrap().clone();
    if !PREPARE_BUSY.load(Ordering::SeqCst) && ready(root) {
        state = Prepare {
            status: "complete".into(),
            message: "Search model downloaded".into(),
            done: SIZE,
            total: SIZE,
        };
    }
    state
}
/// Download in the background. `wait` holds the download back while it returns true,
/// so a speech install already running keeps the connection to itself.
pub fn prepare(root: PathBuf, wait: impl Fn() -> bool + Send + 'static) -> Result<()> {
    ensure!(
        !PREPARE_BUSY.swap(true, Ordering::SeqCst),
        "The search model is already downloading"
    );
    PREPARE_CANCEL.store(false, Ordering::SeqCst);
    set_prepare("waiting", "Waiting to download the search model", 0);
    std::thread::spawn(move || {
        let check = || {
            ensure!(!PREPARE_CANCEL.load(Ordering::SeqCst), "Download cancelled");
            Ok(())
        };
        let result = (|| -> Result<()> {
            while wait() {
                check()?;
                set_prepare("waiting", "Waiting for the speech engine to finish", 0);
                std::thread::sleep(Duration::from_secs(1));
            }
            download(&root, &check, &mut |bytes| {
                set_prepare(
                    "running",
                    &format!("Downloading search model · {} of 639 MB", bytes / 1_000_000),
                    bytes,
                );
                Ok(())
            })
        })();
        match result {
            Ok(()) => set_prepare("complete", "Search model downloaded", SIZE),
            Err(e) if PREPARE_CANCEL.load(Ordering::SeqCst) => {
                set_prepare("cancelled", &format!("{e:#}"), 0)
            }
            Err(e) => {
                crate::runtime_log::push("error", &format!("Search model download: {e:#}"));
                set_prepare("failed", &format!("{e:#}"), 0)
            }
        }
        PREPARE_BUSY.store(false, Ordering::SeqCst);
    });
    Ok(())
}
pub fn cancel_prepare() {
    PREPARE_CANCEL.store(true, Ordering::SeqCst);
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
    if !ready(root) {
        progress("Downloading local semantic-search model (639 MB)")?;
        download(root, &|| Ok(()), &mut |bytes| {
            progress(&format!("Downloading local model · {} of 639 MB", bytes / 1_000_000))
        })?;
    }
    progress("Starting local semantic search on CPU")?;
    model_download::verify(&model, &PINNED)?;
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

#[cfg(test)]
mod prepare_tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const BODY: &[u8] = b"embedding model bytes";
    /// Serve the model slowly, counting requests, until it has been idle for a second.
    fn serve() -> (String, std::thread::JoinHandle<usize>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model", server.server_addr());
        let task = std::thread::spawn(move || {
            let mut served = 0;
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(1)) {
                served += 1;
                std::thread::sleep(Duration::from_millis(150));
                let _ = req.respond(tiny_http::Response::from_data(BODY.to_vec()));
            }
            served
        });
        (url, task)
    }
    fn pin(url: String) -> Pinned<'static> {
        Pinned {
            url: Box::leak(url.into_boxed_str()),
            bytes: BODY.len() as u64,
            hash: Box::leak(format!("{:x}", Sha256::digest(BODY)).into_boxed_str()),
        }
    }

    #[test]
    fn two_downloads_of_the_same_model_take_turns() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("models/embedding/model.gguf");
        let (url, server) = serve();
        let pinned = pin(url);
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let (model, pinned) = (model.clone(), Pinned { ..pinned });
                std::thread::spawn(move || fetch_model(&model, &pinned, &|| Ok(()), &mut |_| Ok(())))
            })
            .collect();
        for t in threads {
            t.join().unwrap().unwrap();
        }
        assert_eq!(fs::read(&model).unwrap(), BODY);
        assert_eq!(server.join().unwrap(), 1, "the second download waited and reused the first");
    }

    #[test]
    fn a_model_of_the_wrong_size_is_downloaded_again() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("models/embedding/model.gguf");
        fs::create_dir_all(model.parent().unwrap()).unwrap();
        fs::write(&model, b"left over from an older, broken download").unwrap();
        let (url, server) = serve();
        fetch_model(&model, &pin(url), &|| Ok(()), &mut |_| Ok(())).unwrap();
        assert_eq!(server.join().unwrap(), 1);
        assert_eq!(fs::read(&model).unwrap(), BODY);
    }

    #[test]
    fn a_downloaded_model_reports_complete_without_a_request() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(prepare_status(root.path()).status, "");
        fs::create_dir_all(model_path(root.path()).parent().unwrap()).unwrap();
        fs::File::create(model_path(root.path()))
            .unwrap()
            .set_len(SIZE)
            .unwrap();
        let state = prepare_status(root.path());
        assert_eq!(state.status, "complete");
        assert_eq!((state.done, state.total), (SIZE, SIZE));
        // Starting again with the model present finishes without touching the network.
        prepare(root.path().to_owned(), || false).unwrap();
        for _ in 0..50 {
            if !PREPARE_BUSY.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(prepare_status(root.path()).status, "complete");
    }
}
