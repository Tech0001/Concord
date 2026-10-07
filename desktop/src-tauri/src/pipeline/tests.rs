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
    // Work runs by itself; only an explicit pause holds it.
    action(root, &c, "pause", None).unwrap();
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
    downloader::fixture(root);
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
    // Found recordings are processed without a separate start step.
    assert_eq!(state["running"], true);
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
#[test]
fn queued_work_waits_for_speech_instead_of_failing() {
    let (dir, c) = fixture();
    let root = dir.path();
    let id = enqueue_one(root, &c, "one".into(), "auto".into()).unwrap();
    queue::wait_for_speech(root).unwrap();
    let job = state(root, &id);
    assert_eq!(job["status"], "queued");
    assert_eq!(job["message"], queue::WAITING_FOR_SPEECH);
    assert_eq!(job["attempts"], 0);
}
#[test]
fn speech_device_lives_in_the_pipeline_config() {
    let (dir, _) = fixture();
    let root = dir.path();
    assert_eq!(device(root).unwrap(), "auto");
    set_device(root, "cpu").unwrap();
    assert_eq!(device(root).unwrap(), "cpu");
    assert_eq!(config(root).unwrap().device, "cpu");
    assert!(set_device(root, "gpu-please").is_err());
    assert_eq!(device(root).unwrap(), "cpu");
}
#[test]
fn files_added_during_setup_are_queued_for_transcription() {
    let (dir, c) = fixture();
    let root = dir.path();
    let file = root.join("new.m4a");
    std::fs::write(&file, b"fixture").unwrap();
    let added = import_and_queue(root, &c, &[file.to_string_lossy().into_owned()], "work", "auto", true).unwrap();
    assert_eq!(added, 1);
    let queued = db::rows(&db::open(root).unwrap(), "SELECT m.category,j.status FROM jobs j JOIN media m ON m.id=j.media_id WHERE m.path LIKE '%new.m4a'", []).unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!((queued[0]["category"].as_str(), queued[0]["status"].as_str()), (Some("work"), Some("queued")));
}
#[test]
fn waiting_work_fails_with_the_reason_when_speech_setup_fails() {
    let (dir, c) = fixture();
    let root = dir.path();
    let id = enqueue_one(root, &c, "one".into(), "auto".into()).unwrap();
    queue::wait_for_speech(root).unwrap();
    queue::fail_waiting_for_speech(root, "Speech setup failed: disk full").unwrap();
    let job = state(root, &id);
    assert_eq!(job["status"], "failed");
    assert_eq!(job["message"], "Speech setup failed: disk full");
}
#[test]
fn the_device_saves_even_when_other_pipeline_settings_are_stale() {
    let (dir, _) = fixture();
    let root = dir.path();
    let stale = Config { cookies_file: "/gone/cookies.txt".into(), ..Default::default() };
    db::open(root).unwrap().execute("INSERT INTO settings VALUES ('pipeline.config',?1)", [serde_json::to_string(&stale).unwrap()]).unwrap();
    set_device(root, "cpu").unwrap();
    assert_eq!(device(root).unwrap(), "cpu");
    assert_eq!(config(root).unwrap().cookies_file, "/gone/cookies.txt");
}

