use super::*;
use std::{collections::HashMap, sync::atomic::AtomicUsize, time::Instant};
const PRIVATE: &[u8] = include_bytes!("../../../test-data/chatgpt/test-only-private.pem");
fn jwks() -> Value {
    serde_json::from_str(include_str!("../../../test-data/chatgpt/jwks.json")).unwrap()
}
fn identity_token(nonce: &str, subject: &str, client: &str, expires: u64) -> String {
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some("concord-test-only".into());
    jsonwebtoken::encode(&header,&json!({"iss":ISSUER,"aud":client,"sub":subject,"email":"fixture@example.invalid","iat":now(),"exp":expires,"nonce":nonce}),&jsonwebtoken::EncodingKey::from_rsa_pem(PRIVATE).unwrap()).unwrap()
}
struct Mock {
    endpoint: Endpoints,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    nonce: Arc<Mutex<String>>,
    subject: Arc<Mutex<String>>,
    granted: Arc<AtomicBool>,
    refresh_error: Arc<Mutex<String>>,
    refreshes: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stream: Arc<Mutex<String>>,
}
impl Mock {
    fn new() -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let stop = Arc::new(AtomicBool::new(false));
        let nonce = Arc::new(Mutex::new(String::new()));
        let subject = Arc::new(Mutex::new(String::from("user-fixture")));
        let granted = Arc::new(AtomicBool::new(true));
        let refresh_error = Arc::new(Mutex::new(String::new()));
        let refreshes = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream: Arc<Mutex<String>>=Arc::new(Mutex::new("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello fixture\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".into()));
        let (s, n, u, g, err, r, q, out) = (
            stop.clone(),
            nonce.clone(),
            subject.clone(),
            granted.clone(),
            refresh_error.clone(),
            refreshes.clone(),
            requests.clone(),
            stream.clone(),
        );
        let b = base.clone();
        let thread = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let Some(mut req) = server.recv_timeout(Duration::from_millis(40)).unwrap() else {
                    continue;
                };
                let path = req.url().to_owned();
                let mut body = String::new();
                req.as_reader().read_to_string(&mut body).unwrap();
                let form = url::form_urlencoded::parse(body.as_bytes())
                    .into_owned()
                    .collect::<HashMap<_, _>>();
                let parsed = serde_json::from_str(&body).unwrap_or_else(|_| json!(form));
                q.lock().unwrap().push((path.clone(), parsed));
                let (status, value) = match path.as_str() {
                    "/.well-known/jwks.json" => (200, jwks()),
                    "/.well-known/openid-configuration" => (
                        200,
                        json!({"issuer":ISSUER,"revocation_endpoint":format!("{b}/api/accounts/oauth/revoke")}),
                    ),
                    "/api/accounts/oauth/revoke" => (200, Value::Null),
                    "/api/accounts/oauth/token" => {
                        let refresh = form.get("grant_type").is_some_and(|g| g == "refresh_token");
                        if refresh {
                            r.fetch_add(1, Ordering::SeqCst);
                        }
                        let error = err.lock().unwrap().clone();
                        if !refresh && error.starts_with("code:") {
                            (400, json!({"error":error.trim_start_matches("code:")}))
                        } else if refresh && !error.is_empty() {
                            (
                                if error == "temporary" { 503 } else { 400 },
                                json!({"error":error}),
                            )
                        } else {
                            (
                                200,
                                json!({"token_type":"Bearer","access_token":"access-fixture-new","refresh_token":"refresh-fixture-new","id_token":identity_token(&n.lock().unwrap(),&u.lock().unwrap(),"oaiapp_fixture",now()+3600),"expires_in":3600,"scope":if g.load(Ordering::SeqCst){SCOPES_FOR_TEST}else{"openid profile email offline_access"}}),
                            )
                        }
                    }
                    "/v1/responses" => {
                        let response =
                            tiny_http::Response::from_string(out.lock().unwrap().clone());
                        let _ = req.respond(response);
                        continue;
                    }
                    _ => (404, json!({"error":"not_found"})),
                };
                let _ = req.respond(
                    tiny_http::Response::from_string(value.to_string()).with_status_code(status),
                );
            }
        });
        Self {
            endpoint: Endpoints {
                auth: base.clone(),
                api: format!("{base}/v1"),
            },
            stop,
            thread: Some(thread),
            nonce,
            subject,
            granted,
            refresh_error,
            refreshes,
            requests,
            stream,
        }
    }
    fn begin(&self, root: &Path, c: &Arc<Control>, id: Option<String>) -> url::Url {
        let mut captured = None;
        oauth::start_with(
            root.into(),
            c.clone(),
            id,
            false,
            self.endpoint.clone(),
            |_, u| {
                captured = Some(u.to_owned());
                Ok(())
            },
        )
        .unwrap();
        let u = url::Url::parse(&captured.unwrap()).unwrap();
        let q = u.query_pairs().into_owned().collect::<HashMap<_, _>>();
        *self.nonce.lock().unwrap() = q["nonce"].clone();
        u
    }
    fn callback(&self, u: &url::Url, valid: bool) -> u16 {
        let q = u.query_pairs().into_owned().collect::<HashMap<_, _>>();
        let mut callback = url::Url::parse(&q["redirect_uri"]).unwrap();
        callback.query_pairs_mut().extend_pairs([
            (
                "state",
                if valid {
                    q["state"].as_str()
                } else {
                    "wrong-state"
                },
            ),
            ("code", "synthetic-code"),
            ("client_id", "oaiapp_fixture"),
        ]);
        reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(callback)
            .send()
            .unwrap()
            .status()
            .as_u16()
    }
    fn connect(&self, root: &Path, c: &Arc<Control>) -> String {
        let u = self.begin(root, c, None);
        assert_eq!(self.callback(&u, true), 200);
        wait(c);
        read(root).unwrap().accounts[0].id.clone()
    }
}
const SCOPES_FOR_TEST: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn wait(c: &Control) {
    let at = Instant::now();
    while c.pending.lock().unwrap().running {
        assert!(at.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn verifies_signature_audience_expiry_and_nonce_before_identity_use() {
    let keys = serde_json::from_value(jwks()).unwrap();
    let good = identity_token("nonce", "user", "client", now() + 3600);
    assert_eq!(
        identity::verify_keys(&good, "client", Some("nonce"), &keys)
            .unwrap()
            .subject,
        "user"
    );
    assert!(identity::verify_keys(&good, "other-client", Some("nonce"), &keys).is_err());
    assert!(identity::verify_keys(&good, "client", Some("other-nonce"), &keys).is_err());
    assert!(identity::verify_keys(
        &identity_token("nonce", "user", "client", now() - 3600),
        "client",
        Some("nonce"),
        &keys
    )
    .is_err());
    let mut parts = good.split('.').map(str::to_owned).collect::<Vec<_>>();
    parts[1].replace_range(5..6, "X");
    assert!(identity::verify_keys(&parts.join("."), "client", Some("nonce"), &keys).is_err());
}
#[test]
fn registration_binds_callback_pkce_host_and_verified_account_without_exposing_tokens() {
    let root = tempfile::tempdir().unwrap();
    let c = Arc::new(Control::default());
    let mock = Mock::new();
    let u = mock.begin(root.path(), &c, None);
    let q = u.query_pairs().into_owned().collect::<HashMap<_, _>>();
    assert_eq!(q["client_id"], "dynamic_agent_client");
    assert_eq!(q["agent_name_hint"], "Concord");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["resource"], RESOURCE);
    assert_eq!(mock.callback(&u, false), 400);
    assert!(c.pending.lock().unwrap().running);
    assert!(mock.requests.lock().unwrap().is_empty());
    assert_eq!(mock.callback(&u, true), 200);
    wait(&c);
    let store = read(root.path()).unwrap();
    let a = &store.accounts[0];
    assert!(available(root.path(), &a.id));
    assert_eq!(a.client_id, "oaiapp_fixture");
    assert_eq!(store.host_id, q["ext_agent_host_id"]);
    let r = mock.requests.lock().unwrap();
    let exchange = &r.iter().find(|r| r.0.ends_with("/token")).unwrap().1;
    use base64::Engine;
    use sha2::Digest;
    assert_eq!(
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(
            exchange["code_verifier"].as_str().unwrap().as_bytes()
        )),
        q["code_challenge"]
    );
    assert_eq!(exchange["redirect_uri"], q["redirect_uri"]);
    assert_eq!(exchange["client_id"], "oaiapp_fixture");
    drop(r);
    let exposed = status(root.path(), &c).unwrap().to_string();
    assert!(!exposed.contains("access-fixture"));
    assert!(!exposed.contains("refresh-fixture"));
    assert!(!exposed.contains(&a.id_token));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            root.path()
                .join(FILE)
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    *mock.subject.lock().unwrap() = "different-user".into();
    let u = mock.begin(root.path(), &c, Some(a.id.clone()));
    assert_eq!(
        u.query_pairs().find(|(k, _)| k == "client_id").unwrap().1,
        "oaiapp_fixture"
    );
    assert!(!u.query_pairs().any(|(k, _)| k == "agent_name_hint"));
    assert_eq!(mock.callback(&u, true), 400);
    wait(&c);
    assert_eq!(
        read(root.path()).unwrap().accounts[0].subject,
        "user-fixture"
    );
}
#[test]
fn missing_plan_permission_retains_identity_but_blocks_inference_and_cancel_keeps_accounts() {
    let root = tempfile::tempdir().unwrap();
    let c = Arc::new(Control::default());
    let mock = Mock::new();
    mock.granted.store(false, Ordering::SeqCst);
    let id = mock.connect(root.path(), &c);
    assert!(!available(root.path(), &id));
    assert!(read(root.path()).unwrap().accounts[0].connected());
    assert!(access_at(root.path(), &id, &mock.endpoint)
        .unwrap_err()
        .to_string()
        .contains("Enable ChatGPT plan"));
    mock.begin(root.path(), &c, Some(id));
    cancel(&c);
    wait(&c);
    assert_eq!(read(root.path()).unwrap().accounts.len(), 1);
}
#[test]
fn refresh_is_serialized_rotated_and_cleared_only_for_terminal_failures() {
    let root = tempfile::tempdir().unwrap();
    let c = Arc::new(Control::default());
    let mock = Mock::new();
    let id = mock.connect(root.path(), &c);
    let expire = || {
        let mut store = read(root.path()).unwrap();
        store.accounts[0].expires_at = now() - 1;
        write(root.path(), &store).unwrap();
    };
    expire();
    std::thread::scope(|s| {
        let one = s.spawn(|| access_at(root.path(), &id, &mock.endpoint).unwrap());
        let two = s.spawn(|| access_at(root.path(), &id, &mock.endpoint).unwrap());
        assert_eq!(one.join().unwrap(), two.join().unwrap());
    });
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(
        read(root.path()).unwrap().accounts[0].refresh_token,
        "refresh-fixture-new"
    );
    expire();
    *mock.refresh_error.lock().unwrap() = "temporary".into();
    assert!(access_at(root.path(), &id, &mock.endpoint).is_err());
    assert!(!read(root.path()).unwrap().accounts[0]
        .refresh_token
        .is_empty());
    *mock.refresh_error.lock().unwrap() = "invalid_grant".into();
    assert!(access_at(root.path(), &id, &mock.endpoint).is_err());
    let a = &read(root.path()).unwrap().accounts[0];
    assert!(a.refresh_token.is_empty() && a.id_token.is_empty() && a.access_token.is_empty());
    assert_eq!(a.client_id, "oaiapp_fixture");
}
#[test]
fn responses_uses_plan_route_supported_fields_and_requires_terminal_completion() {
    let root = tempfile::tempdir().unwrap();
    let c = Arc::new(Control::default());
    let mock = Mock::new();
    let id = mock.connect(root.path(), &c);
    let p = super::super::config::Provider {
        enabled: true,
        kind: "chatgpt".into(),
        base_url: RESOURCE.into(),
        model: "fixture-model".into(),
        account_id: id,
        ..Default::default()
    };
    let messages = [
        json!({"role":"system","content":"Developer instruction"}),
        json!({"role":"user","content":"Synthetic question"}),
    ];
    let cancel = AtomicBool::new(false);
    assert_eq!(
        responses::complete_at(root.path(), &p, &messages, &cancel, &mock.endpoint, |_| {})
            .unwrap(),
        "Hello fixture"
    );
    let requests = mock.requests.lock().unwrap();
    let payload = &requests
        .iter()
        .find(|(path, _)| path == "/v1/responses")
        .unwrap()
        .1;
    assert_eq!(payload["input"][0]["role"], "developer");
    assert_eq!(payload["store"], false);
    assert_eq!(payload["stream"], true);
    assert_eq!(payload.as_object().unwrap().len(), 4);
    drop(requests);
    *mock.stream.lock().unwrap() =
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Partial\"}\n\n".into();
    assert!(
        responses::complete_at(root.path(), &p, &messages, &cancel, &mock.endpoint, |_| {})
            .unwrap_err()
            .to_string()
            .contains("before completion")
    );
    *mock.stream.lock().unwrap()="data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\",\"message\":\"private text must not appear\"}}}\n\n".into();
    let error = responses::complete_at(root.path(), &p, &messages, &cancel, &mock.endpoint, |_| {})
        .unwrap_err()
        .to_string();
    assert!(error.contains("Manage usage"));
    assert!(!error.contains("private text"));
}

#[test]
fn consumed_code_retry_keeps_the_issued_registration_and_uses_fresh_pkce() {
    let root = tempfile::tempdir().unwrap();
    let c = Arc::new(Control::default());
    let mock = Mock::new();
    *mock.refresh_error.lock().unwrap() = "code:invalid_grant".into();
    let first = mock.begin(root.path(), &c, None);
    assert_eq!(mock.callback(&first, true), 400);
    wait(&c);
    assert!(read(root.path()).unwrap().accounts.is_empty());
    mock.refresh_error.lock().unwrap().clear();
    let next = mock.begin(root.path(), &c, None);
    let query = |u: &url::Url| u.query_pairs().into_owned().collect::<HashMap<_, _>>();
    let a = query(&first);
    let b = query(&next);
    assert_eq!(b["client_id"], "oaiapp_fixture");
    assert!(!b.contains_key("agent_name_hint"));
    assert_ne!(a["state"], b["state"]);
    assert_ne!(a["code_challenge"], b["code_challenge"]);
    assert_eq!(mock.callback(&next, true), 200);
    wait(&c);
    assert_eq!(read(root.path()).unwrap().accounts.len(), 1);
    assert!(!status(root.path(), &c)
        .unwrap()
        .to_string()
        .contains("oaiapp_fixture"));
}
