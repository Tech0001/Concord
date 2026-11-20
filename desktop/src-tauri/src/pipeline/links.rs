//! Links pasted into Add: tell a video from a channel or playlist, preview them, and add videos.
use super::Control;
use crate::db;
use anyhow::{Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    Video,
    Channel,
    Playlist,
    Unsupported,
}

/// A video ready to add, as previewed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub url: String,
    pub id: String,
    pub title: String,
    pub channel: String,
    pub channel_url: Option<String>,
    pub duration: f64,
    pub date: String,
}

pub fn classify(url: &str) -> Kind {
    let Ok(parsed) = super::download::youtube_url(url) else {
        return Kind::Unsupported;
    };
    let path = parsed.path().trim_end_matches('/');
    let query = |key: &str| parsed.query_pairs().any(|(k, v)| k == key && !v.is_empty());
    if parsed.host_str() == Some("youtu.be") {
        return if path.len() > 1 { Kind::Video } else { Kind::Unsupported };
    }
    if path == "/watch" && query("v") {
        return Kind::Video;
    }
    if ["/shorts/", "/live/"].iter().any(|p| path.starts_with(p) && path.len() > p.len()) {
        return Kind::Video;
    }
    if path == "/playlist" && query("list") {
        return Kind::Playlist;
    }
    let channel = ["/@", "/channel/", "/c/", "/user/"].iter().any(|p| path.starts_with(p) && path.len() > p.len());
    if channel {
        Kind::Channel
    } else {
        Kind::Unsupported
    }
}

/// The parts of a video's metadata the Add box shows and the library stores.
pub fn video_preview(data: &Value) -> Option<Video> {
    let id = super::download::video_id(data)?.to_owned();
    let text = |key: &str| data[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    Some(Video {
        url: format!("https://www.youtube.com/watch?v={id}"),
        title: text("title").unwrap_or_else(|| id.clone()),
        channel: text("channel").or_else(|| text("uploader")).unwrap_or_default(),
        // The handle form (@name) is what people recognise; fall back to the channel id form.
        channel_url: text("uploader_url").filter(|u| u.contains("/@")).or_else(|| text("channel_url")),
        duration: data["duration"].as_f64().unwrap_or(0.0),
        date: text("upload_date").unwrap_or_default(),
        id,
    })
}

/// A channel's name from a listing of one of its tabs ("Name - Videos").
pub fn channel_name(data: &Value) -> Option<String> {
    let text = |key: &str| data[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    text("channel").or_else(|| text("uploader")).or_else(|| {
        text("title").map(|t| {
            [" - Videos", " - Shorts", " - Live", " - Streams"]
                .iter()
                .find_map(|tab| t.strip_suffix(tab))
                .unwrap_or(&t)
                .to_owned()
        })
    })
}

/// Look up each link: a video's title and length, or a channel or playlist's name.
pub fn preview(root: &Path, urls: &[String]) -> Result<Vec<Value>> {
    let cfg = super::config(root)?;
    let mut out = vec![];
    for raw in urls.iter().map(|u| u.trim()).filter(|u| !u.is_empty()).take(50) {
        let kind = classify(raw);
        let item = match kind {
            Kind::Unsupported => json!({"input": raw, "kind": "unsupported", "error": "This isn't a video, channel or playlist link Concord can add."}),
            _ => match lookup(root, &cfg, raw, &kind) {
                Ok(item) => item,
                Err(e) => json!({"input": raw, "kind": "error", "error": format!("{e:#}")}),
            },
        };
        out.push(item);
    }
    Ok(out)
}
fn lookup(root: &Path, cfg: &super::Config, raw: &str, kind: &Kind) -> Result<Value> {
    let url = super::download::youtube_url(raw)?;
    let mut cmd = super::download::command(root, cfg)?;
    cmd.args(["--dump-single-json", "--skip-download"]);
    let target = match kind {
        Kind::Video => {
            cmd.arg("--no-playlist");
            url.to_string()
        }
        _ => {
            cmd.args(["--flat-playlist", "--playlist-end", "1"]);
            super::download::scan_urls(url.as_str(), false)?.into_iter().next().unwrap_or_else(|| url.to_string())
        }
    };
    cmd.arg("--").arg(&target);
    // Its own control: stopping a source check must not cancel a preview, or the reverse.
    let output = super::subprocess::capture(root, &crate::speech::Control::default(), cmd, None, Duration::from_secs(60))?;
    let data: Value = serde_json::from_str(output.text.trim()).with_context(|| {
        let reason = output.error.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_owned();
        if reason.is_empty() { "Couldn't read this link".to_owned() } else { reason }
    })?;
    let db = db::open(root)?;
    Ok(match kind {
        Kind::Video => {
            let video = video_preview(&data).context("Couldn't find a video at this link")?;
            let existing: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM media WHERE url=?1 AND (path IS NOT NULL OR transcript IS NOT NULL))",
                [&video.url],
                |r| r.get(0),
            )?;
            let following = video.channel_url.as_deref().map(|u| followed(&db, u)).transpose()?.unwrap_or(false);
            json!({"input": raw, "kind": "video", "video": video, "existing": existing, "followingChannel": following})
        }
        _ => {
            let name = channel_name(&data).unwrap_or_else(|| "YouTube channel".into());
            let latest = data["entries"][0]["upload_date"].as_str().unwrap_or("").to_owned();
            json!({"input": raw, "kind": if *kind == Kind::Playlist { "playlist" } else { "channel" },
                "url": url.as_str(), "name": name, "handle": data["uploader_id"].as_str().filter(|h| h.starts_with('@')),
                "latest": latest, "following": followed(&db, url.as_str())?})
        }
    })
}
/// Whether this channel or playlist is followed for new videos (older subscriptions aren't).
pub(super) fn followed(db: &rusqlite::Connection, url: &str) -> Result<bool> {
    let Some(wanted) = super::sources::source_key(url) else { return Ok(false) };
    Ok(db::rows(db, "SELECT url FROM channels WHERE kind='youtube' AND enabled=1 AND since>0", [])?
        .iter()
        .any(|r| r["url"].as_str().and_then(super::sources::source_key).as_ref() == Some(&wanted)))
}