#[test]
fn disabled_downloads_wait_without_blocking_local_work_or_spending_retries() {
    let (dir,c)=fixture(); let root=dir.path();
    downloader::fixture(root);
    downloader::set_enabled(root,&c.downloader,false).unwrap();
    let db=db::open(root).unwrap();
    db.execute("INSERT INTO media(id,title,url,status) VALUES ('remote-opt','Remote','https://www.youtube.com/watch?v=fixture1234','pending')",[]).unwrap();
    let remote=queue::insert(&db,"remote-opt","Remote","download","auto",true).unwrap().unwrap();
    enqueue(root,&c,&Batch{ids:vec!["one".into()],..Default::default()},true).unwrap();
    let local=queue::claim(root,1).unwrap().unwrap(); assert_eq!(local["media_id"],"one");
    queue::finish(root,local["id"].as_str().unwrap(),Ok(()),&c,2).unwrap();
    assert!(queue::claim(root,3).unwrap().is_none()); assert_eq!(state(root,&remote)["attempts"],0);
    assert!(super::download::command(root,&Config::default()).is_err());
    downloader::set_enabled(root,&c.downloader,true).unwrap();
    assert_eq!(queue::claim(root,4).unwrap().unwrap()["id"],remote);
    downloader::set_enabled(root,&c.downloader,false).unwrap();
    c.speech.cancel();
    queue::finish(root,&remote,Err(anyhow::anyhow!("Cancelled")),&c,5).unwrap();
    assert_eq!(state(root,&remote)["status"],"queued"); assert_eq!(state(root,&remote)["attempts"],0);
    db.execute("UPDATE media SET path=(SELECT path FROM media WHERE id='one') WHERE id='remote-opt'",[]).unwrap();
    c.speech.begin();
    assert_eq!(queue::claim(root,6).unwrap().unwrap()["id"],remote);
    queue::finish(root,&remote,Err(anyhow::anyhow!("ASR failure on an already downloaded file")),&c,7).unwrap();
    assert_eq!(state(root,&remote)["status"],"retry");
    assert_eq!(state(root,&remote)["attempts"],1);
}

