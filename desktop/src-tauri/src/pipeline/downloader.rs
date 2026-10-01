//! Explicit, per-library opt-in. No bundled/PATH fallback and no automatic update requests.
use anyhow::{ensure, Context, Result};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

const LATEST: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const OFF: &str = "YouTube downloads are off. Enable them in Settings → YouTube downloads.";
#[derive(Clone, Default, Serialize)]
pub struct Install {
    pub running: bool,
    pub message: String,
    pub error: Option<String>,
    pub done: u64,
    pub total: u64,
}
#[derive(Default)]
pub struct Control {
    state: Mutex<Install>,
    cancel: AtomicBool,
}
impl Control {
    pub fn shutdown(&self) {
        let _guard = self.state.lock().unwrap();
        self.cancel.store(true, Ordering::SeqCst);
    }
}
#[derive(Serialize, Deserialize)]
struct Active {
    directory: String,
    version: String,
    bytes: u64,
    hash: String,
}
fn folder(root: &Path) -> PathBuf {
    root.join("download-tools")
}
pub fn enabled(root: &Path) -> Result<bool> {
    Ok(crate::db::open(root)?
        .query_row(
            "SELECT value FROM settings WHERE key='downloads.enabled'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .as_deref()
        == Some("true"))
}
fn store_enabled(root: &Path, value: bool) -> Result<()> {
    crate::db::open(root)?.execute("INSERT INTO settings VALUES ('downloads.enabled',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [if value { "true" } else { "false" }])?;
    Ok(())
}
fn active(root: &Path) -> Option<(Active, PathBuf)> {
    let a: Active =
        serde_json::from_slice(&fs::read(folder(root).join("active.json")).ok()?).ok()?;
    let id = uuid::Uuid::parse_str(&a.directory).ok()?;
    let file = folder(root)
        .join("versions")
        .join(id.to_string())
        .join("yt-dlp");
    (file.is_file() && file.metadata().ok()?.len() == a.bytes).then_some((a, file))
}
pub fn available(root: &Path) -> bool {
    enabled(root).unwrap_or(false) && active(root).is_some()
}
pub fn binary(root: &Path) -> Result<PathBuf> {
    ensure!(enabled(root)?, OFF);
    active(root)
        .map(|(_, p)| p)
        .context("Install yt-dlp in Settings → YouTube downloads")
}
pub fn status(root: &Path, control: &Control) -> Result<Value> {
    let installed = active(root);
    Ok(
        json!({"enabled":enabled(root)?,"installed":installed.is_some(),"version":installed.as_ref().map(|(a,_)|&a.version),"install":control.state.lock().unwrap().clone()}),
    )
}
pub fn set_enabled(root: &Path, control: &Control, value: bool) -> Result<()> {
    let _guard = control.state.lock().unwrap();
    // Enabling an existing copy is offline. A missing copy is installed by start().
    ensure!(
        !value || active(root).is_some(),
        "Install yt-dlp before enabling downloads"
    );
    store_enabled(root, value)?;
    if !value {
        control.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
fn check(root: &Path, control: &Control) -> Result<()> {
    ensure!(
        !control.cancel.load(Ordering::SeqCst) && enabled(root)?,
        "yt-dlp installation stopped; the previous copy is kept"
    );
    Ok(())
}
fn progress(control: &Control, message: &str, done: u64, total: u64) {
    let mut s = control.state.lock().unwrap();
    s.message = message.into();
    s.done = done;
    s.total = total;
}
fn asset_name() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("yt-dlp_linux"),
        ("linux", "aarch64") => Ok("yt-dlp_linux_aarch64"),
        _ => anyhow::bail!(
            "Managed yt-dlp installation is currently supported on Linux x86_64 and ARM64"
        ),
    }
}
struct Release {
    version: String,
    url: String,
    bytes: u64,
    hash: String,
}
fn release(value: &Value, name: &str) -> Result<Release> {
    ensure!(
        value["draft"] == false && value["prerelease"] == false,
        "Expected a stable yt-dlp release"
    );
    let version = value["tag_name"]
        .as_str()
        .context("Release has no version")?;
    ensure!(
        (8..=40).contains(&version.len())
            && version
                .bytes()
                .all(|c| c.is_ascii_digit() || c == b'.' || c == b'-'),
        "Invalid yt-dlp release version"
    );
    let asset = value["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == name))
        .context("This release has no yt-dlp binary for this computer")?;
    let bytes = asset["size"].as_u64().context("Release has no file size")?;
    ensure!(
        bytes > 0 && bytes <= 256 * 1024 * 1024,
        "Unexpected yt-dlp download size"
    );
    let hash = asset["digest"]
        .as_str()
        .and_then(|h| h.strip_prefix("sha256:"))
        .context("The official release has no SHA-256 checksum; installation was not started")?;
    ensure!(
        hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()),
        "Invalid release checksum"
    );
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/download/{version}/{name}");
    ensure!(
        asset["browser_download_url"].as_str() == Some(&url),
        "Release file must come from the official yt-dlp repository"
    );
    Ok(Release {
        version: version.into(),
        url,
        bytes,
        hash: hash.to_ascii_lowercase(),
    })
}
fn client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .user_agent(concat!("Concord-Next/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .build()?)
}
fn get(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .context("Cannot reach the official yt-dlp repository. Your existing copy is kept.")?
        .error_for_status()?;
    let mut bytes = vec![];
    response.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 2 * 1024 * 1024,
        "Release metadata is too large"
    );
    Ok(bytes)
}
fn publish(
    root: &Path,
    control: &Control,
    release: &Release,
    partial: &Path,
    notices: &[(&str, Vec<u8>)],
) -> Result<()> {
    crate::model_download::verify(
        partial,
        &crate::model_download::Pinned {
            url: &release.url,
            bytes: release.bytes,
            hash: &release.hash,
        },
    )
    .context("yt-dlp integrity check failed")?;
    check(root, control)?;
    let id = uuid::Uuid::new_v4().to_string();
    let directory = folder(root).join("versions").join(&id);
    fs::create_dir_all(&directory)?;
    let executable = directory.join("yt-dlp");
    fs::copy(partial, &executable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))?;
    }
    for (name, data) in notices {
        fs::write(directory.join(name), data)?;
    }
    // The verified executable is invoked without AppImage's Python/library variables.
    let mut cmd = std::process::Command::new(&executable);
    super::subprocess::host(&mut cmd);
    cmd.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    let output = cmd
        .arg("--version")
        .output()
        .context("Cannot start the downloaded yt-dlp")?;
    ensure!(
        output.status.success()
            && String::from_utf8_lossy(&output.stdout).trim() == release.version,
        "Downloaded yt-dlp did not pass its version check"
    );
    let _guard = control.state.lock().unwrap();
    check(root, control)?;
    let data = Active {
        directory: id,
        version: release.version.clone(),
        bytes: release.bytes,
        hash: release.hash.clone(),
    };
    crate::ai::config::private_write(&folder(root), "active.json", &serde_json::to_vec(&data)?)?;
    let _ = fs::remove_file(partial);
    Ok(())
}
fn install(root: &Path, control: &Control) -> Result<String> {
    check(root, control)?;
    let client = client()?;
    let data = get(&client, LATEST)?;
    let release = release(&serde_json::from_slice(&data)?, asset_name()?)?;
    check(root, control)?;
    if let Some((a, p)) = active(root) {
        if a.version == release.version
            && crate::model_download::verify(
                &p,
                &crate::model_download::Pinned {
                    url: &release.url,
                    bytes: release.bytes,
                    hash: &release.hash,
                },
            )
            .is_ok()
        {
            return Ok(format!("yt-dlp {} is up to date", release.version));
        }
    }
    let cache = folder(root).join("cache");
    fs::create_dir_all(&cache)?;
    let partial = cache.join(format!("{}-{}.part", release.version, release.hash));
    let pinned = crate::model_download::Pinned {
        url: &release.url,
        bytes: release.bytes,
        hash: &release.hash,
    };
    crate::model_download::fetch(&pinned, &partial, &|| check(root, control), &mut |done| {
        progress(
            control,
            &format!("Downloading yt-dlp {}", release.version),
            done,
            release.bytes,
        );
        Ok(())
    })?;
    if let Err(e) = crate::model_download::verify(&partial, &pinned) {
        let _ = fs::remove_file(&partial);
        return Err(e.context("yt-dlp integrity check failed; retry to download a fresh copy"));
    }
    let mut notices = vec![];
    for name in ["LICENSE", "THIRD_PARTY_LICENSES.txt"] {
        check(root, control)?;
        notices.push((
            name,
            get(
                &client,
                &format!(
                    "https://raw.githubusercontent.com/yt-dlp/yt-dlp/{}/{name}",
                    release.version
                ),
            )?,
        ));
    }
    publish(root, control, &release, &partial, &notices)?;
    Ok(format!("yt-dlp {} installed", release.version))
}
pub fn start(root: PathBuf, control: Arc<Control>) -> Result<()> {
    asset_name()?;
    let mut state = control.state.lock().unwrap();
    ensure!(!state.running, "yt-dlp installation is already running");
    store_enabled(&root, true)?;
    control.cancel.store(false, Ordering::SeqCst);
    *state = Install {
        running: true,
        message: "Checking the latest stable yt-dlp release on GitHub…".into(),
        ..Default::default()
    };
    drop(state);
    std::thread::spawn(move || {
        let result = install(&root, &control);
        let mut state = control.state.lock().unwrap();
        state.running = false;
        match result {
            Ok(message) => {
                state.message = message;
                state.error = None;
            }
            Err(e) => {
                state.message = "Installation did not complete. Your previous copy is kept.".into();
                state.error = Some(format!("{e:#}"));
            }
        }
    });
    Ok(())
}
#[cfg(test)]
pub(crate) fn fixture(root: &Path) {
    let dir = uuid::Uuid::new_v4().to_string();
    let path = folder(root).join("versions").join(&dir);
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("yt-dlp"), b"fixture").unwrap();
    crate::ai::config::private_write(
        &folder(root),
        "active.json",
        &serde_json::to_vec(&Active {
            directory: dir,
            version: "fixture".into(),
            bytes: 7,
            hash: String::new(),
        })
        .unwrap(),
    )
    .unwrap();
    store_enabled(root, true).unwrap();
}
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn default_off_is_per_library_and_does_not_use_system_or_old_bundles() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        assert!(!enabled(a.path()).unwrap());
        assert!(binary(a.path()).is_err());
        fixture(a.path());
        assert!(available(a.path()));
        assert!(!available(b.path()));
        set_enabled(a.path(), &Control::default(), false).unwrap();
        assert!(!available(a.path()));
        assert!(active(a.path()).is_some());
        set_enabled(a.path(), &Control::default(), true).unwrap();
        assert!(available(a.path()));
    }
    #[test]
    fn stable_official_asset_and_checksum_are_required() {
        let mut value = json!({"draft":false,"prerelease":false,"tag_name":"2026.08.19","assets":[{"name":"yt-dlp_linux","size":100,"digest":format!("sha256:{}","a".repeat(64)),"browser_download_url":"https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux"}]});
        assert!(release(&value, "yt-dlp_linux").is_ok());
        value["prerelease"] = json!(true);
        assert!(release(&value, "yt-dlp_linux").is_err());
        value["prerelease"] = json!(false);
        value["assets"][0]["browser_download_url"] = json!("https://example.com/yt-dlp");
        assert!(release(&value, "yt-dlp_linux").is_err());
        value["assets"][0]["browser_download_url"] =
            json!("https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux");
        value["assets"][0]["digest"] = Value::Null;
        assert!(release(&value, "yt-dlp_linux").is_err());
    }
    #[test]
    fn corrupt_or_cancelled_update_preserves_previous_copy() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let old = binary(root.path()).unwrap();
        let partial = root.path().join("candidate");
        fs::write(&partial, b"bad").unwrap();
        let release = Release {
            version: "2026.08.19".into(),
            url: String::new(),
            bytes: 3,
            hash: format!("{:x}", Sha256::digest(b"yes")),
        };
        let control = Control::default();
        assert!(publish(root.path(), &control, &release, &partial, &[]).is_err());
        assert_eq!(binary(root.path()).unwrap(), old);
        fs::write(&partial, b"yes").unwrap();
        control.cancel.store(true, Ordering::SeqCst);
        assert!(publish(root.path(), &control, &release, &partial, &[]).is_err());
        assert_eq!(binary(root.path()).unwrap(), old);
    }
}

