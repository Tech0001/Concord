//! Host tools run outside AppImage's Python and media-library environment.
use crate::{db, speech};
use anyhow::{bail, Context, Result};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub fn host(command: &mut Command) {
    command
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("LD_LIBRARY_PATH");
}
fn tail(path: &Path, bytes: u64) -> String {
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(bytes)));
    let mut data = Vec::new();
    let _ = f.read_to_end(&mut data);
    String::from_utf8_lossy(&data).into_owned()
}
pub struct Output {
    pub text: String,
    pub success: bool,
    pub error: String,
}
pub fn run(
    root: &Path,
    control: &speech::Control,
    command: Command,
    job: Option<&str>,
    timeout: Duration,
) -> Result<String> {
    let output = capture(root, control, command, job, timeout)?;
    anyhow::ensure!(output.success, "Download tool failed: {}", output.error);
    Ok(output.text)
}
pub fn capture(
    root: &Path,
    control: &speech::Control,
    mut command: Command,
    job: Option<&str>,
    timeout: Duration,
) -> Result<Output> {
    anyhow::ensure!(!control.is_cancelled(), "Cancelled");
    fs::create_dir_all(root.join("logs"))?;
    let key = uuid::Uuid::new_v4().to_string();
    let out = root.join("logs").join(format!("tool-{key}.out"));
    let err = root.join("logs").join(format!("tool-{key}.log"));
    host(&mut command);
    command
        .stdout(Stdio::from(fs::File::create(&out)?))
        .stderr(Stdio::from(fs::File::create(&err)?))
        .stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .context("Cannot start download dependency")?;
    control.set_pid(child.id() as i32);
    let started = Instant::now();
    let mut last = String::new();
    let mut tick = 0;
    let mut failure = None;
    let status = loop {
        if control.is_cancelled()
            || started.elapsed() > timeout
            || out
                .metadata()
                .map(|m| m.len() > 64 * 1024 * 1024)
                .unwrap_or(false)
        {
            failure = Some(if control.is_cancelled() {
                "Cancelled"
            } else if started.elapsed() > timeout {
                "Download tool timed out"
            } else {
                "Source listing is too large"
            });
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            break child.wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if tick % 4 == 0 {
            if let Some(job) = job {
                if let Some(line) = tail(&out, 2048)
                    .lines()
                    .rev()
                    .find(|s| s.starts_with("CONCORD_PROGRESS:"))
                {
                    let text = line.trim_start_matches("CONCORD_PROGRESS:").trim();
                    if text != last {
                        last = text.to_owned();
                        let _ = db::open(root).and_then(|db| {
                            Ok(db.execute(
                                "UPDATE jobs SET message=?1 WHERE id=?2",
                                rusqlite::params![format!("Downloading · {text}"), job],
                            )?)
                        });
                    }
                }
            }
        }
        tick += 1;
        std::thread::sleep(Duration::from_millis(250));
    };
    control.set_pid(0);
    let output = fs::read_to_string(&out).unwrap_or_default();
    let _ = fs::remove_file(&out);
    if let Some(f) = failure {
        bail!("{f}");
    }
    let error = tail(&err, 4000).trim().to_owned();
    if status.success() {
        let _ = fs::remove_file(err);
    }
    Ok(Output {
        text: output,
        success: status.success(),
        error,
    })
}
