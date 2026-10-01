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
    files: Arc<Mutex<HashMap<String, (String, PathBuf)>>>,
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
        self.register_for("main", path)
    }
    pub fn release(&self, owner: &str) {
        self.files.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, (slot, _)| slot != owner);
    }
    pub fn register_for(&self, owner: &str, path: PathBuf) -> String {
        let route = format!("/{}/{}", self.token, uuid::Uuid::new_v4());
        let mut files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        // One exact path per player, never directory access. Replacing one player
        // must not invalidate a pop-out video or voice-note preview.
        files.retain(|_, (slot, _)| slot != owner);
        files.insert(route.clone(), (owner.to_owned(), path));
        format!("http://{}{route}", self.address)
    }
}

fn header(name: &str, value: impl AsRef<str>) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_ref().as_bytes()).unwrap()
}

/// Honor the complete requested range. Capping a response at an arbitrary chunk boundary
/// makes GStreamer treat that boundary as EOF and jump to the recording's end.
/// File::take streams through tiny_http, so even a full-file range uses bounded memory.
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
    Ok((start, end - start + 1, true))
}

fn serve(request: Request, files: &Mutex<HashMap<String, (String, PathBuf)>>) {
    if request.method() != &Method::Get && request.method() != &Method::Head {
        let _ = request.respond(Response::empty(StatusCode(405)));
        return;
    }
    let path = files
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(request.url())
        .map(|(_, path)| path.clone());
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
    )
    // Media clients need Content-Length to know the stream is seekable.
    .with_chunked_threshold(usize::MAX);
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
            9_000_000
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
    #[test]
    fn replacing_a_main_recording_does_not_revoke_other_players() {
        let server = Playback::start().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("media.wav");
        std::fs::write(&path, b"test audio").unwrap();
        let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
        let main = server.register(path.clone());
        let popup = server.register_for("popout", path.clone());
        let voice = server.register_for("recorder", path.clone());
        let replacement = server.register(path);
        assert_eq!(client.get(main).send().unwrap().status().as_u16(), 404);
        for url in [&popup, &voice, &replacement] { assert_eq!(client.get(url.as_str()).send().unwrap().text().unwrap(), "test audio"); }
        server.release("popout");
        assert_eq!(client.get(popup).send().unwrap().status().as_u16(), 404);
        assert_eq!(client.get(replacement).send().unwrap().status().as_u16(), 200);
    }
    /// Uses the same GStreamer HTTP reader as WebKitGTK, with no sound or GUI.
    /// Run explicitly on Linux: cargo test gstreamer_seek_reads_past_four_megabytes -- --ignored
    #[test]
    #[ignore = "requires /usr/bin/python with PyGObject and GStreamer"]
    fn gstreamer_seek_reads_past_four_megabytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("minute.wav");
        let data_len = 48_000_u32 * 2 * 2 * 60;
        let mut file = File::create(&path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&2_u16.to_le_bytes()).unwrap();
        file.write_all(&48_000_u32.to_le_bytes()).unwrap();
        file.write_all(&192_000_u32.to_le_bytes()).unwrap();
        file.write_all(&4_u16.to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_len.to_le_bytes()).unwrap();
        file.write_all(&vec![0; data_len as usize]).unwrap();
        drop(file);
        let server = Playback::start().unwrap();
        let url = server.register(path);
        let out = std::process::Command::new("/usr/bin/python")
            .args(["-c", r#"
import gi,sys
gi.require_version('Gst','1.0')
from gi.repository import Gst
Gst.init(None)
p=Gst.ElementFactory.make('playbin');p.props.uri=sys.argv[1]
sink=Gst.ElementFactory.make('fakesink');sink.props.sync=False;sink.props.signal_handoffs=True
last=[0]
def handoff(sink,buf,pad): last[0]=max(last[0],(buf.pts+buf.duration)/Gst.SECOND)
sink.connect('handoff',handoff);p.props.audio_sink=sink
try:
 p.set_state(Gst.State.PAUSED)
 assert p.get_state(10*Gst.SECOND)[0] == Gst.StateChangeReturn.SUCCESS, 'preroll failed'
 assert p.seek_simple(Gst.Format.TIME,Gst.SeekFlags.FLUSH|Gst.SeekFlags.KEY_UNIT,30*Gst.SECOND)
 p.set_state(Gst.State.PLAYING)
 msg=p.get_bus().timed_pop_filtered(10*Gst.SECOND,Gst.MessageType.ERROR|Gst.MessageType.EOS)
 assert msg is not None, 'playback timed out'
 assert msg.type == Gst.MessageType.EOS, str(msg.parse_error())
 assert last[0] > 59, f'stream truncated after seek: final decoded audio was at {last[0]}s'
 print(f'decoded through {last[0]}s after seeking, beyond the old 4 MiB boundary')
finally: p.set_state(Gst.State.NULL)
"#, &url])
            .output().unwrap();
        assert!(out.status.success(), "{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        println!("{}", String::from_utf8_lossy(&out.stdout));
    }

}
