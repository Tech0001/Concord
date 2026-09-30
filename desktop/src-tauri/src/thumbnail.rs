use crate::db;
use anyhow::Result;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

fn usable(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.is_file() && m.len() > 100)
}

/// Read legacy artwork without changing the old cache. New artwork belongs to Next.
pub fn resolve(root: &Path, id: &str, generator: &Mutex<()>) -> Result<Option<PathBuf>> {
    let media = db::media(root, id)?;
    let path = Path::new(media["path"].as_str().unwrap_or(""));
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if ["ogg", "oga", "opus", "mp3", "m4a", "wav", "flac", "aac"].contains(&ext.as_str()) {
        return Ok(None);
    }
    let folder = root.join("thumbnails");
    let output = folder.join(format!("{:x}.jpg", Sha256::digest(id.as_bytes())));
    if usable(&output) {
        return Ok(Some(output));
    }
    // Imported recording IDs retain the original channel/video pair.
    if let Ok([channel, video]) = serde_json::from_str::<[String; 2]>(id) {
        let source: Option<String> = db::open(root)?
            .query_row(
                "SELECT value FROM settings WHERE key='imported_from'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(source) = source {
            let digest = format!("{:x}", Sha256::digest(format!("{channel}\0{video}")));
            let cached = Path::new(&source)
                .parent()
                .unwrap_or(Path::new("."))
                .join("thumbnails")
                .join(format!("{}.jpg", &digest[..32]));
            if usable(&cached) {
                std::fs::create_dir_all(&folder)?;
                std::fs::copy(cached, &output)?;
                return Ok(Some(output));
            }
        }
    }
    if !path.is_file() {
        return Ok(None);
    }
    let _guard = generator.lock().unwrap_or_else(|e| e.into_inner());
    if usable(&output) {
        return Ok(Some(output));
    }
    std::fs::create_dir_all(&folder)?;
    let temp = folder.join(format!("{}.tmp.jpg", uuid::Uuid::new_v4()));
    let seek = (media["duration"].as_f64().unwrap_or(10.) * 0.1).clamp(0., 60.);
    let child = Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-v",
            "error",
            "-threads",
            "2",
            "-ss",
            &seek.to_string(),
            "-i",
        ])
        .arg(path)
        .args([
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2",
            "-q:v",
            "4",
            "-threads",
            "2",
            "-y",
        ])
        .arg(&temp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return Ok(None);
    };
    let started = Instant::now();
    let success = loop {
        if let Some(status) = child.try_wait()? {
            break status.success();
        }
        if started.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if success && usable(&temp) {
        std::fs::rename(&temp, &output)?;
        Ok(Some(output))
    } else {
        let _ = std::fs::remove_file(temp);
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_artwork_uses_legacy_hash_and_stays_in_its_own_cache() {
        let folder = tempfile::tempdir().unwrap();
        let old = folder.path().join("previous");
        let next = folder.path().join("next");
        std::fs::create_dir_all(old.join("thumbnails")).unwrap();
        let id = r#"["channel","video"]"#;
        let digest = format!("{:x}", Sha256::digest(b"channel\0video"));
        let cached = old
            .join("thumbnails")
            .join(format!("{}.jpg", &digest[..32]));
        let artwork = vec![19u8; 256];
        std::fs::write(&cached, &artwork).unwrap();
        let db = db::open(&next).unwrap();
        db.execute(
            "INSERT INTO settings VALUES ('imported_from',?1)",
            [old.join("pipeline.db").to_string_lossy().as_ref()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO media(id,title,path) VALUES (?1,'Video','/offline/video.mp4')",
            [id],
        )
        .unwrap();
        let image = resolve(&next, id, &Mutex::new(())).unwrap().unwrap();
        assert!(image.starts_with(&next));
        assert_eq!(std::fs::read(image).unwrap(), artwork);
        assert_eq!(std::fs::read(cached).unwrap(), artwork);
    }
}