#[test]
fn removed_recordings_stay_out_of_folder_and_youtube_scans() {
    let (dir,c)=fixture();let root=dir.path();let ai=crate::ai::Control::default();
    let folder=root.join("incoming");std::fs::create_dir(&folder).unwrap();
    let path=folder.join("keep-on-disk.ogg");std::fs::write(&path,b"recording bytes").unwrap();
    let source=serde_json::json!({"id":"local","name":"Folder","url":folder,"category":"personal","diarize":0});
    assert_eq!(sources::local(root,&c,&source).unwrap(),1);
    let db=db::open(root).unwrap();let id:String=db.query_row("SELECT id FROM media",[],|r|r.get(0)).unwrap();
    crate::media_files::remove(root,&c,&ai,&id).unwrap();
    assert!(path.exists());assert_eq!(sources::local(root,&c,&source).unwrap(),0);
    assert_eq!(db::import_files(root,&[path.to_string_lossy().into_owned()]).unwrap(),1);
    assert_eq!(sources::local(root,&c,&source).unwrap(),0);
    let remote=serde_json::json!({"id":"yt","name":"Channel","category":"personal","diarize":0,"include_shorts":1});
    let entries=[serde_json::json!({"id":"AbCdEfGhI12","title":"Remote"})];
    assert_eq!(sources::ingest(root,&remote,&entries,"cpu").unwrap(),1);
    let id=serde_json::to_string(&("yt","AbCdEfGhI12")).unwrap();
    crate::media_files::remove(root,&c,&ai,&id).unwrap();
    assert_eq!(sources::ingest(root,&remote,&entries,"cpu").unwrap(),0);
}
#[test]
fn added_work_runs_without_a_start_step_until_paused() {
    let (dir, c) = fixture();
    let root = dir.path();
    let file = root.join("new.m4a");
    std::fs::write(&file, b"fixture").unwrap();
    {
        let db = db::open(root).unwrap();
        queue::insert(&db, "one", "one", "transcribe", "auto", true).unwrap();
    }
    assert!(queue::claim(root, 1).unwrap().is_some());
    action(root, &c, "pause", None).unwrap();
    queue::insert(&db::open(root).unwrap(), "two", "two", "transcribe", "auto", true).unwrap();
    assert!(queue::claim(root, 2).unwrap().is_none());
}
#[test]
fn the_overview_says_what_kind_of_work_is_running() {
    let (dir, _c) = fixture();
    let root = dir.path();
    {
        let db = db::open(root).unwrap();
        queue::insert(&db, "one", "one", "download", "auto", true).unwrap();
        queue::insert(&db, "two", "two", "transcribe", "auto", true).unwrap();
    }
    assert_eq!(overview(root).unwrap()["activeKind"], Value::Null);
    assert!(queue::claim(root, 1).unwrap().is_some());
    let now = overview(root).unwrap();
    assert_eq!(now["activeKind"], "download");
    assert_eq!(now["active"], 1);
    assert_eq!(now["queued"], 1);
}
fn channel(root: &Path, c: &Control) -> Value {
    let id = sources::save(root, c, &sources::Source {
        id: None,
        name: "Tuesday Study".into(),
        kind: "youtube".into(),
        url: "https://www.youtube.com/@TuesdayStudy".into(),
        enabled: true,
        diarize: true,
        include_shorts: false,
        category: "personal".into(),
    })
    .unwrap();
    sources::start_following(root, &id).unwrap();
    sources::source(root, &id).unwrap()
}
const VIDEOS: &str = "https://www.youtube.com/@TuesdayStudy/videos";
const STREAMS: &str = "https://www.youtube.com/@TuesdayStudy/streams";
const SHORTS: &str = "https://www.youtube.com/@TuesdayStudy/shorts";
fn tab(url: &str, ids: &[&str], listed: bool) -> sources::Tab {
    sources::Tab { url: url.into(), entries: ids.iter().map(|id| serde_json::json!({"id": id, "title": format!("Video {id}")})).collect(), listed }
}
fn followed_titles(root: &Path, source: &Value) -> Vec<String> {
    db::rows(&db::open(root).unwrap(), "SELECT title FROM media WHERE source_id=?1 ORDER BY title", [source["id"].as_str()]).unwrap()
        .iter().map(|r| r["title"].as_str().unwrap().to_owned()).collect()
}
#[test]
fn following_a_channel_adds_only_videos_posted_after_following() {
    let (dir, c) = fixture();
    let root = dir.path();
    let source = channel(root, &c);
    assert!(source["since"].as_i64().unwrap() > 0);
    // The first check after following only records what already exists.
    assert_eq!(sources::follow_ingest(root, &source, &[tab(VIDEOS, &["aaaaaaaaaaa", "bbbbbbbbbbb"], true)], "auto").unwrap(), 0);
    let newer = [tab(VIDEOS, &["ccccccccccc", "aaaaaaaaaaa", "bbbbbbbbbbb"], true)];
    assert_eq!(sources::follow_ingest(root, &source, &newer, "auto").unwrap(), 1);
    assert_eq!(sources::follow_ingest(root, &source, &newer, "auto").unwrap(), 0);
    assert_eq!(followed_titles(root, &source), ["Video ccccccccccc"]);
}
#[test]
fn a_check_that_could_not_list_a_channel_does_not_count_as_its_baseline() {
    let (dir, c) = fixture();
    let root = dir.path();
    let source = channel(root, &c);
    // YouTube refused (offline, sign-in wall): nothing is recorded as seen.
    assert_eq!(sources::follow_ingest(root, &source, &[tab(VIDEOS, &[], false), tab(STREAMS, &[], false)], "auto").unwrap(), 0);
    // The first listing that works is the baseline, so older videos are never added.
    let old = [tab(VIDEOS, &["aaaaaaaaaaa", "bbbbbbbbbbb"], true), tab(STREAMS, &["sssssssssss"], true)];
    assert_eq!(sources::follow_ingest(root, &source, &old, "auto").unwrap(), 0);
    assert!(followed_titles(root, &source).is_empty());
}
#[test]
fn a_tab_that_failed_once_starts_from_its_own_baseline() {
    let (dir, c) = fixture();
    let root = dir.path();
    let source = channel(root, &c);
    assert_eq!(sources::follow_ingest(root, &source, &[tab(VIDEOS, &["aaaaaaaaaaa"], true), tab(STREAMS, &[], false)], "auto").unwrap(), 0);
    // Streams list for the first time: what they hold predates the follow.
    let later = [tab(VIDEOS, &["aaaaaaaaaaa"], true), tab(STREAMS, &["sssssssssss", "ttttttttttt"], true)];
    assert_eq!(sources::follow_ingest(root, &source, &later, "auto").unwrap(), 0);
    let live = [tab(VIDEOS, &["aaaaaaaaaaa"], true), tab(STREAMS, &["uuuuuuuuuuu", "sssssssssss", "ttttttttttt"], true)];
    assert_eq!(sources::follow_ingest(root, &source, &live, "auto").unwrap(), 1);
    assert_eq!(followed_titles(root, &source), ["Video uuuuuuuuuuu"]);
}
#[test]
fn turning_on_shorts_later_does_not_add_old_shorts() {
    let (dir, c) = fixture();
    let root = dir.path();
    let mut source = channel(root, &c);
    sources::follow_ingest(root, &source, &[tab(VIDEOS, &["aaaaaaaaaaa"], true)], "auto").unwrap();
    source["include_shorts"] = serde_json::json!(1);
    let with_shorts = [tab(VIDEOS, &["aaaaaaaaaaa"], true), tab(SHORTS, &["hhhhhhhhhhh", "iiiiiiiiiii"], true)];
    assert_eq!(sources::follow_ingest(root, &source, &with_shorts, "auto").unwrap(), 0);
    let new_short = [tab(VIDEOS, &["aaaaaaaaaaa"], true), tab(SHORTS, &["jjjjjjjjjjj", "hhhhhhhhhhh", "iiiiiiiiiii"], true)];
    assert_eq!(sources::follow_ingest(root, &source, &new_short, "auto").unwrap(), 1);
}
#[test]
fn a_channel_without_a_streams_tab_adds_its_first_stream() {
    let (dir, c) = fixture();
    let root = dir.path();
    let source = channel(root, &c);
    // "This channel does not have a streams tab" lists as empty, which is a real baseline.
    sources::follow_ingest(root, &source, &[tab(VIDEOS, &["aaaaaaaaaaa"], true), tab(STREAMS, &[], true)], "auto").unwrap();
    let first_stream = [tab(VIDEOS, &["aaaaaaaaaaa"], true), tab(STREAMS, &["sssssssssss"], true)];
    assert_eq!(sources::follow_ingest(root, &source, &first_stream, "auto").unwrap(), 1);
}
#[test]
fn a_tab_is_listed_in_full_until_it_has_a_baseline_and_playlists_always() {
    assert_eq!(sources::listing_limit(VIDEOS, false), None);
    assert_eq!(sources::listing_limit(VIDEOS, true), Some(20));
    assert_eq!(sources::listing_limit(SHORTS, true), Some(20));
    assert_eq!(sources::listing_limit("https://www.youtube.com/playlist?list=PL123", true), None);
}
#[test]
fn videos_posted_before_following_are_recognised_at_download() {
    let since = 1_790_000_000; // 2026-09-21
    assert!(download::posted_before(&serde_json::json!({"timestamp": since - 10 * 86400}), since));
    assert!(!download::posted_before(&serde_json::json!({"timestamp": since + 3600}), since));
    // A day either side is allowed for time zones and premieres.
    assert!(!download::posted_before(&serde_json::json!({"timestamp": since - 3600}), since));
    assert!(download::posted_before(&serde_json::json!({"upload_date": "20260901"}), since));
    assert!(!download::posted_before(&serde_json::json!({"upload_date": "20260920"}), since));
    assert!(!download::posted_before(&serde_json::json!({}), since));
    assert!(!download::posted_before(&serde_json::json!({"upload_date": "20200101"}), 0));
}
#[test]
fn an_unwanted_download_leaves_no_trace_in_the_library() {
    let (dir, _c) = fixture();
    let root = dir.path();
    {
        let db = db::open(root).unwrap();
        db.execute("INSERT INTO media(id,title,url,status) VALUES ('old','Old video','https://www.youtube.com/watch?v=ooooooooooo','pending')", []).unwrap();
        queue::insert(&db, "old", "Old video", "download", "auto", true).unwrap();
    }
    let job: String = db::open(root).unwrap().query_row("SELECT id FROM jobs WHERE media_id='old'", [], |r| r.get(0)).unwrap();
    queue::discard(root, &job, "Skipped a video posted before following").unwrap();
    let db = db::open(root).unwrap();
    let left: i64 = db.query_row("SELECT (SELECT count(*) FROM media WHERE id='old')+(SELECT count(*) FROM jobs WHERE id=?1)+(SELECT count(*) FROM pipeline_work WHERE id=?1)", [&job], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}
#[test]
fn video_links_are_added_once_and_queued_for_download() {
    let (dir, c) = fixture();
    let root = dir.path();
    let video = links::Video {
        url: "https://www.youtube.com/watch?v=ccccccccccc".into(),
        id: "ccccccccccc".into(),
        title: "Community garden interview".into(),
        channel: "Tuesday Study".into(),
        channel_url: Some("https://www.youtube.com/@TuesdayStudy".into()),
        duration: 3151.0,
        date: "20260914".into(),
    };
    let first = links::add_videos(root, &c, std::slice::from_ref(&video), "work", true, "auto").unwrap();
    assert_eq!((first["added"].as_u64(), first["existing"].as_u64()), (Some(1), Some(0)));
    let again = links::add_videos(root, &c, &[video], "work", true, "auto").unwrap();
    assert_eq!((again["added"].as_u64(), again["existing"].as_u64()), (Some(0), Some(1)));
    let rows = db::rows(&db::open(root).unwrap(), "SELECT m.title,m.channel,m.category,m.url,p.kind FROM media m JOIN jobs j ON j.media_id=m.id JOIN pipeline_work p ON p.id=j.id WHERE m.url LIKE '%ccccccccccc'", []).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["channel"], "Tuesday Study");
    assert_eq!(rows[0]["category"], "work");
    assert_eq!(rows[0]["kind"], "download");
}
#[test]
fn a_folder_is_added_once_with_or_without_watching() {
    let (dir, c) = fixture();
    let root = dir.path();
    let folder = root.join("Interviews");
    std::fs::create_dir_all(folder.join("2025")).unwrap();
    std::fs::write(folder.join("a.m4a"), b"audio").unwrap();
    std::fs::write(folder.join("2025/b.mp4"), b"video").unwrap();
    std::fs::write(folder.join("notes.txt"), b"text").unwrap();
    let preview = sources::folder_preview(root, &folder).unwrap();
    assert_eq!((preview["name"].as_str(), preview["files"].as_u64(), preview["existing"].as_u64()), (Some("Interviews"), Some(2), Some(0)));
    let added = sources::add_folder(root, &c, &folder, false, "work", true).unwrap();
    assert_eq!(added["added"], 2);
    let source = sources::source(root, added["id"].as_str().unwrap()).unwrap();
    assert_eq!((source["enabled"].as_i64(), source["since"].as_i64()), (Some(0), Some(0)));
    let channels: Vec<String> = db::rows(&db::open(root).unwrap(), "SELECT DISTINCT channel FROM media WHERE source_id=?1", [added["id"].as_str()]).unwrap()
        .iter().map(|r| r["channel"].as_str().unwrap().to_owned()).collect();
    assert_eq!(channels, ["Interviews"]);
    let other = root.join("Sermons");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("c.wav"), b"audio").unwrap();
    let watched = sources::add_folder(root, &c, &other, true, "personal", true).unwrap();
    let source = sources::source(root, watched["id"].as_str().unwrap()).unwrap();
    assert_eq!(source["enabled"], 1);
    assert!(source["since"].as_i64().unwrap() > 0);
}
#[test]
fn followed_sources_are_checked_on_schedule_without_the_old_toggle() {
    let cfg = Config { automatic_checks: false, check_minutes: 60, ..Default::default() };
    let followed = serde_json::json!({"id": "f", "kind": "youtube", "enabled": 1, "since": 100, "last_check": 0});
    let legacy = serde_json::json!({"id": "l", "kind": "youtube", "enabled": 1, "since": 0, "last_check": 0});
    let fresh = serde_json::json!({"id": "n", "kind": "folder", "enabled": 1, "since": 100, "last_check": 10_000});
    let stopped = serde_json::json!({"id": "s", "kind": "folder", "enabled": 0, "since": 100, "last_check": 0});
    let all = [legacy.clone(), stopped, fresh, followed];
    assert_eq!(sources::due(&all, &cfg, 10_500, |_| true).as_deref(), Some("f"));
    assert_eq!(sources::due(std::slice::from_ref(&legacy), &cfg, 10_500, |_| true), None);
    let on = Config { automatic_checks: true, ..cfg };
    assert_eq!(sources::due(&[legacy], &on, 10_500, |_| true).as_deref(), Some("l"));
}
#[test]
fn library_items_carry_their_job_progress() {
    let (dir, c) = fixture();
    let root = dir.path();
    enqueue(root, &c, &Batch { ids: vec!["one".into()], ..Default::default() }, true).unwrap();
    db::open(root).unwrap().execute("UPDATE jobs SET message='45.2% · 3MiB/s · 00:20 remaining' WHERE media_id='one'", []).unwrap();
    let page = db::library(root, &db::LibraryFilter::default()).unwrap();
    let one = page["items"].as_array().unwrap().iter().find(|m| m["id"] == "one").unwrap().clone();
    assert_eq!(one["job_message"], "45.2% · 3MiB/s · 00:20 remaining");
    assert_eq!(one["job_kind"], "transcribe");
}
#[test]
fn dropped_paths_are_sorted_into_recordings_and_folders() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Interviews");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("a.m4a"), b"audio").unwrap();
    let file = dir.path().join("talk.mp3");
    std::fs::write(&file, b"audio").unwrap();
    let note = dir.path().join("notes.txt");
    std::fs::write(&note, b"text").unwrap();
    let paths = [file, folder.clone(), note].map(|p| p.to_string_lossy().into_owned());
    let found = sources::inspect_paths(&paths);
    assert_eq!(found["files"].as_array().unwrap().len(), 1);
    assert_eq!(found["folders"][0]["path"], folder.to_string_lossy().as_ref());
    assert_eq!(found["skipped"].as_array().unwrap().len(), 1);
}
#[test]
fn following_the_same_channel_twice_reuses_its_collection() {
    let (dir, c) = fixture();
    let root = dir.path();
    let first = sources::follow(root, &c, "https://www.youtube.com/@TuesdayStudy", "Tuesday Study", "personal", true, false).unwrap();
    let again = sources::follow(root, &c, "https://www.youtube.com/@TuesdayStudy/videos", "Tuesday Study", "work", true, false).unwrap();
    assert_eq!(first, again);
    let source = sources::source(root, &first).unwrap();
    assert_eq!((source["enabled"].as_i64(), source["category"].as_str()), (Some(1), Some("work")));
    assert!(source["since"].as_i64().unwrap() > 0);
    // A different channel with the same display name still gets its own collection.
    let other = sources::follow(root, &c, "https://www.youtube.com/@TuesdayStudyClips", "Tuesday Study", "personal", true, false).unwrap();
    assert_ne!(other, first);
    assert_eq!(sources::source(root, &other).unwrap()["name"], "Tuesday Study (2)");
}
#[test]
fn files_can_skip_speaker_identification() {
    let (dir, c) = fixture();
    let root = dir.path();
    let file = root.join("solo.m4a");
    std::fs::write(&file, b"fixture").unwrap();
    import_and_queue(root, &c, &[file.to_string_lossy().into_owned()], "personal", "auto", false).unwrap();
    let rows = db::rows(&db::open(root).unwrap(), "SELECT p.diarize FROM pipeline_work p JOIN jobs j ON j.id=p.id JOIN media m ON m.id=j.media_id WHERE m.path LIKE '%solo.m4a'", []).unwrap();
    assert_eq!(rows[0]["diarize"], 0);
}
/// A library last opened by 0.28 (schema 15): no follow columns, no queue state saved.
fn as_schema_15(root: &Path) {
    db::open(root)
        .unwrap()
        .execute_batch("ALTER TABLE channels DROP COLUMN since;DROP TABLE source_seen;DELETE FROM settings WHERE key='pipeline.running';PRAGMA user_version=15;")
        .unwrap();
}
#[test]
fn an_existing_library_can_follow_channels_and_watch_folders_after_upgrading() {
    let (dir, c) = fixture();
    let root = dir.path();
    as_schema_15(root);
    let id = sources::follow(root, &c, "https://www.youtube.com/@TuesdayStudy", "Tuesday Study", "personal", true, false).unwrap();
    assert!(sources::source(root, &id).unwrap()["since"].as_i64().unwrap() > 0);
    let folder = root.join("Interviews");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("elena.wav"), b"fixture").unwrap();
    let added = sources::add_folder(root, &c, &folder, true, "work", true).unwrap();
    assert_eq!(added["added"], 1);
}
#[test]
fn upgrading_keeps_old_waiting_work_paused_until_resumed() {
    let (dir, c) = fixture();
    let root = dir.path();
    queue::insert(&db::open(root).unwrap(), "one", "one", "transcribe", "auto", true).unwrap();
    as_schema_15(root);
    assert!(!queue::claim(root, 1).unwrap().is_some(), "work queued before the upgrade waits for Resume");
    action(root, &c, "start", None).unwrap();
    assert!(queue::claim(root, 2).unwrap().is_some());
}
#[test]
fn upgrading_a_library_with_automatic_checks_keeps_it_paused() {
    let (dir, _c) = fixture();
    let root = dir.path();
    let mut cfg = config(root).unwrap();
    cfg.automatic_checks = true;
    save_config(root, &cfg).unwrap();
    as_schema_15(root);
    assert!(!overview(root).unwrap()["running"].as_bool().unwrap());
}
#[test]
fn upgrading_a_quiet_library_runs_by_default() {
    let (dir, _c) = fixture();
    let root = dir.path();
    as_schema_15(root);
    assert!(overview(root).unwrap()["running"].as_bool().unwrap());
}
fn folder_source(root: &Path, c: &Control, name: &str) -> String {
    let folder = root.join(name);
    std::fs::create_dir_all(&folder).unwrap();
    sources::save(root, c, &sources::Source { id: None, name: name.into(), kind: "folder".into(), url: folder.to_string_lossy().into_owned(), enabled: true, diarize: true, include_shorts: false, category: "personal".into() }).unwrap()
}
#[test]
fn only_the_source_being_checked_is_locked_during_a_check() {
    let (dir, c) = fixture();
    let root = dir.path();
    let busy = folder_source(root, &c, "Busy");
    let other = folder_source(root, &c, "Other");
    c.checking.store(true, Ordering::SeqCst);
    db::open(root).unwrap().execute("UPDATE channels SET check_status='checking' WHERE id=?1", [&busy]).unwrap();
    // Following something new, and editing or removing another source, all go ahead.
    sources::follow(root, &c, "https://www.youtube.com/@TuesdayStudy", "Tuesday Study", "personal", true, false).unwrap();
    let mut edit = sources::Source { id: Some(other.clone()), name: "Other renamed".into(), kind: "folder".into(), url: root.join("Other").to_string_lossy().into_owned(), enabled: true, diarize: false, include_shorts: false, category: "work".into() };
    sources::save(root, &c, &edit).unwrap();
    edit.id = Some(busy.clone());
    edit.name = "Busy renamed".into();
    edit.url = root.join("Busy").to_string_lossy().into_owned();
    assert!(sources::save(root, &c, &edit).is_err(), "the source being checked waits");
    assert!(sources::remove(root, &c, &busy).is_err());
    sources::remove(root, &c, &other).unwrap();
}
#[test]
fn checking_one_source_while_another_is_checked_waits_its_turn() {
    let (dir, c) = fixture();
    let root = dir.path();
    let first = folder_source(root, &c, "First");
    let second = folder_source(root, &c, "Second");
    let c = Arc::new(c);
    c.checking.store(true, Ordering::SeqCst);
    sources::start(root.to_path_buf(), c.clone(), Some(second.clone()), false).unwrap();
    sources::start(root.to_path_buf(), c.clone(), Some(second.clone()), false).unwrap();
    assert_eq!(sources::source(root, &second).unwrap()["check_status"], "queued");
    assert!(sources::start(root.to_path_buf(), c.clone(), None, false).is_err(), "checking everything still waits for the running check");
    // When the running check finishes it takes the waiting one, once, then stops.
    assert_eq!(sources::next_waiting(&c).as_deref(), Some(second.as_str()));
    assert!(c.checking.load(Ordering::SeqCst));
    assert_eq!(sources::next_waiting(&c), None);
    assert!(!c.checking.load(Ordering::SeqCst));
    let _ = first;
}
#[test]
fn removing_a_followed_source_forgets_what_it_had_seen() {
    let (dir, c) = fixture();
    let root = dir.path();
    let source = channel(root, &c);
    sources::follow_ingest(root, &source, &[tab(VIDEOS, &["aaaaaaaaaaa"], true)], "auto").unwrap();
    sources::remove(root, &c, source["id"].as_str().unwrap()).unwrap();
    let left: i64 = db::open(root).unwrap().query_row("SELECT count(*) FROM source_seen WHERE source_id=?1", [source["id"].as_str()], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}
