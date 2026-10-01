use super::{
    chat,
    config::{self, Provider},
    index::{self, Filter},
    Control,
};
use crate::db;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
struct Fake {
    url: String,
    requests: Arc<Mutex<Vec<(String, String, Value)>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Fake {
    fn new() -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", server.server_addr());
        let requests = Arc::new(Mutex::new(vec![]));
        let seen = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let thread = std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let Ok(Some(mut request)) = server.recv_timeout(Duration::from_millis(30)) else {
                    continue;
                };
                let path = request.url().to_owned();
                let auth = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .map(|h| h.value.to_string())
                    .unwrap_or_default();
                let mut text = String::new();
                request.as_reader().read_to_string(&mut text).unwrap();
                let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                seen.lock()
                    .unwrap()
                    .push((path.clone(), auth, body.clone()));
                let result = if path.ends_with("/embeddings") {
                    let data = body["input"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .enumerate()
                        .rev()
                        .map(|(i, t)| {
                            let text = t.as_str().unwrap().to_lowercase();
                            let vector = if body["model"] == "wrong-dim" {
                                vec![1., 0., 0.]
                            } else if text.contains("prayer") || text.contains("faith") {
                                vec![1., 0.]
                            } else {
                                vec![0., 1.]
                            };
                            json!({"index":i,"embedding":vector})
                        })
                        .collect::<Vec<_>>();
                    json!({"data":data}).to_string()
                } else if path.ends_with("/chat/completions") {
                    let mut s = format!(
                        "data: {}\n\ndata: {}\n\n",
                        json!({"choices":[{"delta":{"content":"Prayer supports the community [1]."}}]}),
                        json!({"choices":[{"delta":{},"finish_reason":"stop"}]})
                    );
                    if body["model"] != "broken-stream" {
                        s.push_str("data: [DONE]\n\n");
                    }
                    s
                } else {
                    json!({"data":[{"id":"tiny-embedding"},{"id":"tiny-chat"}]}).to_string()
                };
                request
                    .respond(tiny_http::Response::from_string(result))
                    .unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn config(&self, root: &Path, task: &str, model: &str, key: &str) {
        config::save(
            root,
            task,
            Provider {
                account_id: String::new(),
                enabled: true,
                kind: "local".into(),
                base_url: self.url.clone(),
                model: model.into(),
                api_key: String::new(),
            },
            Some(key.into()),
        )
        .unwrap();
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn fixture(root: &Path) {
    let db = db::open(root).unwrap();
    db.execute_batch("INSERT INTO media(id,title,channel,date,duration) VALUES('prayer','Prayer meeting','Meetings','2025-10-07',30),('car','Car repairs','Personal','2025-10-22',30);
 INSERT INTO segments(media_id,start,end,speaker,text) VALUES('prayer',0,10,'S0','Faith and prayer support our community.'),('car',0,10,'S1','The car needs tires and oil.');
 INSERT INTO speakers(id,name) VALUES('sarah','Sarah');INSERT INTO assignments(media_id,local_id,speaker_id) VALUES('prayer','S0','sarah');
 INSERT INTO docs(id,title,body) VALUES('doc','Prayer document','Prayer and encouragement.');
 INSERT INTO notes(id,title,body) VALUES('note','A prayer note','Faith helps people.');INSERT INTO note_tags VALUES('note','faith');
 INSERT INTO note_anchors(id,note_id,position,media_id,start,end,quote) VALUES('anchor','note',0,'prayer',0,10,'Faith and prayer.');").unwrap();
}
fn build(root: &Path, control: Arc<Control>) {
    index::start(root.to_owned(), control.clone()).unwrap();
    let start = Instant::now();
    while control.indexing.load(Ordering::SeqCst) {
        assert!(start.elapsed() < Duration::from_secs(15));
        std::thread::sleep(Duration::from_millis(20));
    }
    let state = index::status(root).unwrap();
    assert_eq!(state["job"]["status"], "complete", "{state}");
}
#[test]
fn providers_are_independent_and_secrets_stay_out_of_database_and_ipc() {
    let root = tempfile::tempdir().unwrap();
    let server = Fake::new();
    fixture(root.path());
    server.config(root.path(), "embedding", "tiny-embedding", "embed-secret");
    server.config(root.path(), "chat", "tiny-chat", "chat-secret");
    let c = config::read(root.path()).unwrap();
    assert_eq!(c.embedding.api_key, "embed-secret");
    assert_eq!(c.chat.api_key, "chat-secret");
    let view = config::view(root.path()).unwrap().to_string();
    assert!(!view.contains("secret"));
    let db = db::open(root.path()).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM settings", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let mut changed = c.embedding;
    changed.base_url = "http://127.0.0.1:1/v1".into();
    config::save(root.path(), "embedding", changed, None).unwrap();
    let c = config::read(root.path()).unwrap();
    assert!(c.embedding.api_key.is_empty());
    assert_eq!(c.chat.api_key, "chat-secret");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.path().join("ai-providers.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[test]
fn indexing_resumes_separates_models_and_invalidates_changed_sources() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let fake = Fake::new();
    fake.config(root.path(), "embedding", "tiny-embedding", "embedding-key");
    let control = Arc::new(Control::default());
    build(root.path(), control.clone());
    let count = fake.requests.lock().unwrap().len();
    build(root.path(), control.clone());
    assert_eq!(
        fake.requests.lock().unwrap().len(),
        count,
        "Unchanged sources must not be billed again"
    );
    assert_eq!(index::status(root.path()).unwrap()["indexed"], 4);
    let hits = index::search(
        root.path(),
        "prayer",
        true,
        &Filter {
            kind: "recording".into(),
            ..Default::default()
        },
        10,
    )
    .unwrap();
    assert_eq!(hits[0].id, "prayer");
    db::open(root.path())
        .unwrap()
        .execute("UPDATE docs SET body='Changed document' WHERE id='doc'", [])
        .unwrap();
    assert_eq!(index::status(root.path()).unwrap()["indexed"], 3);
    build(root.path(), control.clone());
    fake.config(root.path(), "embedding", "other-model", "embedding-key");
    assert_eq!(index::status(root.path()).unwrap()["indexed"], 0);
    assert!(index::search(root.path(), "prayer", true, &Filter::default(), 10).is_err());
    build(root.path(), control.clone());
    index::clear(root.path(), &control).unwrap();
    fake.config(root.path(), "embedding", "tiny-embedding", "embedding-key");
    assert_eq!(index::status(root.path()).unwrap()["indexed"], 4);
}
#[test]
fn search_filters_apply_before_limit_and_support_note_evidence() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    db::open(root.path()).unwrap().execute("UPDATE media SET date='20251007' WHERE id='prayer'",[]).unwrap();
    let fake = Fake::new();
    fake.config(root.path(), "embedding", "tiny-embedding", "");
    build(root.path(), Arc::new(Control::default()));
    for semantic in [false, true] {
        let filter = Filter {
            speaker: "sarah".into(),
            tag: "faith".into(),
            from: "2025-10-01".into(),
            to: "2025-10-09".into(),
            ..Default::default()
        };
        let hits = index::search(root.path(), "prayer", semantic, &filter, 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "prayer");
        let none = index::search(
            root.path(),
            "prayer",
            semantic,
            &Filter {
                channel: "Missing".into(),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        assert!(none.is_empty());
    }
}
#[test]
fn keyword_search_preserves_exact_phrases_highlights_and_speaker_identity() {
    let root=tempfile::tempdir().unwrap();fixture(root.path());
    db::open(root.path()).unwrap().execute_batch("INSERT INTO segments(media_id,start,end,speaker,text) VALUES ('prayer',0,10,'unknown','Faith and prayer from another overlapping voice');").unwrap();
    let filter=Filter{kind:"recording".into(),speaker:"sarah".into(),exact:true,..Default::default()};
    let hits=index::search(root.path(),"faith and prayer",false,&filter,100).unwrap();
    assert_eq!(hits.len(),1);
    assert_eq!(hits[0].speaker_name.as_deref(),Some("Sarah"));
    assert!(hits[0].marked.as_ref().unwrap().contains("\u{2}Faith and prayer\u{3}"));
    assert!(index::search(root.path(),"prayer faith",false,&filter,100).unwrap().is_empty());
    let words=Filter{exact:false,..filter};
    assert_eq!(index::search(root.path(),"prayer faith",false,&words,100).unwrap().len(),1);
}
#[test]
fn wrong_dimensions_are_rejected_before_search() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let fake = Fake::new();
    fake.config(root.path(), "embedding", "wrong-dim", "");
    build(root.path(), Arc::new(Control::default()));
    let sig = config::read(root.path()).unwrap().embedding.signature();
    db::open(root.path())
        .unwrap()
        .execute(
            "UPDATE ai_indexes SET dimensions=2 WHERE signature=?1",
            [sig],
        )
        .unwrap();
    assert!(
        index::search(root.path(), "prayer", true, &Filter::default(), 10)
            .unwrap_err()
            .to_string()
            .contains("dimensions")
    );
}
#[test]
fn chat_streams_saves_citation_snapshots_and_uses_only_its_credential() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let fake = Fake::new();
    fake.config(root.path(), "embedding", "tiny-embedding", "embed-key");
    fake.config(root.path(), "chat", "tiny-chat", "chat-key");
    let control = Arc::new(Control::default());
    build(root.path(), control.clone());
    let id = chat::create(root.path()).unwrap();
    let mut streamed = String::new();
    let result = chat::send(
        root.path(),
        &control,
        &chat::Send {
            conversation_id: id.clone(),
            text: "prayer".into(),
            use_library: true,
            semantic: true,
            filter: Filter::default(),
        },
        |d| streamed.push_str(d),
    )
    .unwrap();
    assert!(streamed.contains("[1]"));
    assert_eq!(result["messages"][1]["error"], 0);
    assert!(!result["messages"][1]["sources"]
        .as_array()
        .unwrap()
        .is_empty());
    let seen = fake.requests.lock().unwrap();
    for (path, auth, _) in seen.iter() {
        assert_eq!(
            auth,
            if path.ends_with("/embeddings") {
                "Bearer embed-key"
            } else {
                "Bearer chat-key"
            }
        );
    }
    drop(seen);
    let message = result["messages"][1]["id"].as_str().unwrap();
    chat::star(root.path(), message, true).unwrap();
    chat::edit(
        root.path(),
        &control,
        &id,
        Some("Prayer research"),
        Some(true),
        false,
    )
    .unwrap();
    let saved = chat::read(root.path(), &id).unwrap();
    assert_eq!(saved["conversation"]["pinned"], 1);
    assert_eq!(saved["messages"][1]["starred"], 1);
    db::open(root.path())
        .unwrap()
        .execute(
            "UPDATE docs SET body='Completely changed' WHERE id='doc'",
            [],
        )
        .unwrap();
    assert_eq!(
        chat::read(root.path(), &id).unwrap()["messages"][1]["sources"],
        result["messages"][1]["sources"]
    );
    chat::edit(root.path(), &control, &id, None, None, true).unwrap();
    assert!(chat::read(root.path(), &id).is_err());
    assert_eq!(
        db::open(root.path())
            .unwrap()
            .query_row("SELECT count(*) FROM ai_messages", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn incomplete_stream_is_saved_as_error_and_can_be_retried() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let fake = Fake::new();
    fake.config(root.path(), "chat", "broken-stream", "");
    let control = Control::default();
    let id = chat::create(root.path()).unwrap();
    let result = chat::send(
        root.path(),
        &control,
        &chat::Send {
            conversation_id: id.clone(),
            text: "Hello".into(),
            use_library: false,
            semantic: false,
            filter: Filter::default(),
        },
        |_| {},
    )
    .unwrap();
    assert_eq!(result["messages"][1]["error"], 1);
    assert!(control.chats.lock().unwrap().is_empty());
}
#[test]
#[ignore = "Opt-in: requires the pinned local Qwen GGUF and compiled embedding runtime"]
fn builtin_cpu_model_returns_real_retrieval_vectors() {
    let path = std::env::var("CONCORD_EMBEDDING_MODEL")
        .expect("Set CONCORD_EMBEDDING_MODEL to the pinned Qwen GGUF");
    let root = tempfile::tempdir().unwrap();
    let dest = root
        .path()
        .join("models/embedding/Qwen3-Embedding-0.6B-Q8_0.gguf");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::copy(path, dest).unwrap();
    let p = super::builtin::provider(root.path(), |_| Ok(())).unwrap();
    let vectors = p
        .embed(
            &p.client().unwrap(),
            &[
                "Prayer supports our community.".into(),
                "Cars need new tires and oil.".into(),
                index::query_input("encouraging one another through prayer", &p.model),
            ],
        )
        .unwrap();
    assert_eq!(vectors[0].len(), 1024);
    let score = |n: usize| {
        vectors[n]
            .iter()
            .zip(&vectors[2])
            .map(|(a, b)| a * b)
            .sum::<f32>()
    };
    assert!(score(0) > score(1));
    super::builtin::stop();
}

#[test]
fn summary_jobs_keep_speakers_and_replace_content_only_after_completion() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let fake = Fake::new();
    fake.config(root.path(), "chat", "tiny-chat", "");
    let db = db::open(root.path()).unwrap();
    db.execute("INSERT INTO ai_summaries(media_id,content,model,digest) VALUES('prayer','Previous summary','old','old')",[]).unwrap();
    // Enough text to require section summaries followed by a reduction request.
    db.execute(
        "UPDATE segments SET text=?1 WHERE media_id='prayer'",
        ["Faith and prayer. ".repeat(800)],
    )
    .unwrap();
    let control = Arc::new(Control::default());
    let job = super::summary::start(root.path().into(), control.clone(), "prayer".into()).unwrap();
    let until = Instant::now();
    while !control.summaries.lock().unwrap().is_empty() {
        assert!(until.elapsed() < Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(20));
    }
    let state = super::summary::state(root.path(), "prayer").unwrap();
    assert_eq!(state["job"]["id"], job);
    assert_eq!(state["job"]["status"], "complete");
    assert_eq!(state["job"]["done"], state["job"]["total"]);
    assert_eq!(state["job"]["total"], 3);
    assert_eq!(state["summary"]["model"], "tiny-chat");
    let requests = fake.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].2["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("Sarah:"));
    drop(requests);
    fake.config(root.path(), "chat", "broken-stream", "");
    super::summary::start(root.path().into(), control.clone(), "prayer".into()).unwrap();
    let until = Instant::now();
    while !control.summaries.lock().unwrap().is_empty() {
        assert!(until.elapsed() < Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(20));
    }
    let failed = super::summary::state(root.path(), "prayer").unwrap();
    assert_eq!(failed["job"]["status"], "failed");
    assert_eq!(failed["summary"], state["summary"]);
}
#[test]
fn summary_reentry_does_not_duplicate_requests_and_stop_keeps_the_previous_summary() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let db = db::open(root.path()).unwrap();
    db.execute("INSERT INTO ai_summaries(media_id,content,model,digest) VALUES('prayer','Keep this summary','old','old')",[]).unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", server.server_addr());
    let (seen_tx, seen_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let request = server
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        seen_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(5));
        let _ = request.respond(tiny_http::Response::from_string("data: [DONE]\n\n"));
    });
    config::save(
        root.path(),
        "chat",
        Provider {
            account_id: String::new(),
            enabled: true,
            kind: "local".into(),
            base_url: url,
            model: "slow".into(),
            api_key: String::new(),
        },
        None,
    )
    .unwrap();
    let control = Arc::new(Control::default());
    let job = super::summary::start(root.path().into(), control.clone(), "prayer".into()).unwrap();
    seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        super::summary::start(root.path().into(), control.clone(), "prayer".into()).unwrap(),
        job
    );
    assert!(super::summary::start(root.path().into(), control.clone(), "car".into()).is_err());
    assert_eq!(
        db.query_row("SELECT count(*) FROM summary_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    super::summary::cancel(&control, "prayer");
    let until = Instant::now();
    while !control.summaries.lock().unwrap().is_empty() {
        assert!(until.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(20));
    }
    let state = super::summary::state(root.path(), "prayer").unwrap();
    assert_eq!(state["job"]["status"], "cancelled");
    assert_eq!(state["summary"]["content"], "Keep this summary");
    release_tx.send(()).unwrap();
    worker.join().unwrap();
}
#[test]
fn stop_chat_interrupts_before_first_token() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", server.server_addr());
    let worker = std::thread::spawn(move || {
        let request = server
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        std::thread::sleep(Duration::from_secs(1));
        let _ = request.respond(tiny_http::Response::from_string("data: [DONE]\n\n"));
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let trigger = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        signal.store(true, Ordering::SeqCst);
    });
    let p = Provider {
        account_id: String::new(),
        enabled: true,
        kind: "local".into(),
        base_url: url,
        model: "slow".into(),
        api_key: String::new(),
    };
    let start = Instant::now();
    let result = chat::complete(
        Path::new("/unused-chat-fixture"),
        &p,
        &[json!({"role":"user","content":"Hello"})],
        &cancel,
        |_| {},
    );
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert!(start.elapsed() < Duration::from_millis(600));
    trigger.join().unwrap();
    worker.join().unwrap();
}

#[test]
fn category_filters_scope_words_semantic_retrieval_and_note_evidence() {
    let root=tempfile::tempdir().unwrap();fixture(root.path());
    db::open(root.path()).unwrap().execute_batch("UPDATE media SET category='work' WHERE id='prayer';
      INSERT INTO notes(id,title,body) VALUES('standalone','Prayer thought','A prayer without evidence.');").unwrap();
    let fake=Fake::new();fake.config(root.path(),"embedding","tiny-embedding","");
    build(root.path(),Arc::new(Control::default()));
    for semantic in [false,true] {
        let hits=|category:&str|index::search(root.path(),"prayer",semantic,&Filter{category:category.into(),..Default::default()},100).unwrap().into_iter().map(|h|h.id).collect::<Vec<_>>();
        let work=hits("work");assert!(work.contains(&"prayer".into()));assert!(work.contains(&"note".into()));assert!(work.contains(&"standalone".into()));assert!(!work.contains(&"doc".into()));
        let personal=hits("personal");assert!(personal.contains(&"doc".into()));assert!(!personal.contains(&"note".into()));assert!(!personal.contains(&"prayer".into()));
    }
    let research=crate::research::read(root.path()).unwrap();
    let note=research["notes"].as_array().unwrap().iter().find(|n|n["id"]=="note").unwrap();
    assert_eq!(note["anchors"][0]["category"],"work");
}

fn completed_speech(root: &Path, parent: &str) {
    let db = db::open(root).unwrap();
    db.execute("UPDATE media SET transcript='revision-1.json',status='complete' WHERE id='prayer'",[]).unwrap();
    db.execute("INSERT INTO jobs(id,media_id,title,status) VALUES(?1,'prayer','Prayer meeting','complete')",[parent]).unwrap();
    super::automation::enqueue(&db,parent).unwrap();
}
fn finish_automatic(root: &Path, control: &Arc<Control>) -> Value {
    let deadline = Instant::now();
    loop {
        super::automation::tick(root,control).unwrap();
        let state = super::automation::state(root).unwrap();
        if !state["jobs"].as_array().unwrap().iter().any(|j| j["status"]=="queued" || j["status"]=="running") && !control.indexing.load(Ordering::SeqCst) && control.summaries.lock().unwrap().is_empty() { return state; }
        assert!(deadline.elapsed()<Duration::from_secs(10),"{state}");
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn automatic_ai_is_opt_in_and_scopes_each_provider_to_the_new_recording() {
    let root=tempfile::tempdir().unwrap();fixture(root.path());
    let embed=Fake::new();let chat=Fake::new();
    embed.config(root.path(),"embedding","tiny-embedding","embedding-secret");
    chat.config(root.path(),"chat","tiny-chat","chat-secret");
    let control=Arc::new(Control::default());
    completed_speech(root.path(),"before-opt-in");
    assert!(super::automation::state(root.path()).unwrap()["jobs"].as_array().unwrap().is_empty());
    super::automation::save(root.path(),&control,true,true).unwrap();
    assert!(super::automation::state(root.path()).unwrap()["jobs"].as_array().unwrap().is_empty());
    completed_speech(root.path(),"after-opt-in");
    let db=db::open(root.path()).unwrap();
    super::automation::enqueue(&db,"after-opt-in").unwrap();
    let done=finish_automatic(root.path(),&control);
    assert_eq!(done["jobs"].as_array().unwrap().len(),2);
    assert!(done["jobs"].as_array().unwrap().iter().all(|j|j["status"]=="complete"),"{done}");
    assert!(!done.to_string().contains("secret"));
    assert_eq!(db.query_row("SELECT group_concat(kind||':'||source_id) FROM ai_sources",[],|r|r.get::<_,String>(0)).unwrap(),"recording:prayer");
    assert_eq!(embed.requests.lock().unwrap().len(),1);
    assert_eq!(chat.requests.lock().unwrap().len(),1);
    assert_eq!(embed.requests.lock().unwrap()[0].1,"Bearer embedding-secret");
    assert_eq!(chat.requests.lock().unwrap()[0].1,"Bearer chat-secret");
    assert_eq!(db.query_row("SELECT status FROM jobs WHERE id='after-opt-in'",[],|r|r.get::<_,String>(0)).unwrap(),"complete");
}
#[test]
fn automatic_ai_provider_changes_block_until_explicit_retry_and_never_reuse_keys() {
    let root=tempfile::tempdir().unwrap();fixture(root.path());
    let first=Fake::new();let second=Fake::new();
    first.config(root.path(),"chat","tiny-chat","first-secret");
    let control=Arc::new(Control::default());
    super::automation::save(root.path(),&control,false,true).unwrap();
    completed_speech(root.path(),"j");
    second.config(root.path(),"chat","new-chat","second-secret");
    let state=finish_automatic(root.path(),&control);
    assert_eq!(state["jobs"][0]["status"],"blocked");assert_eq!(state["summary"]["needsReview"],true);
    let id=state["jobs"][0]["id"].as_str().unwrap();
    assert!(super::automation::action(root.path(),&control,id,"retry").is_err());
    super::automation::save(root.path(),&control,false,true).unwrap();
    assert_eq!(finish_automatic(root.path(),&control)["jobs"][0]["status"],"blocked");
    assert!(first.requests.lock().unwrap().is_empty());assert!(second.requests.lock().unwrap().is_empty());
    super::automation::action(root.path(),&control,id,"retry").unwrap();
    assert_eq!(finish_automatic(root.path(),&control)["jobs"][0]["status"],"complete");
    assert!(first.requests.lock().unwrap().is_empty());assert_eq!(second.requests.lock().unwrap()[0].1,"Bearer second-secret");
}
#[test]
fn automatic_ai_waits_for_manual_work_and_failure_never_changes_speech_success() {
    let root=tempfile::tempdir().unwrap();fixture(root.path());let fake=Fake::new();
    fake.config(root.path(),"chat","broken-stream","");
    let control=Arc::new(Control::default());
    super::automation::save(root.path(),&control,false,true).unwrap();completed_speech(root.path(),"j");
    control.summaries.lock().unwrap().insert("car".into(),super::summary::Task{id:"manual".into(),cancel:Arc::new(AtomicBool::new(false))});
    super::automation::tick(root.path(),&control).unwrap();
    assert_eq!(super::automation::state(root.path()).unwrap()["jobs"][0]["status"],"queued");
    assert!(fake.requests.lock().unwrap().is_empty());
    control.summaries.lock().unwrap().clear();
    assert_eq!(finish_automatic(root.path(),&control)["jobs"][0]["status"],"failed");
    let db=db::open(root.path()).unwrap();
    assert_eq!(db.query_row("SELECT status FROM jobs WHERE id='j'",[],|r|r.get::<_,String>(0)).unwrap(),"complete");
    assert_eq!(db.query_row("SELECT status FROM media WHERE id='prayer'",[],|r|r.get::<_,String>(0)).unwrap(),"complete");
}
#[test]
fn automatic_ai_skips_newer_transcripts_and_keeps_existing_summaries() {
    let root=tempfile::tempdir().unwrap();fixture(root.path());let fake=Fake::new();fake.config(root.path(),"chat","tiny-chat","");
    let control=Arc::new(Control::default());super::automation::save(root.path(),&control,false,true).unwrap();completed_speech(root.path(),"old");
    let db=db::open(root.path()).unwrap();
    db.execute("UPDATE media SET transcript='revision-2.json' WHERE id='prayer'",[]).unwrap();
    assert_eq!(finish_automatic(root.path(),&control)["jobs"][0]["status"],"skipped");
    completed_speech(root.path(),"new");
    db.execute("INSERT INTO ai_summaries VALUES('prayer','Keep this','old','hash',datetime('now'))",[]).unwrap();
    assert!(finish_automatic(root.path(),&control)["jobs"].as_array().unwrap().iter().all(|j|j["status"]=="skipped"));
    assert!(fake.requests.lock().unwrap().is_empty());
    assert_eq!(super::summary::state(root.path(),"prayer").unwrap()["summary"]["content"],"Keep this");
}
#[test]
fn automatic_ai_restart_retains_queued_work_without_repeating_interrupted_requests() {
    let root=tempfile::tempdir().unwrap();fixture(root.path());let fake=Fake::new();fake.config(root.path(),"chat","tiny-chat","");
    let control=Arc::new(Control::default());super::automation::save(root.path(),&control,false,true).unwrap();completed_speech(root.path(),"interrupted");completed_speech(root.path(),"queued");
    let db=db::open(root.path()).unwrap();
    db.execute_batch("INSERT INTO summary_jobs(id,media_id,model,status) VALUES('child','prayer','tiny-chat','running');UPDATE ai_followups SET status='running',child_id='child' WHERE parent_id='interrupted';").unwrap();
    super::summary::recover(&db).unwrap();super::automation::recover(&db).unwrap();
    let done=finish_automatic(root.path(),&Arc::new(Control::default()));
    assert!(done["jobs"].as_array().unwrap().iter().any(|j|j["parent_id"]=="interrupted"&&j["status"]=="interrupted"));
    assert!(done["jobs"].as_array().unwrap().iter().any(|j|j["parent_id"]=="queued"&&j["status"]=="complete"));
    assert_eq!(fake.requests.lock().unwrap().len(),1);
}
#[test]
fn disabling_automatic_actions_does_not_cancel_manual_jobs() {
    let root=tempfile::tempdir().unwrap();fixture(root.path());let fake=Fake::new();fake.config(root.path(),"chat","tiny-chat","");
    let control=Arc::new(Control::default());super::automation::save(root.path(),&control,true,true).unwrap();completed_speech(root.path(),"j");
    let db=db::open(root.path()).unwrap();
    // A prior child finished while a different manually requested job took the slot.
    db.execute("UPDATE ai_followups SET status='running',child_id='old-child'",[]).unwrap();
    *control.index_job.lock().unwrap()=Some("manual-index".into());control.indexing.store(true,Ordering::SeqCst);
    let manual_cancel=Arc::new(AtomicBool::new(false));
    control.summaries.lock().unwrap().insert("prayer".into(),super::summary::Task{id:"manual-summary".into(),cancel:manual_cancel.clone()});
    super::automation::save(root.path(),&control,false,false).unwrap();
    assert!(!control.cancel_index.load(Ordering::SeqCst));assert!(!manual_cancel.load(Ordering::SeqCst));
}
