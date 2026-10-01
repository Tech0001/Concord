use super::*;
use crate::{db, speech};
use serde_json::Value;
use std::sync::{atomic::Ordering, Arc};

fn fixture() -> (tempfile::TempDir, Control) {
    let root = tempfile::tempdir().unwrap();
    let db = db::open(root.path()).unwrap();
    for id in ["one", "two"] {
        let file = root.path().join(format!("{id}.ogg"));
        std::fs::write(&file, b"fixture").unwrap();
        db.execute("INSERT INTO media(id,title,channel,path,transcript,status) VALUES (?1,?1,'Meetings',?2,'old-transcript.md','complete')",rusqlite::params![id,file.to_string_lossy()]).unwrap();
    }
    db.execute("INSERT INTO media(id,title,channel,path) VALUES ('missing','Missing','Meetings','/missing/concord-fixture.ogg')",[]).unwrap();
    (root, Control::new(Arc::new(speech::Control::default())))
}
fn state(root: &Path, id: &str) -> Value {
    db::rows(&db::open(root).unwrap(),"SELECT j.*,p.attempts,p.retry_at FROM jobs j JOIN pipeline_work p ON p.id=j.id WHERE j.id=?1",[id]).unwrap().pop().unwrap()
}
#[test]
fn batch_is_deduplicated_pausable_and_preserves_previous_recordings() {
    let (dir, c) = fixture();
    let root = dir.path();
    let batch = Batch {
        channel: "Meetings".into(),
        ..Default::default()
    };
    let preview = candidates(root, &batch).unwrap();
    assert_eq!(preview["eligible"], 2);
    assert_eq!(preview["unavailable"], 1);
    let result = enqueue(root, &c, &batch, false).unwrap();
    assert_eq!(result["added"], 2);
    assert_eq!(result["unavailable"], 1);
    assert_eq!(enqueue(root, &c, &batch, true).unwrap()["alreadyQueued"], 2);
    assert!(queue::claim(root, 1).unwrap().is_none());
    action(root, &c, "start", None).unwrap();
    let job = queue::claim(root, 1).unwrap().unwrap();
    let id = job["id"].as_str().unwrap();
    assert_eq!(job["media_id"], "one");
    action(root, &c, "pause", None).unwrap();
    queue::finish(root, id, Ok(()), &c, 2).unwrap();
    assert!(queue::claim(root, 2).unwrap().is_none());
    assert_eq!(state(root, id)["status"], "complete");
    assert_eq!(
        db::media(root, "one").unwrap()["transcript"],
        "old-transcript.md"
    );
    assert_eq!(db::media(root, "one").unwrap()["status"], "complete");
}
#[test]
fn retry_waits_for_its_deadline_and_does_not_block_other_jobs() {
    let (dir, c) = fixture();
    let root = dir.path();
    save_config(
        root,
        &Config {
            retries: 1,
            retry_minutes: 2,
            ..Default::default()
        },
    )
    .unwrap();
    enqueue(root, &c, &Batch::default(), true).unwrap();
    let one = queue::claim(root, 100).unwrap().unwrap();
    let id = one["id"].as_str().unwrap();
    queue::finish(root, id, Err(anyhow::anyhow!("temporary failure")), &c, 100).unwrap();
    assert_eq!(state(root, id)["status"], "retry");
    assert_eq!(state(root, id)["retry_at"], 220);
    let two = queue::claim(root, 101).unwrap().unwrap();
    assert_eq!(two["media_id"], "two");
    queue::finish(root, two["id"].as_str().unwrap(), Ok(()), &c, 101).unwrap();
    assert!(queue::claim(root, 219).unwrap().is_none());
    assert_eq!(queue::claim(root, 220).unwrap().unwrap()["id"], id);
    queue::finish(root, id, Err(anyhow::anyhow!("permanent failure")), &c, 221).unwrap();
    assert_eq!(state(root, id)["status"], "failed");
    action(root, &c, "retry", Some(id)).unwrap();
    assert_eq!(state(root, id)["attempts"], 0);
}
#[test]
fn restart_resumes_only_interrupted_work_and_honors_cancellation() {
    let (dir, c) = fixture();
    let root = dir.path();
    let result = enqueue(root, &c, &Batch::default(), true).unwrap();
    let two = result["ids"][1].as_str().unwrap();
    let one = queue::claim(root, 1).unwrap().unwrap();
    let id = one["id"].as_str().unwrap();
    recover(root).unwrap();
    recover(root).unwrap();
    assert_eq!(state(root, id)["status"], "queued");
    assert_eq!(state(root, id)["attempts"], 0);
    action(root, &c, "cancel", Some(two)).unwrap();
    recover(root).unwrap();
    assert_eq!(state(root, two)["status"], "cancelled");
    queue::claim(root, 3).unwrap().unwrap();
    *c.gate.lock().unwrap() = Some(id.into());
    action(root, &c, "stop", None).unwrap();
    queue::finish(root, id, Err(anyhow::anyhow!("cancelled")), &c, 4).unwrap();
    assert_eq!(state(root, id)["status"], "cancelled");
    assert_eq!(snapshot(root).unwrap()["running"], false);
    // A crash after a cancellation request but before subprocess exit must not restart it.
    db::open(root)
        .unwrap()
        .execute("UPDATE jobs SET status='running' WHERE id=?1", [id])
        .unwrap();
    recover(root).unwrap();
    assert_eq!(state(root, id)["status"], "cancelled");
}
#[test]
fn normal_shutdown_does_not_consume_a_retry_and_history_deletes_cascade() {
    let (dir, c) = fixture();
    let root = dir.path();
    enqueue(
        root,
        &c,
        &Batch {
            ids: vec!["one".into()],
            ..Default::default()
        },
        true,
    )
    .unwrap();
    let row = queue::claim(root, 1).unwrap().unwrap();
    let id = row["id"].as_str().unwrap();
    c.closing.store(true, Ordering::SeqCst);
    queue::finish(root, id, Err(anyhow::anyhow!("closing")), &c, 2).unwrap();
    recover(root).unwrap();
    assert_eq!(state(root, id)["attempts"], 0);
    assert_eq!(state(root, id)["status"], "queued");
    action(root, &c, "cancel-pending", None).unwrap();
    action(root, &c, "clear", None).unwrap();
    assert!(snapshot(root).unwrap()["jobs"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "requires installed speech models and CONCORD_TEST_AUDIO"]
fn real_queue_publishes_a_transcript_and_releases_the_worker() {
    let root = tempfile::tempdir().unwrap();
    let input = std::env::var("CONCORD_TEST_AUDIO").expect("CONCORD_TEST_AUDIO");
    db::import_files(root.path(), &[input]).unwrap();
    let control = Arc::new(Control::new(Arc::new(speech::Control::default())));
    save_config(
        root.path(),
        &Config {
            retries: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let result = enqueue(root.path(), &control, &Batch::default(), true).unwrap();
    assert_eq!(result["added"], 1);
    let id = result["ids"][0].as_str().unwrap();
    launch(
        root.path().to_owned(),
        speech::Runtime::resolve(None),
        control.clone(),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let status = loop {
        let row = state(root.path(), id);
        if ["complete", "failed", "cancelled"].contains(&row["status"].as_str().unwrap()) {
            break row;
        }
        if std::time::Instant::now() > deadline {
            control.shutdown();
            panic!("Queue transcription timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    };
    control.shutdown();
    assert_eq!(status["status"], "complete", "{status}");
    assert!(!control.speech.busy.load(Ordering::SeqCst));
    let media = status["media_id"].as_str().unwrap();
    let recording = db::transcript(root.path(), media).unwrap();
    assert!(!recording["segments"].as_array().unwrap().is_empty());
    assert!(!recording["assignments"].as_array().unwrap().is_empty());
    assert!(
        std::path::Path::new(recording["media"]["transcript"].as_str().unwrap())
            .starts_with(root.path())
    );
}

#[test]
fn download_cap_resets_by_date_and_does_not_block_local_transcription() {
    let (dir, c) = fixture();
    let root = dir.path();
    let db = db::open(root).unwrap();
    save_config(
        root,
        &Config {
            daily_limit: 1,
            ..Default::default()
        },
    )
    .unwrap();
    db.execute("INSERT INTO media(id,title,url,status) VALUES ('remote','Remote','https://www.youtube.com/watch?v=fixture1234','pending')",[]).unwrap();
    let remote = queue::insert(&db, "remote", "Remote", "download", "auto", true)
        .unwrap()
        .unwrap();
    db.execute(
        "INSERT INTO pipeline_downloads(job_id,day) VALUES ('previous',date('now','localtime'))",
        [],
    )
    .unwrap();
    enqueue(
        root,
        &c,
        &Batch {
            ids: vec!["one".into()],
            ..Default::default()
        },
        true,
    )
    .unwrap();
    let local = queue::claim(root, 1).unwrap().unwrap();
    assert_eq!(local["media_id"], "one");
    queue::finish(root, local["id"].as_str().unwrap(), Ok(()), &c, 2).unwrap();
    assert!(queue::claim(root, 2).unwrap().is_none());
    assert_eq!(overview(root).unwrap()["atDailyLimit"], true);
    db.execute(
        "UPDATE pipeline_downloads SET day=date('now','localtime','-1 day')",
        [],
    )
    .unwrap();
    assert_eq!(queue::claim(root, 3).unwrap().unwrap()["id"], remote);
    queue::wait_for_live(root, &remote, 4).unwrap();
    assert_eq!(state(root, &remote)["attempts"], 0);
    assert!(queue::claim(root, 303).unwrap().is_none());
    assert_eq!(queue::claim(root, 304).unwrap().unwrap()["id"], remote);
}

#[test]
fn folder_sources_preserve_files_metadata_and_labels_when_edited_or_removed() {
    let (dir, c) = fixture();
    let root = dir.path();
    let folder = root.join("incoming");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("meeting.ogg"), b"sample").unwrap();
    let mut input = sources::Source {
        id: None,
        name: "Folder meetings".into(),
        kind: "folder".into(),
        url: folder.to_string_lossy().into_owned(),
        enabled: true,
        diarize: false,
        include_shorts: false,
        category: "work".into(),
    };
    let id = sources::save(root, &c, &input).unwrap();
    let source = sources::list(root).unwrap().pop().unwrap();
    assert_eq!(sources::local(root, &c, &source).unwrap(), 1);
    assert_eq!(sources::local(root, &c, &source).unwrap(), 0);
    let state = snapshot(root).unwrap();
    assert_eq!(state["running"], false);
    assert_eq!(state["jobs"][0]["diarize"], 0);
    let media = state["jobs"][0]["media_id"].as_str().unwrap();
    let item = db::media(root, media).unwrap();
    assert_eq!(item["category"], "work");
    input.id = Some(id.clone());
    input.name = "Renamed folder".into();
    sources::save(root, &c, &input).unwrap();
    assert_eq!(db::media(root, media).unwrap()["channel"], "Renamed folder");
    sources::remove(root, &c, &id).unwrap();
    assert_eq!(db::media(root, media).unwrap()["source_id"], Value::Null);
    assert!(folder.join("meeting.ogg").exists());
    assert_eq!(snapshot(root).unwrap()["jobs"].as_array().unwrap().len(), 1);
}

#[test]
fn youtube_scan_preserves_existing_archive_and_rejects_unsafe_urls() {
    use serde_json::json;
    let (dir, c) = fixture();
    let root = dir.path();
    let input = sources::Source {
        id: None,
        name: "Channel".into(),
        kind: "youtube".into(),
        url: "https://www.youtube.com/@sample".into(),
        enabled: true,
        diarize: true,
        include_shorts: true,
        category: "personal".into(),
    };
    let id = sources::save(root, &c, &input).unwrap();
    let source = sources::list(root).unwrap().pop().unwrap();
    let entries = vec![
        json!({"id":"first123456","title":"First"}),
        json!({"id":"short123456","title":"Short"}),
        json!({"id":"../../bad","title":"Invalid"}),
    ];
    assert_eq!(sources::ingest(root, &source, &entries, "auto").unwrap(), 2);
    assert_eq!(sources::ingest(root, &source, &entries, "auto").unwrap(), 0);
    let jobs = snapshot(root).unwrap();
    assert_eq!(jobs["jobs"].as_array().unwrap().len(), 2);
    assert_eq!(jobs["jobs"][0]["kind"], "download");
    assert_eq!(download::scan_urls(&input.url, false).unwrap().len(), 2);
    assert_eq!(download::scan_urls(&input.url, true).unwrap().len(), 3);
    assert!(download::youtube_url("https://youtube.com.evil.test/@sample").is_err());
    assert!(download::youtube_url("file:///tmp/input").is_err());
    assert!(download::youtube_url("https://user:password@youtube.com/@sample").is_err());
    let duplicate = sources::Source {
        id: None,
        name: "Duplicate".into(),
        url: "https://www.youtube.com/@sample/videos".into(),
        ..input
    };
    assert!(sources::save(root, &c, &duplicate).is_err());
    assert!(sources::list(root).unwrap().iter().any(|s| s["id"] == id));
}

#[test]
fn partial_source_output_retains_valid_entries_and_empty_playlists_are_not_videos() {
    let root = tempfile::tempdir().unwrap();
    let control = speech::Control::default();
    let mut cmd = std::process::Command::new("python3");
    cmd.args(["-c","import sys,json; print(json.dumps({'_type':'playlist','entries':[{'id':'kept1234567','title':'Available'}]})); print('One item unavailable',file=sys.stderr);sys.exit(1)"]);
    let output = subprocess::capture(
        root.path(),
        &control,
        cmd,
        None,
        std::time::Duration::from_secs(10),
    )
    .unwrap();
    assert!(!output.success);
    assert!(output.error.contains("One item unavailable"));
    assert_eq!(sources::listing(&output.text).unwrap().len(), 1);
    assert!(
        sources::listing(r#"{"_type":"playlist","id":"channel","entries":null}"#)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        sources::listing(r#"{"id":"single12345","title":"Single video"}"#)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn clearing_other_pending_work_does_not_change_a_later_failure() {
    let (dir, c) = fixture();
    let root = dir.path();
    // Use an untranscribed local item so media.status follows its current job.
    db::open(root)
        .unwrap()
        .execute("UPDATE media SET transcript=NULL WHERE id='one'", [])
        .unwrap();
    let batch = Batch {
        ids: vec!["one".into()],
        ..Default::default()
    };
    let old = enqueue(root, &c, &batch, false).unwrap()["ids"][0]
        .as_str()
        .unwrap()
        .to_owned();
    action(root, &c, "cancel", Some(&old)).unwrap();
    save_config(
        root,
        &Config {
            retries: 0,
            ..Default::default()
        },
    )
    .unwrap();
    enqueue(root, &c, &batch, true).unwrap();
    let current = queue::claim(root, 1).unwrap().unwrap();
    queue::finish(
        root,
        current["id"].as_str().unwrap(),
        Err(anyhow::anyhow!("failed")),
        &c,
        2,
    )
    .unwrap();
    assert_eq!(db::media(root, "one").unwrap()["status"], "failed");
    action(root, &c, "cancel-pending", None).unwrap();
    assert_eq!(db::media(root, "one").unwrap()["status"], "failed");
}

#[test]
fn category_limits_batch_preview_and_enqueue() {
    let (dir,c)=fixture();let root=dir.path();
    db::set_category(root,"two","work").unwrap();
    let batch=Batch{category:"work".into(),..Default::default()};
    assert_eq!(candidates(root,&batch).unwrap()["eligible"],1);
    assert_eq!(enqueue(root,&c,&batch,false).unwrap()["added"],1);
    assert_eq!(snapshot(root).unwrap()["jobs"][0]["media_id"],"two");
    assert_eq!(enqueue(root,&c,&Batch{ids:vec!["one".into()],..batch},false).unwrap()["added"],0);
}

#[test]
fn only_successful_transcription_queues_optional_ai_and_invalid_policy_cannot_fail_it() {
    let (dir,c)=fixture();let root=dir.path();
    let ai=crate::ai::Control::default();
    crate::ai::automation::save(root,&ai,true,false).unwrap();
    enqueue(root,&c,&Batch::default(),true).unwrap();
    let one=queue::claim(root,1).unwrap().unwrap();let id=one["id"].as_str().unwrap();
    queue::finish(root,id,Err(anyhow::anyhow!("speech failed")),&c,2).unwrap();
    let db=db::open(root).unwrap();
    assert_eq!(db.query_row("SELECT count(*) FROM ai_followups",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    let two=queue::claim(root,3).unwrap().unwrap();let id=two["id"].as_str().unwrap();
    queue::finish(root,id,Ok(()),&c,4).unwrap();
    assert_eq!(db.query_row("SELECT count(*) FROM ai_followups",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    db.execute("UPDATE settings SET value='invalid json' WHERE key='ai.automation'",[]).unwrap();
    let id=one["id"].as_str().unwrap();queue::finish(root,id,Ok(()),&c,5).unwrap();
    assert_eq!(state(root,id)["status"],"complete");
}
