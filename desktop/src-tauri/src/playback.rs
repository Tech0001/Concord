//! WebKitGTK rejects media on custom URI schemes (Tauri issue #3725).
//! Only playback uses loopback HTTP; all application commands remain Tauri IPC.
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

pub struct Playback {
    address: String,
    token: String,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
}
impl Playback {
    pub fn start() -> Result<Self> {
        let server = Arc::new(Server::http("127.0.0.1:0").map_err(|e| anyhow::anyhow!("{e}"))?);
        let address = server.server_addr().to_string();
        let files = Arc::new(Mutex::new(HashMap::new()));
        for _ in 0..4 {
            let server = server.clone();
            let files = files.clone();
            std::thread::spawn(move || {
                while let Ok(request) = server.recv() {
                    serve(request, &files);
                }
            });
        }
        Ok(Self {
            address,
            token: uuid::Uuid::new_v4().to_string(),
            files,
        })
    }
    pub fn register(&self, path: PathBuf) -> String {
        let route = format!("/{}/{}", self.token, uuid::Uuid::new_v4());
        let mut files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        // Only the currently open recording is accessible. No directory serving.
        files.clear();
        files.insert(route.clone(), path);
        format!("http://{}{route}", self.address)
    }
}

fn header(name: &str, value: impl AsRef<str>) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_ref().as_bytes()).unwrap()
}

/// A bounded response lets long recordings seek without reading them into memory.
fn byte_range(value: Option<&str>, length: u64) -> Result<(u64, u64, bool)> {
    let Some(value) = value else {
        return Ok((0, length, false));
    };
    let range = value.strip_prefix("bytes=").context("Invalid range unit")?;
    let (start, end) = range.split_once('-').context("Invalid byte range")?;
    let (start, end) = if start.is_empty() {
        let suffix: u64 = end.parse()?;
        anyhow::ensure!(suffix > 0 && length > 0, "Empty suffix range");
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start: u64 = start.parse()?;
        let end = if end.is_empty() {
            length.saturating_sub(1)
        } else {
            end.parse::<u64>()?.min(length.saturating_sub(1))
        };
        anyhow::ensure!(start < length && start <= end, "Unsatisfiable range");
        (start, end)
    };
    Ok((start, (end - start + 1).min(4 * 1024 * 1024), true))
}

fn serve(request: Request, files: &Mutex<HashMap<String, PathBuf>>) {
    if request.method() != &Method::Get && request.method() != &Method::Head {
        let _ = request.respond(Response::empty(StatusCode(405)));
        return;
    }
    let path = files
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(request.url())
        .cloned();
    let Some(path) = path else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };
    let Ok(mut file) = File::open(&path) else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };
    let Ok(meta) = file.metadata() else {
        return;
    };
    let length = meta.len();
    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str());
    let Ok((start, count, partial)) = byte_range(range, length) else {
        let _ = request.respond(
            Response::empty(StatusCode(416))
                .with_header(header("Content-Range", format!("bytes */{length}"))),
        );
        return;
    };
    let mime = match path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "m4a" => "audio/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    };
    let mut headers = vec![
        header("Content-Type", mime),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "no-store"),
        header("X-Content-Type-Options", "nosniff"),
    ];
    if partial {
        headers.push(header(
            "Content-Range",
            format!("bytes {start}-{}/{length}", start + count - 1),
        ));
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let response = Response::new(
        StatusCode(if partial { 206 } else { 200 }),
        headers,
        file.take(count),
        Some(count as usize),
        None,
    );
    // tiny_http suppresses the body for HEAD while retaining Content-Length.
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpStream};
    #[test]
    fn range_requests_cover_seeks_suffixes_and_invalid_offsets() {
        assert_eq!(
            byte_range(Some("bytes=10-19"), 100).unwrap(),
            (10, 10, true)
        );
        assert_eq!(byte_range(Some("bytes=-10"), 100).unwrap(), (90, 10, true));
        assert_eq!(byte_range(Some("bytes=90-"), 100).unwrap(), (90, 10, true));
        assert_eq!(
            byte_range(Some("bytes=0-"), 9_000_000).unwrap().1,
            4 * 1024 * 1024
        );
        assert!(byte_range(Some("bytes=100-"), 100).is_err());
        assert!(byte_range(Some("bytes=20-10"), 100).is_err());
        assert!(byte_range(Some("bytes=-0"), 100).is_err());
        assert!(byte_range(Some("bytes=0-1,3-4"), 100).is_err());
    }
    #[test]
    fn server_streams_registered_bytes_and_rejects_unknown_paths() {
        let server = Playback::start().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.ogg");
        std::fs::write(&path, b"0123456789").unwrap();
        let url = server.register(path);
        let route = url::Url::parse(&url).unwrap().path().to_owned();
        let fetch = |route: &str, method: &str, range: &str| {
            let mut socket = TcpStream::connect(&server.address).unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            write!(
                socket,
                "{method} {route} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n{range}\r\n",
                server.address
            )
            .unwrap();
            let mut body = String::new();
            socket.read_to_string(&mut body).unwrap();
            body
        };
        let response = fetch(&route, "GET", "Range: bytes=2-5\r\n");
        assert!(response.starts_with("HTTP/1.1 206"));
        assert!(response.ends_with("\r\n\r\n2345"));
        assert!(fetch("/etc/passwd", "GET", "").starts_with("HTTP/1.1 404"));
        assert!(fetch(&route, "HEAD", "").ends_with("\r\n\r\n"));
    }
}
