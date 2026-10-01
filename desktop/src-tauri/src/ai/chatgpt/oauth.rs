use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, time::Instant};
use tiny_http::{Header, Method, Response as Reply, Server};
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
struct Attempt {
    state: String,
    nonce: String,
    verifier: String,
    redirect: String,
    client_id: String,
    account: Option<Account>,
    host: String,
}
fn random() -> String {
    (0..3)
        .map(|_| uuid::Uuid::new_v4().simple().to_string())
        .collect()
}
fn url(e: &Endpoints, a: &Attempt, consent: bool) -> Result<String> {
    let mut u = url::Url::parse(&format!("{}/api/accounts/authorize", e.auth))?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(a.verifier.as_bytes()));
    {
        let mut q = u.query_pairs_mut();
        q.extend_pairs([
            ("client_id", a.client_id.as_str()),
            ("ext_agent_host_id", a.host.as_str()),
            ("response_type", "code"),
            ("redirect_uri", a.redirect.as_str()),
            ("scope", SCOPES),
            ("resource", RESOURCE),
            ("state", a.state.as_str()),
            ("nonce", a.nonce.as_str()),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
        ]);
        if a.client_id == "dynamic_agent_client" {
            q.append_pair("agent_name_hint", "Concord");
        }
        if let Some(old) = &a.account {
            if !old.id_token.is_empty() {
                q.append_pair("id_token_hint", &old.id_token);
            }
            if !old.email.is_empty() {
                q.append_pair("login_hint", &old.email);
            }
        }
        if consent {
            q.append_pair("prompt", "consent");
        }
    }
    Ok(u.into())
}
fn callback(path: &str, a: &Attempt) -> Result<Option<HashMap<String, String>>> {
    ensure!(
        path.len() <= 8192 && path.starts_with("/auth/callback?"),
        "Unexpected callback path"
    );
    let u = url::Url::parse(&format!("http://127.0.0.1{path}"))?;
    let mut values = HashMap::new();
    for (k, v) in u.query_pairs() {
        ensure!(
            values.insert(k.into_owned(), v.into_owned()).is_none(),
            "Duplicate callback parameter"
        );
    }
    if values.get("state") != Some(&a.state) {
        return Ok(None);
    }
    Ok(Some(values))
}
fn answer(request: tiny_http::Request, status: u16, message: &str) {
    let response=Reply::from_string(format!("<!doctype html><meta charset=utf-8><title>Concord · ChatGPT</title><h1>Concord</h1><p>{message}</p>"))
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type","text/html; charset=utf-8").unwrap())
        .with_header(Header::from_bytes("Cache-Control","no-store").unwrap())
        .with_header(Header::from_bytes("Referrer-Policy","no-referrer").unwrap())
        .with_header(Header::from_bytes("Content-Security-Policy","default-src 'none'; frame-ancestors 'none'").unwrap());
    let _ = request.respond(response);
}
pub fn start(
    root: PathBuf,
    c: Arc<Control>,
    account_id: Option<String>,
    consent: bool,
) -> Result<()> {
    start_with(
        root,
        c,
        account_id,
        consent,
        Endpoints::get()?,
        |root, url| {
            #[cfg(debug_assertions)]
            if std::env::var_os("CONCORD_NEXT_TEST_SCRIPT").is_some()
                && std::env::var_os("CONCORD_CHATGPT_TEST_ENDPOINT").is_some()
            {
                return private_write(
                    root,
                    "test-chatgpt-authorization.json",
                    &serde_json::to_vec(&json!({"url":url}))?,
                );
            }
            let _ = root;
            crate::system::open_external(url)
        },
    )
}
pub(super) fn start_with(
    root: PathBuf,
    c: Arc<Control>,
    account_id: Option<String>,
    consent: bool,
    e: Endpoints,
    open: impl FnOnce(&Path, &str) -> Result<()>,
) -> Result<()> {
    let mut pending = c.pending.lock().unwrap();
    ensure!(!pending.running, "A ChatGPT sign-in is already pending");
    let _lock = lock(&root)?;
    let mut store = read(&root)?;
    if store.host_id.is_empty() {
        store.host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        write(&root, &store)?;
    }
    let retry = pending
        .registration_retry
        .clone()
        .filter(|r| r.host == store.host_id);
    let old = account_id
        .map(|id| {
            store
                .accounts
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .context("Saved ChatGPT account not found")
        })
        .transpose()?;
    drop(_lock);
    // Bind first: the browser can return before its launch helper exits.
    let server = Server::http("127.0.0.1:0")
        .map_err(|_| anyhow::anyhow!("Cannot open the local ChatGPT sign-in callback"))?;
    let redirect = format!("http://{}/auth/callback", server.server_addr());
    let a = Attempt {
        state: random(),
        nonce: random(),
        verifier: random(),
        redirect,
        client_id: old
            .as_ref()
            .map(|a| a.client_id.clone())
            .or_else(|| retry.as_ref().map(|r| r.client_id.clone()))
            .unwrap_or_else(|| "dynamic_agent_client".into()),
        account: old,
        host: store.host_id,
    };
    let authorize = url(&e, &a, consent)?;
    c.cancelled.store(false, Ordering::SeqCst);
    *pending = Pending {
        registration_retry: retry,
        attempt_id: uuid::Uuid::new_v4().to_string(),
        running: true,
        message: "Complete sign-in in your browser".into(),
        ..Pending::default()
    };
    if let Err(error) = open(&root, &authorize) {
        pending.running = false;
        pending.error =
            "Cannot open the sign-in browser. Check your default browser and try again.".into();
        return Err(error);
    }
    drop(pending);
    std::thread::spawn(move || {
        let result = finish(&root, &c, &e, &a, &server);
        let mut p = c.pending.lock().unwrap();
        p.running = false;
        match result {
            Ok(id) => {
                p.registration_retry = None;
                p.account_id = id;
                p.message =
                    "ChatGPT account connected. Choose its model and save chat settings.".into();
            }
            Err(_) if c.cancelled.load(Ordering::SeqCst) => {
                p.message = "ChatGPT sign-in cancelled".into()
            }
            Err(error) => {
                p.error = format!("{error:#}");
                p.message =
                    "ChatGPT sign-in did not complete; existing accounts are unchanged".into();
            }
        }
    });
    Ok(())
}
fn finish(root: &Path, c: &Control, e: &Endpoints, a: &Attempt, server: &Server) -> Result<String> {
    let started = Instant::now();
    loop {
        ensure!(!c.cancelled.load(Ordering::SeqCst), "Sign-in cancelled");
        ensure!(
            started.elapsed() < Duration::from_secs(600),
            "ChatGPT sign-in timed out. Start again in Settings."
        );
        let Some(request) = server.recv_timeout(Duration::from_millis(100))? else {
            continue;
        };
        let expected_host = a
            .redirect
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap();
        let host = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Host"))
            .map(|h| h.value.as_str());
        if request.method() != &Method::Get || host != Some(expected_host) {
            answer(
                request,
                400,
                "Invalid callback. Return to Concord and try again.",
            );
            continue;
        }
        let values = match callback(request.url(), a) {
            Ok(Some(v)) => v,
            _ => {
                answer(
                    request,
                    400,
                    "This callback does not match the pending sign-in.",
                );
                continue;
            }
        };
        if values.contains_key("error") {
            answer(
                request,
                400,
                "Authorization was not completed. Return to Concord.",
            );
            anyhow::bail!("ChatGPT authorization was declined or could not be completed");
        }
        let exchange = (|| -> Result<Account> {
            let issued = values
                .get("client_id")
                .map(String::as_str)
                .unwrap_or(&a.client_id);
            ensure!(
                !issued.is_empty() && issued != "dynamic_agent_client" && issued.len() <= 200,
                "ChatGPT registration did not return an issued client ID"
            );
            ensure!(
                a.client_id == "dynamic_agent_client" || issued == a.client_id,
                "ChatGPT callback belongs to a different app registration"
            );
            let code = values
                .get("code")
                .filter(|s| !s.is_empty())
                .context("ChatGPT did not return an authorization code")?;
            let (status, v) = tokens(
                e,
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", issued),
                    ("code", code),
                    ("code_verifier", &a.verifier),
                    ("redirect_uri", &a.redirect),
                    ("resource", RESOURCE),
                ],
            )?;
            if status == 400 && super::code(&v) == "invalid_grant" && a.account.is_none() {
                c.pending.lock().unwrap().registration_retry = Some(RegistrationRetry {
                    client_id: issued.into(),
                    host: a.host.clone(),
                });
            }
            ensure!((200..300).contains(&status), "{}", error(status, &v));
            ensure!(!c.cancelled.load(Ordering::SeqCst), "Sign-in cancelled");
            let token = v["id_token"]
                .as_str()
                .context("ChatGPT did not return an identity token")?;
            let identity = identity::verify(e, token, issued, Some(&a.nonce))?;
            if let Some(old) = &a.account {
                ensure!(
                    old.subject == identity.subject,
                    "ChatGPT returned a different account. Add it as a separate account instead."
                );
            }
            let mut account = a.account.clone().unwrap_or_else(|| Account {
                id: uuid::Uuid::new_v4().to_string(),
                client_id: issued.into(),
                ..Account::default()
            });
            account.subject = identity.subject;
            account.email = identity.email;
            apply_tokens(&mut account, &v, false)?;
            Ok(account)
        })();
        let mut account = match exchange {
            Ok(a) => a,
            Err(err) => {
                answer(
                    request,
                    400,
                    "Concord could not verify this sign-in. Check Settings for details.",
                );
                return Err(err);
            }
        };
        let _guard = c.pending.lock().unwrap();
        ensure!(!c.cancelled.load(Ordering::SeqCst), "Sign-in cancelled");
        let _lock = lock(root)?;
        let mut store = read(root)?;
        ensure!(
            store.host_id == a.host,
            "Concord's ChatGPT registration changed during sign-in"
        );
        if let Some(old) = store.accounts.iter_mut().find(|s| s.id == account.id) {
            *old = account.clone();
        } else {
            let base = if account.email.is_empty() {
                "ChatGPT account"
            } else {
                &account.email
            };
            account.label = format!("{base} · {}", store.accounts.len() + 1);
            store.accounts.push(account.clone());
        }
        write(root, &store)?;
        answer(
            request,
            200,
            if account.permitted() {
                "Connected. Return to Concord to choose your model."
            } else {
                "Signed in. ChatGPT plan use was not enabled; you can enable it from Concord Settings."
            },
        );
        return Ok(account.id);
    }
}
