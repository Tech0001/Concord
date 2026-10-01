//! Audio peaks for the player timeline, decoded once with ffmpeg and cached under the data root.
use crate::db;
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufReader, Read},
    path::Path,
    process::{Command, Stdio},
};

pub const BUCKETS: usize = 2000;

/// Collapse fine peaks into at most `buckets` maxima.
pub fn reduce(fine: &[f32], buckets: usize) -> Vec<f32> {
    let n = buckets.min(fine.len());
    (0..n)
        .map(|i| {
            let a = i * fine.len() / n;
            let b = ((i + 1) * fine.len() / n).max(a + 1);
            fine[a..b].iter().copied().fold(0., f32::max)
        })
        .collect()
}

pub fn peaks(root: &Path, id: &str) -> Result<Vec<f32>> {
    let folder = root.join("waveforms");
    let cache = folder.join(format!("{:x}.json", Sha256::digest(id.as_bytes())));
    if let Ok(file) = File::open(&cache) {
        if let Ok(values) = serde_json::from_reader::<_, Vec<f32>>(BufReader::new(file)) {
            return Ok(values);
        }
    }
    let media = db::media(root, id)?;
    let source = Path::new(media["path"].as_str().context("This recording has no local media file")?)
        .canonicalize()
        .context("Media unavailable. Reconnect its drive or import a copy.")?;
    let mut child = Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(&source)
        .args(["-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("FFmpeg is required for waveforms")?;
    let mut reader = BufReader::new(child.stdout.take().context("FFmpeg output unavailable")?);
    let mut fine = Vec::new();
    let mut chunk = [0u8; 160]; // 80 samples = 10 ms at 8 kHz
    loop {
        let mut filled = 0;
        while filled < chunk.len() {
            let n = match reader.read(&mut chunk[filled..]) {
                Ok(n) => n,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error.into());
                }
            };
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled < 2 {
            break;
        }
        let peak = chunk[..filled - filled % 2]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| i16::from_le_bytes(c).unsigned_abs())
            .max()
            .unwrap_or(0);
        fine.push(f32::from(peak) / 32768.);
        if filled < chunk.len() {
            break;
        }
    }
    ensure!(child.wait()?.success() && !fine.is_empty(), "Could not read audio for the waveform");
    let values = reduce(&fine, BUCKETS);
    std::fs::create_dir_all(&folder)?;
    let partial = folder.join(format!("{}.partial", uuid::Uuid::new_v4()));
    std::fs::write(&partial, serde_json::to_vec(&values)?)?;
    std::fs::rename(&partial, &cache)?;
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduce_takes_bucket_maxima() {
        assert_eq!(reduce(&[0.1, 0.5, 0.2, 0.9, 0.3], 2), vec![0.5, 0.9]);
        assert_eq!(reduce(&[0.3], 10), vec![0.3]);
        assert!(reduce(&[], 10).is_empty());
    }

    #[test]
    fn waveform_errors_for_missing_media() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        db::open(&root)
            .unwrap()
            .execute("INSERT INTO media(id,title,path) VALUES ('x','X','/nowhere/x.ogg')", [])
            .unwrap();
        assert!(peaks(&root, "x").is_err());
    }

    #[test]
    fn waveform_reads_audio_and_caches() {
        if !Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success()) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        let audio = tmp.path().join("tone.ogg");
        assert!(Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:a", "libvorbis"])
            .arg(&audio)
            .status()
            .unwrap()
            .success());
        db::open(&root)
            .unwrap()
            .execute("INSERT INTO media(id,title,path) VALUES ('t','Tone',?1)", [audio.to_string_lossy()])
            .unwrap();
        let first = peaks(&root, "t").unwrap();
        assert_eq!(first.len(), BUCKETS);
        assert!(first.iter().all(|&p| p > 0.05));
        assert_eq!(std::fs::read_dir(root.join("waveforms")).unwrap().count(), 1);
        assert_eq!(peaks(&root, "t").unwrap(), first);
    }
}
