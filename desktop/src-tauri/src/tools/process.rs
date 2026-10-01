use anyhow::{Context, Result};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

// A guard also reaps on callback / I/O errors. The child never outlives the app on Linux.
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

/// Bounded, nonblocking output pumping, including while the encoder is silent or stopping.
pub fn run(
    mut cmd: Command,
    log: &Path,
    stop: &AtomicBool,
    timeout: Duration,
    mut output: impl FnMut(&[u8]) -> Result<()>,
) -> Result<bool> {
    crate::pipeline::subprocess::host(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(fs::File::create(log)?));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        #[cfg(target_os = "linux")]
        unsafe {
            let parent = libc::getpid();
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::other("Application closed"));
                }
                Ok(())
            });
        }
    }
    anyhow::ensure!(!stop.load(Ordering::SeqCst), "Cancelled");
    let mut child = ChildGuard(
        cmd.spawn()
            .context("Cannot start FFmpeg. Install FFmpeg and try again.")?,
    );
    let mut pipe = child.0.stdout.take().context("No FFmpeg output")?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let fd = pipe.as_raw_fd();
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            anyhow::ensure!(
                flags >= 0 && libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) >= 0,
                "Cannot monitor the media process"
            );
        }
    }
    #[cfg(not(unix))]
    anyhow::bail!("Native media tools are currently available on Linux");
    let started = Instant::now();
    let mut stopping = None;
    let mut buffer = [0u8; 8192];
    loop {
        if started.elapsed() > timeout {
            anyhow::bail!("Media tool reached its time limit");
        }
        if stop.load(Ordering::SeqCst) && stopping.is_none() {
            stopping = Some(Instant::now());
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.0.id() as i32), libc::SIGTERM);
            }
        }
        if stopping.is_some_and(|at| at.elapsed() > Duration::from_secs(2)) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.0.id() as i32), libc::SIGKILL);
            }
            let _ = child.0.kill();
        }
        let mut drained = false;
        for _ in 0..64 {
            match pipe.read(&mut buffer) {
                Ok(0) => {
                    drained = true;
                    break;
                }
                Ok(n) => output(&buffer[..n])?,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
        output(&[])?;
        if let Some(status) = child.0.try_wait()? {
            // Drain remaining bytes even when the child exits between polls.
            if !drained {
                continue;
            }
            if stopping.is_some() {
                return Ok(true);
            }
            if !status.success() {
                let mut f = fs::File::open(log)?;
                let len = f.metadata()?.len();
                f.seek(SeekFrom::Start(len.saturating_sub(4000)))?;
                let mut text = String::new();
                let _ = f.read_to_string(&mut text);
                anyhow::bail!("FFmpeg failed: {}", text.trim());
            }
            let _ = fs::remove_file(log);
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_stops_a_silent_process_without_waiting_for_output() {
        let dir = tempfile::tempdir().unwrap();
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let signal = stop.clone();
        let mut cmd = Command::new("ffmpeg");
        cmd.args([
            "-v", "error", "-nostdin", "-re", "-f", "lavfi", "-i", "anullsrc", "-f", "null", "-",
        ]);
        let cancellation = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            signal.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        assert!(run(
            cmd,
            &dir.path().join("silent.log"),
            &stop,
            Duration::from_secs(10),
            |_| Ok(())
        )
        .unwrap());
        cancellation.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}
