//! Explicit, one-page YouTube Data API searches. No watcher or background polling.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path, time::Duration};

const CONFIG: &str = "youtube-api.json";
fn key(root: &Path) -> Result<String> {
    let path = root.join(CONFIG);
    if !path.exists() {
        return Ok(String::new());
    }
    let value: Value =
        serde_json::from_slice(&fs::read(path)?).context("Cannot read YouTube settings")?;
    Ok(value["apiKey"].as_str().unwrap_or_default().to_owned())
}
pub fn status(root: &Path) -> Result<Value> {
    Ok(json!({"hasKey":!key(root)?.is_empty()}))
}
pub fn save_key(root: &Path, value: &str) -> Result<Value> {
    let value = value.trim();
    ensure!(
        value.len() <= 512
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "Enter a valid YouTube Data API key"
    );
    crate::ai::config::private_write(root, CONFIG, &serde_json::to_vec(&json!({"apiKey":value}))?)?;
    status(root)
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub query: String,
    pub order: String,
    pub page_token: Option<String>,
}
impl Query {
    fn validate(&self) -> Result<()> {
        ensure!(
            !self.query.trim().is_empty() && self.query.len() <= 1000,
            "Enter a search phrase of at most 1,000 bytes"
        );
        ensure!(
            ["relevance", "date", "viewCount", "rating", "title"].contains(&self.order.as_str()),
            "Choose a supported YouTube search order"
        );
        ensure!(
            self.page_token.as_ref().is_none_or(|t| t.len() <= 4096),
            "Invalid search page"
        );
        Ok(())
    }
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub video_id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub title: String,
    pub description: String,
    pub published_at: String,
    pub live: bool,
    #[serde(default)]
    pub media_id: Option<String>,
}
pub fn valid_id(s: &str) -> bool {
    s.len() == 11
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn plain(s: &str) -> String {
    // Decode once, returning text. The frontend always renders it as React text, never HTML.
    let mut out = String::new();
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if let Some(end) = rest.find(';').filter(|end| *end <= 12) {
            let entity = &rest[1..end];
            let ch = match entity {
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "lt" => Some('<'),
                "gt" => Some('>'),
                _ => entity
                    .strip_prefix("#x")
                    .and_then(|n| u32::from_str_radix(n, 16).ok())
                    .or_else(|| entity.strip_prefix('#').and_then(|n| n.parse().ok()))
                    .and_then(char::from_u32),
            };
            if let Some(ch) = ch {
                out.push(ch);
                rest = &rest[end + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(5000)
        .collect()
}
pub fn search(root: &Path, q: &Query) -> Result<Value> {
    let endpoint = "https://www.googleapis.com/youtube/v3/search".to_owned();
    #[cfg(debug_assertions)]
    let endpoint = if std::env::var_os("CONCORD_NEXT_TEST_SCRIPT").is_some() {
        let test = std::env::var("CONCORD_NEXT_TEST_YOUTUBE_URL")
            .ok()
            .filter(|s| {
                url::Url::parse(s)
                    .ok()
                    .is_some_and(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1"))
            });
        test.unwrap_or(endpoint)
    } else {
        endpoint
    };
    search_using(root, q, &endpoint)
}
fn search_using(root: &Path, q: &Query, endpoint: &str) -> Result<Value> {
    q.validate()?;
    let key = key(root)?;
    ensure!(
        !key.is_empty(),
        "Add a YouTube Data API key in Settings to use Discover"
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut url = url::Url::parse(endpoint)?;
    url.query_pairs_mut().extend_pairs([
        ("part", "snippet"),
        ("type", "video"),
        ("maxResults", "50"),
        ("q", q.query.trim()),
        ("order", q.order.as_str()),
        ("key", key.as_str()),
    ]);
    if let Some(token) = q.page_token.as_deref().filter(|s| !s.is_empty()) {
        url.query_pairs_mut().append_pair("pageToken", token);
    }
    let response = client
        .get(url)
        .send()
        .map_err(|e| anyhow::anyhow!("YouTube search could not connect: {}", e.without_url()))?;
    let status = response.status();
    let mut bytes = Vec::new();
    response
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Could not read the YouTube search response"))?;
    ensure!(
        bytes.len() <= 2 * 1024 * 1024,
        "YouTube returned an oversized response"
    );
    let value: Value =
        serde_json::from_slice(&bytes).context("YouTube returned an unreadable search response")?;
    if !status.is_success() {
        let reason = value["error"]["errors"][0]["reason"]
            .as_str()
            .unwrap_or_default();
        let message=match reason {"quotaExceeded"|"dailyLimitExceeded"=>"The YouTube search quota has been reached. Try again after it resets.","keyInvalid"=>"The YouTube API key was rejected. Check it in Settings.","accessNotConfigured"|"ipRefererBlocked"|"forbidden"=>"Enable YouTube Data API v3 and check this key's restrictions in Google Cloud.",_=>"YouTube could not complete this search. Check the key, API access and quota in Google Cloud."};
        anyhow::bail!("{message} (HTTP {})", status.as_u16());
    }
    let db = crate::db::open(root)?;
    let mut items = Vec::new();
    for item in value["items"].as_array().into_iter().flatten().take(50) {
        let Some(id) = item["id"]["videoId"].as_str().filter(|s| valid_id(s)) else {
            continue;
        };
        let s = &item["snippet"];
        items.push(Hit {
            video_id: id.into(),
            channel_id: s["channelId"].as_str().unwrap_or_default().into(),
            channel_name: plain(s["channelTitle"].as_str().unwrap_or("YouTube")),
            title: plain(s["title"].as_str().unwrap_or(id)),
            description: plain(s["description"].as_str().unwrap_or_default()),
            published_at: s["publishedAt"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(32)
                .collect(),
            live: matches!(
                s["liveBroadcastContent"].as_str(),
                Some("live" | "upcoming")
            ),
            media_id: crate::pipeline::links::existing(&db, id)?,
        });
    }
    Ok(
        json!({"hits":items,"nextPageToken":value["nextPageToken"].as_str().filter(|s|s.len()<=4096)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_http_body_does_not_expose_the_key_in_the_request_url() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        save_key(temp.path(), "private-body-key").unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/search", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 1024];
            while !request.ends_with(b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{")
                .unwrap();
        });
        let q = Query {
            query: "test".into(),
            order: "relevance".into(),
            page_token: None,
        };
        let error = format!("{:#}", search_using(temp.path(), &q, &url).unwrap_err());
        assert!(error.contains("Could not read"));
        assert!(!error.contains("private-body-key"));
        assert!(!error.contains("key="));
        worker.join().unwrap();
    }
    #[test]
    fn key_is_private_and_status_never_exposes_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert_eq!(status(root).unwrap()["hasKey"], false);
        assert_eq!(
            save_key(root, "synthetic-test-key").unwrap(),
            json!({"hasKey":true})
        );
        assert!(!status(root).unwrap().to_string().contains("synthetic"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join(CONFIG))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert!(save_key(root, "invalid\nkey").is_err());
        save_key(root, "").unwrap();
        assert_eq!(status(root).unwrap()["hasKey"], false);
    }
    #[test]
    fn real_http_search_uses_cursor_and_decodes_text_without_echoing_credentials() {
        let temp = tempfile::tempdir().unwrap();
        save_key(temp.path(), "test-private-key").unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/search", server.server_addr());
        let worker = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            let params: url::Url = format!("http://localhost{}", req.url()).parse().unwrap();
            let p: std::collections::HashMap<_, _> = params.query_pairs().collect();
            assert_eq!(p["pageToken"], "next+page");
            assert_eq!(p["q"], "music & words");
            assert_eq!(p["order"], "date");
            assert_eq!(p["key"], "test-private-key");
            req.respond(tiny_http::Response::from_string(json!({"nextPageToken":"more","items":[{"id":{"videoId":"abc123_-XYZ"},"snippet":{"title":"A &amp; B &#39;quoted&#39;","channelTitle":"Music","description":"&lt;script&gt;plain&lt;/script&gt;"}},{"id":{"videoId":"invalid"}}]}).to_string())).unwrap();
            let req = server.recv().unwrap();
            req.respond(tiny_http::Response::from_string(json!({"error":{"message":"test-private-key","errors":[{"reason":"quotaExceeded"}]}}).to_string()).with_status_code(403)).unwrap();
        });
        let q = Query {
            query: " music & words ".into(),
            order: "date".into(),
            page_token: Some("next+page".into()),
        };
        let result = search_using(temp.path(), &q, &url).unwrap();
        assert_eq!(result["hits"].as_array().unwrap().len(), 1);
        assert_eq!(result["hits"][0]["title"], "A & B 'quoted'");
        assert_eq!(result["hits"][0]["description"], "<script>plain</script>");
        assert_eq!(result["nextPageToken"], "more");
        let error = search_using(temp.path(), &q, &url).unwrap_err().to_string();
        assert!(error.contains("quota"));
        assert!(!error.contains("test-private-key"));
        worker.join().unwrap();
    }
}
