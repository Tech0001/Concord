//! Manual Discover downloads share the durable queue without creating subscriptions.
use super::{config, queue, Control};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;

pub fn existing(db: &Connection, video: &str) -> Result<Option<String>> {
    // Imported archives may use short/watch/live/shorts URLs for the same video.
    let rows = crate::db::rows(
        db,
        "SELECT id,url FROM media WHERE instr(url,?1)>0",
        [video],
    )?;
    for row in rows {
        let Some(url) = row["url"]
            .as_str()
            .and_then(|s| super::download::youtube_url(s).ok())
        else {
            continue;
        };
        let matches = url.query_pairs().any(|(k, v)| k == "v" && v == video)
            || url
                .path_segments()
                .is_some_and(|mut parts| parts.any(|p| p == video));
        if matches {
            return Ok(row["id"].as_str().map(str::to_owned));
        }
    }
    Ok(None)
}
pub fn enqueue(
    root: &Path,
    c: &Control,
    hit: &crate::tools::discover::Hit,
    category: &str,
) -> Result<Value> {
    ensure!(
        crate::tools::discover::valid_id(&hit.video_id),
        "Choose a valid YouTube video"
    );
    ensure!(
        ["personal", "work"].contains(&category),
        "Choose Personal or Work"
    );
    ensure!(
        hit.title.len() <= 20_000 && hit.channel_name.len() <= 4000,
        "Video metadata is too large"
    );
    let _gate = c.gate.lock().unwrap();
    let mut db = crate::db::open(root)?;
    let cfg = config(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let id = if let Some(id) = existing(&tx, &hit.video_id)? {
        let (path, status): (Option<String>, String) =
            tx.query_row("SELECT path,status FROM media WHERE id=?1", [&id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        if status == "archived" || path.as_deref().is_some_and(|p| Path::new(p).is_file()) {
            return Ok(json!({"id":id,"action":"existing"}));
        }
        id
    } else {
        let id = format!("youtube:{}", hit.video_id);
        let url = format!("https://www.youtube.com/watch?v={}", hit.video_id);
        let date = hit
            .published_at
            .get(..10)
            .filter(|s| s.bytes().all(|b| b.is_ascii_digit() || b == b'-'))
            .unwrap_or("");
        tx.execute("INSERT INTO media(id,title,url,channel,category,date,status) VALUES (?1,?2,?3,?4,?5,?6,'pending')",params![id,hit.title,url,hit.channel_name,category,date])?;
        id
    };
    let title: String = tx.query_row("SELECT title FROM media WHERE id=?1", [&id], |r| r.get(0))?;
    let added = queue::insert(&tx, &id, &title, "download", &cfg.device, true)?.is_some();
    // Respect the existing paused/running state. A manual search never starts the queue.
    tx.commit()?;
    Ok(json!({"id":id,"action":if added{"queued"}else{"alreadyQueued"}}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn manual_download_is_deduplicated_and_does_not_start_or_create_subscriptions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let control = Control::new(Arc::new(crate::speech::Control::default()));
        let hit = crate::tools::discover::Hit {
            video_id: "abc123_-XYZ".into(),
            title: "Discovered recording".into(),
            channel_name: "Public channel".into(),
            channel_id: "test".into(),
            description: String::new(),
            published_at: "2026-10-01T00:00:00Z".into(),
            live: false,
            media_id: None,
        };
        let a = enqueue(root, &control, &hit, "work").unwrap();
        assert_eq!(a["action"], "queued");
        assert_eq!(
            enqueue(root, &control, &hit, "personal").unwrap()["action"],
            "alreadyQueued"
        );
        let db = crate::db::open(root).unwrap();
        assert!(!super::super::running(&db).unwrap());
        assert_eq!(
            db.query_row("SELECT count(*) FROM channels", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM jobs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let m = crate::db::media(root, a["id"].as_str().unwrap()).unwrap();
        assert_eq!(m["category"], "work");
        db.execute("UPDATE media SET url='https://youtu.be/abc123_-XYZ'", [])
            .unwrap();
        assert_eq!(
            existing(&db, "abc123_-XYZ").unwrap().as_deref(),
            a["id"].as_str()
        );
        db.execute("UPDATE media SET status='archived'", [])
            .unwrap();
        assert_eq!(
            enqueue(root, &control, &hit, "work").unwrap()["action"],
            "existing"
        );
    }
}
