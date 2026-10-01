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
