//! Concord's own public OAuth client. Tokens never cross Tauri IPC or use Codex's credentials.
mod identity;
mod oauth;
pub mod responses;
#[cfg(test)]
mod tests;

use super::config::private_write;
use anyhow::{ensure, Context, Result};
pub use oauth::start;
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
pub const RESOURCE: &str = "https://api.openai.com/v1";
const ISSUER: &str = "https://auth.openai.com";
const DIRECT: &str = "chatgpt.tokens.use.direct";
const FILE: &str = "chatgpt-auth.json";

#[derive(Default)]
pub struct Control {
    pub cancelled: AtomicBool,
    pending: Mutex<Pending>,
}
#[derive(Clone)]
struct RegistrationRetry {
    client_id: String,
    host: String,
}
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    #[serde(skip)]
    registration_retry: Option<RegistrationRetry>,
    attempt_id: String,
    running: bool,
    message: String,
    error: String,
    account_id: String,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Account {
    id: String,
    label: String,
    client_id: String,
    subject: String,
    email: String,
    access_token: String,
    refresh_token: String,
    id_token: String,
    scopes: Vec<String>,
    expires_at: u64,
    earliest_refresh_at: u64,
    welcome_seen: bool,
}
impl Account {
    fn connected(&self) -> bool {
        !self.access_token.is_empty() && (self.expires_at > now() || !self.refresh_token.is_empty())
    }
    fn permitted(&self) -> bool {
        self.scopes.iter().any(|s| s == DIRECT)
    }
    fn clear(&mut self) {
        self.access_token.clear();
        self.refresh_token.clear();
        self.id_token.clear();
        self.scopes.clear();
        self.expires_at = 0;
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Store {
    host_id: String,
    accounts: Vec<Account>,
}
fn now() -> u64 {
    jsonwebtoken::get_current_timestamp()
}
fn read(root: &Path) -> Result<Store> {
    let path = root.join(FILE);
    if !path.exists() {
        return Ok(Store::default());
    }
    ensure!(
        path.metadata()?.len() <= 1_000_000,
        "ChatGPT credential file is too large"
    );
    serde_json::from_slice(&fs::read(path)?).context("Cannot read Concord's ChatGPT connection")
}
fn write(root: &Path, s: &Store) -> Result<()> {
    private_write(root, FILE, &serde_json::to_vec(s)?)
}
// File locks serialize rotating refresh tokens across processes, including separate app instances.
fn lock(root: &Path) -> Result<File> {
    fs::create_dir_all(root)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(root.join(".chatgpt-auth.lock"))?;
    file.lock()?;
    Ok(file)
}
pub fn available(root: &Path, id: &str) -> bool {
    read(root).ok().is_some_and(|s| {
        s.accounts
            .iter()
            .any(|a| a.id == id && a.connected() && a.permitted())
    })
}
pub fn status(root: &Path, c: &Control) -> Result<Value> {
    let s = read(root)?;
    Ok(
        json!({"accounts":s.accounts.iter().map(|a|json!({"id":a.id,"label":a.label,"email":a.email,"connected":a.connected(),"planEnabled":a.permitted(),"welcomeSeen":a.welcome_seen})).collect::<Vec<_>>(),"pending":c.pending.lock().unwrap().clone()}),
    )
}
pub fn cancel(c: &Control) {
    let _guard = c.pending.lock().unwrap();
    c.cancelled.store(true, Ordering::SeqCst);
}
pub fn acknowledge(root: &Path, id: &str) -> Result<()> {
    let _lock = lock(root)?;
    let mut s = read(root)?;
    let a = s
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
        .context("ChatGPT account not found")?;
    a.welcome_seen = true;
    write(root, &s)
}
#[derive(Clone)]
struct Endpoints {
    auth: String,
    api: String,
}
impl Endpoints {
    fn get() -> Result<Self> {
        #[cfg(debug_assertions)]
        if std::env::var_os("CONCORD_NEXT_TEST_SCRIPT").is_some() {
            if let Ok(base) = std::env::var("CONCORD_CHATGPT_TEST_ENDPOINT") {
                let u = url::Url::parse(&base)?;
                ensure!(
                    u.scheme() == "http"
                        && u.host_str() == Some("127.0.0.1")
                        && u.path() == "/"
                        && u.query().is_none()
                        && u.fragment().is_none()
                        && u.username().is_empty()
                        && u.password().is_none(),
                    "Invalid synthetic ChatGPT endpoint"
                );
                return Ok(Self {
                    auth: base.trim_end_matches('/').into(),
                    api: format!("{}/v1", base.trim_end_matches('/')),
                });
            }
        }
        Ok(Self {
            auth: ISSUER.into(),
            api: RESOURCE.into(),
        })
    }
    fn client(&self) -> Result<Client> {
        let b = Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none());
        Ok(if self.auth.starts_with("http://127.0.0.1:") {
            b.no_proxy()
        } else {
            b
        }
        .build()?)
    }
}
fn body(response: Response) -> Result<(u16, Value)> {
    let status = response.status().as_u16();
    let mut data = Vec::new();
    response
        .take(2_000_001)
        .read_to_end(&mut data)
        .map_err(|_| anyhow::anyhow!("ChatGPT response was interrupted"))?;
    ensure!(data.len() <= 2_000_000, "ChatGPT response is too large");
    let value = if data.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&data).context("ChatGPT returned an invalid response")?
    };
    Ok((status, value))
}
fn code(v: &Value) -> &str {
    v["error"]
        .as_str()
        .or_else(|| v["error"]["code"].as_str())
        .unwrap_or("")
}
pub(super) fn error(status: u16, v: &Value) -> String {
    let hint=match code(v) {
        "subscription_sharing_usage_limit_exceeded" => "ChatGPT usage limit reached. Open Manage usage to review your plan or Concord's limit.",
        "subscription_sharing_user_not_eligible" => "ChatGPT plan usage is unavailable for this account or workspace.",
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => "ChatGPT usage is temporarily unavailable. Try again later; your connection is retained.",
        "subscription_sharing_unsupported_capability" => "ChatGPT rejected an unsupported request option. Select a supported model.",
        "subscription_sharing_route_not_supported" => "This account cannot use the requested ChatGPT route.",
        "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => "This ChatGPT connection does not authorize plan usage. Check its permissions.",
        "invalid_client" => "ChatGPT did not accept this app registration. Sign in again or report the connection issue.",
        _=>match status {401=>"ChatGPT did not accept this connection. Sign in again.",403=>"ChatGPT denied this request. Check account, workspace and region permissions.",429=>"ChatGPT usage limit reached. Open Manage usage.",503=>"ChatGPT is temporarily unavailable. Try again later.",_=>"ChatGPT could not complete the request. Try again or check your connection."}
    };
    let c = code(v);
    let safe = if !c.is_empty()
        && c.len() <= 100
        && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        c
    } else {
        "unknown"
    };
    format!("{hint} (HTTP {status}, {safe})")
}
fn json_get(e: &Endpoints, path: &str) -> Result<Value> {
    let response = e
        .client()?
        .get(format!("{}{path}", e.auth))
        .send()
        .map_err(|_| anyhow::anyhow!("Cannot reach ChatGPT sign-in services"))?;
    let (status, v) = body(response)?;
    ensure!((200..300).contains(&status), "{}", error(status, &v));
    Ok(v)
}
fn tokens(e: &Endpoints, form: &[(&str, &str)]) -> Result<(u16, Value)> {
    let r = e
        .client()?
        .post(format!("{}/api/accounts/oauth/token", e.auth))
        .form(form)
        .send()
        .map_err(|_| anyhow::anyhow!("Cannot reach ChatGPT token service; try again"))?;
    body(r)
}
fn apply_tokens(a: &mut Account, v: &Value, refresh: bool) -> Result<()> {
    let token = |name: &str| -> Result<String> {
        let s = v[name]
            .as_str()
            .context("ChatGPT returned incomplete credentials")?;
        ensure!(
            !s.is_empty() && s.len() < 40000 && !s.contains(['\r', '\n']),
            "ChatGPT returned an invalid credential"
        );
        Ok(s.into())
    };
    ensure!(
        v["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("Bearer")),
        "ChatGPT returned an unsupported token type"
    );
    let expires = v["expires_in"]
        .as_u64()
        .context("ChatGPT did not return token expiry")?;
    ensure!(
        expires > 0 && expires <= 86400,
        "Invalid ChatGPT token expiry"
    );
    a.access_token = token("access_token")?;
    a.refresh_token = token("refresh_token")?;
    if !refresh || v["id_token"].is_string() {
        a.id_token = token("id_token")?;
    }
    if let Some(scope) = v["scope"].as_str() {
        a.scopes = scope.split_whitespace().map(str::to_owned).collect();
    } else {
        ensure!(refresh, "ChatGPT did not confirm granted permissions");
    }
    a.expires_at = now() + expires;
    a.earliest_refresh_at = v["earliest_refresh_at"].as_u64().unwrap_or(0);
    Ok(())
}
pub fn access(root: &Path, id: &str) -> Result<String> {
    access_at(root, id, &Endpoints::get()?)
}
fn access_at(root: &Path, id: &str, e: &Endpoints) -> Result<String> {
    let _lock = lock(root)?;
    let mut store = read(root)?;
    let a = store
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
        .context("Choose a connected ChatGPT account in Settings")?;
    ensure!(
        a.connected(),
        "Sign in to your selected ChatGPT account again"
    );
    ensure!(
        a.permitted(),
        "Enable ChatGPT plan usage in Settings before using chat"
    );
    if a.expires_at > now() + 60 || (a.expires_at > now() && a.earliest_refresh_at > now()) {
        return Ok(a.access_token.clone());
    }
    ensure!(
        a.earliest_refresh_at <= now(),
        "ChatGPT token renewal is not available yet. Try again shortly."
    );
    let (status, v) = tokens(
        e,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &a.client_id),
            ("refresh_token", &a.refresh_token),
            ("resource", RESOURCE),
        ],
    )?;
    if !(200..300).contains(&status) {
        if [
            "invalid_grant",
            "invalid_refresh_token",
            "token_expired",
            "refresh_token_expired",
            "refresh_token_invalidated",
            "refresh_token_reused",
        ]
        .contains(&code(&v))
        {
            a.clear();
            write(root, &store)?;
            anyhow::bail!(
                "ChatGPT connection expired or was disconnected. Sign in again in Settings."
            );
        }
        anyhow::bail!("{}", error(status, &v));
    }
    let mut next = a.clone();
    apply_tokens(&mut next, &v, true)?;
    if let Some(token) = v["id_token"].as_str() {
        let identity = identity::verify(e, token, &a.client_id, None)?;
        ensure!(
            identity.subject == a.subject,
            "ChatGPT renewal returned a different account"
        );
    }
    let result = next.access_token.clone();
    let permitted = next.permitted();
    *a = next;
    write(root, &store)?;
    ensure!(
        permitted,
        "ChatGPT plan permission was removed. Enable plan usage in Settings."
    );
    Ok(result)
}
pub fn models(root: &Path, id: &str) -> Result<Vec<Value>> {
    let e = Endpoints::get()?;
    let token = access(root, id)?;
    let response = e
        .client()?
        .get(format!("{}/models", e.api))
        .bearer_auth(token)
        .send()
        .map_err(|_| anyhow::anyhow!("Cannot load ChatGPT models"))?;
    let (status, v) = body(response)?;
    ensure!((200..300).contains(&status), "{}", error(status, &v));
    Ok(v["models"]
        .as_array()
        .context("ChatGPT did not return a model catalog")?
        .iter()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| Some(json!({"id":m["slug"].as_str()?,"name":m["display_name"].as_str()?})))
        .collect())
}
pub fn sign_out(root: &Path, id: &str, c: &Control, ai: &super::Control) -> Result<String> {
    cancel(c);
    let _lock = lock(root)?;
    let mut s = read(root)?;
    let a = s
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
        .context("ChatGPT account not found")?;
    let token = a.refresh_token.clone();
    let client_id = a.client_id.clone();
    a.clear();
    write(root, &s)?;
    responses::disconnect(root, id);
    for stop in ai.chats.lock().unwrap().values() {
        stop.store(true, Ordering::SeqCst);
    }
    for task in ai.summaries.lock().unwrap().values() {
        task.cancel.store(true, Ordering::SeqCst);
    }
    drop(_lock);
    if token.is_empty() {
        return Ok("Signed out".into());
    }
    let revoke = || -> Result<()> {
        let e = Endpoints::get()?;
        let discovery = json_get(&e, "/.well-known/openid-configuration")?;
        let endpoint = discovery["revocation_endpoint"]
            .as_str()
            .context("ChatGPT did not publish a sign-out endpoint")?;
        ensure!(
            endpoint == format!("{}/api/accounts/oauth/revoke", e.auth),
            "Unexpected ChatGPT revocation endpoint"
        );
        for attempt in 0..2 {
            let result = e
                .client()?
                .post(endpoint)
                .form(&[
                    ("token", token.as_str()),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id.as_str()),
                ])
                .send();
            if result.as_ref().is_ok_and(|r| r.status().as_u16() == 200) {
                return Ok(());
            }
            if attempt == 0 {
                std::thread::sleep(Duration::from_millis(300));
            }
        }
        anyhow::bail!("Revocation unconfirmed")
    };
    Ok(if revoke().is_ok(){"Signed out of ChatGPT"}else{"Signed out locally. Remote revocation could not be confirmed; disconnect Concord in ChatGPT Settings to finish."}.into())
}