#[cfg(test)]
mod install_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn verified_install_publishes_atomically_and_survives_offline_reenable() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let old = binary(root.path()).unwrap();
        let bytes = b"#!/bin/sh\nprintf '2026.08.19\\n'\n";
        let part = root.path().join("new.part");
        fs::write(&part, bytes).unwrap();
        let release = Release {
            version: "2026.08.19".into(),
            url: String::new(),
            bytes: bytes.len() as u64,
            hash: format!("{:x}", Sha256::digest(bytes)),
        };
        let control = Control::default();
        publish(
            root.path(),
            &control,
            &release,
            &part,
            &[("LICENSE", b"fixture notice".to_vec())],
        )
        .unwrap();
        let current = binary(root.path()).unwrap();
        assert_ne!(current, old);
        assert!(old.is_file());
        assert!(!part.exists());
        assert_eq!(
            fs::read(current.parent().unwrap().join("LICENSE")).unwrap(),
            b"fixture notice"
        );
        set_enabled(root.path(), &control, false).unwrap();
        assert!(binary(root.path()).is_err());
        set_enabled(root.path(), &control, true).unwrap();
        assert_eq!(binary(root.path()).unwrap(), current);
    }
    #[test]
    #[ignore = "downloads the latest official yt-dlp into a scratch library"]
    fn latest_official_install_in_scratch_library() {
        let root = tempfile::tempdir().unwrap();
        let control = Control::default();
        store_enabled(root.path(), true).unwrap();
        let result = install(root.path(), &control).unwrap();
        assert!(available(root.path()));
        println!("{result}");
    }
}