/// Add previewed videos and queue each to download, then transcribe. Videos already in the
/// library, or removed from it, are skipped.
pub fn add_videos(root: &Path, control: &Control, videos: &[Video], category: &str, diarize: bool, device: &str) -> Result<Value> {
    anyhow::ensure!(["personal", "work"].contains(&category), "Choose Personal or Work");
    super::validate_device(device)?;
    let _gate = control.gate.lock().unwrap();
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (mut added, mut existing, mut ids) = (0, 0, vec![]);
    for video in videos {
        let remote = video.id.as_str();
        if super::download::video_id(&json!({"id": remote})).is_none() {
            continue;
        }
        let url = format!("https://www.youtube.com/watch?v={remote}");
        let id = serde_json::to_string(&("link", remote))?;
        let removed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM removed_recordings WHERE id=?1 OR url=?2)",
            params![id, url],
            |r| r.get(0),
        )?;
        let present = db::rows(&tx, "SELECT id,title,path IS NULL AND transcript IS NULL AS waiting FROM media WHERE id=?1 OR url=?2 LIMIT 1", params![id, url])?;
        if removed || present.first().is_some_and(|m| m["waiting"] != 1) {
            existing += 1;
            continue;
        }
        // Already in the library but never downloaded (an import, or a download that was stopped).
        if let Some(m) = present.first() {
            let media = m["id"].as_str().unwrap_or_default();
            match super::queue::insert(&tx, media, m["title"].as_str().unwrap_or(remote), "download", device, diarize)? {
                Some(_) => {
                    ids.push(media.to_owned());
                    added += 1;
                }
                None => existing += 1,
            }
            continue;
        }
        let title = if video.title.trim().is_empty() { remote } else { video.title.trim() };
        let channel = if video.channel.trim().is_empty() { "Links" } else { video.channel.trim() };
        tx.execute(
            "INSERT INTO media(id,title,url,channel,category,date,duration,status) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending')",
            params![id, title, url, channel, category, video.date, video.duration],
        )?;
        super::queue::insert(&tx, &id, title, "download", device, diarize)?;
        ids.push(id);
        added += 1;
    }
    tx.commit()?;
    Ok(json!({"added": added, "existing": existing, "ids": ids}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_told_apart() {
        for video in [
            "https://www.youtube.com/watch?v=ccccccccccc",
            "https://youtu.be/ccccccccccc",
            "https://www.youtube.com/shorts/ccccccccccc",
            "https://www.youtube.com/live/ccccccccccc",
            "https://m.youtube.com/watch?v=ccccccccccc&list=PLx",
        ] {
            assert_eq!(classify(video), Kind::Video, "{video}");
        }
        for channel in [
            "https://www.youtube.com/@TuesdayStudy",
            "https://www.youtube.com/@TuesdayStudy/videos",
            "https://www.youtube.com/channel/UC1234567890",
            "https://www.youtube.com/c/TuesdayStudy",
            "https://www.youtube.com/user/tuesdaystudy",
        ] {
            assert_eq!(classify(channel), Kind::Channel, "{channel}");
        }
        assert_eq!(classify("https://www.youtube.com/playlist?list=PL123"), Kind::Playlist);
        for other in ["https://example.com/notes", "https://www.youtube.com/", "https://www.youtube.com/feed/history", "not a link"] {
            assert_eq!(classify(other), Kind::Unsupported, "{other}");
        }
    }

    #[test]
    fn a_video_preview_keeps_what_the_add_box_shows() {
        let data = json!({"id": "ccccccccccc", "title": "Community garden interview", "channel": "Tuesday Study",
            "channel_url": "https://www.youtube.com/channel/UC1", "uploader_url": "https://www.youtube.com/@TuesdayStudy",
            "duration": 3151.0, "upload_date": "20260914", "webpage_url": "https://www.youtube.com/watch?v=ccccccccccc"});
        let video = video_preview(&data).unwrap();
        assert_eq!(video.title, "Community garden interview");
        assert_eq!(video.channel, "Tuesday Study");
        assert_eq!(video.channel_url.as_deref(), Some("https://www.youtube.com/@TuesdayStudy"));
        assert_eq!(video.url, "https://www.youtube.com/watch?v=ccccccccccc");
        assert!(video_preview(&json!({"title": "No id"})).is_none());
    }

    #[test]
    fn a_channel_is_named_without_its_tab() {
        assert_eq!(channel_name(&json!({"channel": "Tuesday Study", "title": "Tuesday Study - Videos"})).as_deref(), Some("Tuesday Study"));
        assert_eq!(channel_name(&json!({"title": "Tuesday Study - Videos"})).as_deref(), Some("Tuesday Study"));
        assert_eq!(channel_name(&json!({"uploader": "Tuesday Study"})).as_deref(), Some("Tuesday Study"));
        assert_eq!(channel_name(&json!({})), None);
    }
}
