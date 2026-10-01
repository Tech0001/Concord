//! Pinned model downloads that resume after an interruption and are verified before use.
use anyhow::{ensure, Result};
use reqwest::{header, StatusCode};
use sha2::{Digest, Sha256};
use std::{
    fs,
    future::Future,
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};

pub struct Pinned<'a> {
    pub url: &'a str,
    pub bytes: u64,
    pub hash: &'a str,
}

/// Size and SHA-256 must both match the pinned release.
pub fn verify(path: &Path, pinned: &Pinned) -> Result<()> {
    ensure!(
        fs::metadata(path)?.len() == pinned.bytes,
        "Model size does not match the pinned release"
    );
    let mut file = fs::File::open(path)?;
    let mut sha = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
    }
    ensure!(
        format!("{:x}", sha.finalize()) == pinned.hash,
        "Model checksum does not match the pinned release"
    );
    Ok(())
}

/// Download into `partial`, continuing from its current length when the server honours ranges.
/// The partial file is kept on errors and cancellation so the next attempt resumes.
pub fn fetch(
    pinned: &Pinned,
    partial: &Path,
    check: &dyn Fn() -> Result<()>,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<()> {
    check()?;
    let mut offset = fs::metadata(partial).map(|m| m.len()).unwrap_or(0);
    if offset > pinned.bytes {
        fs::remove_file(partial)?;
        offset = 0;
    }
    if offset == pinned.bytes {
        return progress(offset);
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .timeout(Duration::from_secs(3600))
                .build()?;
            let mut request = client.get(pinned.url);
            if offset > 0 {
                request = request.header(header::RANGE, format!("bytes={offset}-"));
            }
            let response = cancellable(check, request.send()).await?;
            let resumed = offset > 0
                && response.status() == StatusCode::PARTIAL_CONTENT
                && response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.starts_with(&format!("bytes {offset}-")));
            let mut response = if resumed {
                response
            } else {
                // Without a matching range the server sends the whole file from the start.
                ensure!(
                    response.status() != StatusCode::PARTIAL_CONTENT,
                    "The download server returned an unexpected range"
                );
                offset = 0;
                response.error_for_status()?
            };
            let mut file = if resumed {
                fs::OpenOptions::new().append(true).open(partial)?
            } else {
                fs::File::create(partial)?
            };
            let mut bytes = offset;
            progress(bytes)?;
            let mut last = Instant::now();
            while let Some(chunk) = cancellable(check, response.chunk()).await? {
                check()?;
                bytes += chunk.len() as u64;
                ensure!(
                    bytes <= pinned.bytes,
                    "Model download exceeds its expected size"
                );
                file.write_all(&chunk)?;
                if last.elapsed() > Duration::from_millis(500) {
                    progress(bytes)?;
                    last = Instant::now();
                }
            }
            file.sync_all()?;
            progress(bytes)
        })
}

async fn cancellable<T>(
    check: &dyn Fn() -> Result<()>,
    future: impl Future<Output = reqwest::Result<T>>,
) -> Result<T> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return Ok(result?),
            _ = tokio::time::sleep(Duration::from_millis(200)) => check()?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    const BODY: &[u8] = b"pinned model bytes";

    /// Serve `BODY` once. With `ranges`, a `Range: bytes=N-` request gets a 206 from offset N.
    fn serve(ranges: bool) -> (String, mpsc::Receiver<Option<String>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model", server.server_addr());
        let (seen, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let Some(req) = server.recv_timeout(Duration::from_secs(10)).unwrap() else {
                return;
            };
            let range = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("Range"))
                .map(|h| h.value.to_string());
            let _ = seen.send(range.clone());
            let start = range
                .as_deref()
                .and_then(|r| r.strip_prefix("bytes="))
                .and_then(|r| r.trim_end_matches('-').parse::<usize>().ok())
                .filter(|_| ranges);
            let response = match start {
                Some(n) => tiny_http::Response::from_data(BODY[n..].to_vec())
                    .with_status_code(206)
                    .with_header(
                        tiny_http::Header::from_bytes(
                            "Content-Range",
                            format!("bytes {n}-{}/{}", BODY.len() - 1, BODY.len()),
                        )
                        .unwrap(),
                    ),
                None => tiny_http::Response::from_data(BODY.to_vec()),
            };
            let _ = req.respond(response);
        });
        (url, rx)
    }
    fn pinned(url: &str) -> Pinned<'_> {
        Pinned {
            url,
            bytes: BODY.len() as u64,
            hash: Box::leak(format!("{:x}", Sha256::digest(BODY)).into_boxed_str()),
        }
    }

    #[test]
    fn a_partial_download_continues_where_it_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("model.part");
        fs::write(&partial, &BODY[..6]).unwrap();
        let (url, seen) = serve(true);
        let mut reported = Vec::new();
        fetch(&pinned(&url), &partial, &|| Ok(()), &mut |n| {
            reported.push(n);
            Ok(())
        })
        .unwrap();
        assert_eq!(seen.recv().unwrap().as_deref(), Some("bytes=6-"));
        assert_eq!(fs::read(&partial).unwrap(), BODY);
        assert_eq!(reported.first(), Some(&6));
        assert_eq!(reported.last(), Some(&(BODY.len() as u64)));
        verify(&partial, &pinned(&url)).unwrap();
    }

    #[test]
    fn a_server_without_ranges_restarts_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("model.part");
        fs::write(&partial, b"stale!").unwrap();
        let (url, _) = serve(false);
        fetch(&pinned(&url), &partial, &|| Ok(()), &mut |_| Ok(())).unwrap();
        assert_eq!(fs::read(&partial).unwrap(), BODY);
    }

    #[test]
    fn cancelling_keeps_what_was_already_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("model.part");
        fs::write(&partial, &BODY[..6]).unwrap();
        let (url, _) = serve(true);
        let cancelled = fetch(
            &pinned(&url),
            &partial,
            &|| anyhow::bail!("Setup cancelled"),
            &mut |_| Ok(()),
        );
        assert!(cancelled.unwrap_err().to_string().contains("cancelled"));
        assert_eq!(fs::read(&partial).unwrap(), &BODY[..6]);
    }

    #[test]
    fn a_complete_partial_needs_no_request() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("model.part");
        fs::write(&partial, BODY).unwrap();
        fetch(&pinned("http://127.0.0.1:9/never"), &partial, &|| Ok(()), &mut |_| Ok(())).unwrap();
        assert_eq!(fs::read(&partial).unwrap(), BODY);
    }

    #[test]
    fn verification_rejects_wrong_size_or_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model");
        let pin = pinned("unused");
        fs::write(&path, b"short").unwrap();
        assert!(verify(&path, &pin).unwrap_err().to_string().contains("size"));
        fs::write(&path, b"pinned model BYTES").unwrap();
        assert!(verify(&path, &pin).unwrap_err().to_string().contains("checksum"));
        fs::write(&path, BODY).unwrap();
        verify(&path, &pin).unwrap();
    }
}
