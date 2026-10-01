use super::*;
use rusqlite::params;
use serde_json::json;
use std::fs;
fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    let db = crate::db::open(root.path()).unwrap();
    db.execute_batch("INSERT INTO media(id,title,status,duration) VALUES ('m','Meeting','complete',120),('ready','Unfinished','ready',20);INSERT INTO docs(id,title,body) VALUES ('d','Document','Text'),('empty','Empty','');INSERT INTO notes(id,title,body) VALUES ('n','Research','A thought');INSERT INTO channels(id,name,diarize) VALUES ('c','Meetings',1);UPDATE media SET source_id='c' WHERE id='m';INSERT INTO assignments(media_id,local_id) VALUES ('m','S0'),('m','S1'),('ready','S0');").unwrap();
    let audio = root.path().join("meeting.ogg");
    fs::write(&audio, b"synthetic audio").unwrap();
    let md = root.path().join("meeting.md");
    fs::write(&md,"# Meeting\n- [00:01 → 00:03] **S0:** A spoken prayer.\n- [00:04 → 00:06] **S1:** Another voice.\n").unwrap();
    db.execute(
        "UPDATE media SET path=?1,transcript=?2 WHERE id='m'",
        params![audio.to_string_lossy(), md.to_string_lossy()],
    )
    .unwrap();
    root
}
#[test]
fn audit_checks_local_sources_repairs_without_changing_labels_and_counts_correctly() {
    let root = fixture();
    let p = root.path();
    let initial = report::audit(p).unwrap();
    assert!(initial["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["id"] == "stale-fts"));
    let db = crate::db::open(p).unwrap();
    db.execute_batch("INSERT INTO speakers(id,name) VALUES ('person','Alice');UPDATE assignments SET speaker_id='person' WHERE media_id='m' AND local_id='S0';").unwrap();
    assert_eq!(repair::reindex(p, "m").unwrap(), 2);
    let after = report::audit(p).unwrap();
    assert!(!after["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["id"] == "stale-fts"));
    assert_eq!(
        db.query_row(
            "SELECT speaker_id FROM assignments WHERE media_id='m' AND local_id='S0'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "person"
    );
    let status = report::snapshot(p).unwrap();
    assert_eq!(
        status["coverage"]["diarization"],
        json!({"covered":1,"total":1})
    );
    assert_eq!(status["coverage"]["documentEmbeddings"]["total"], 1);
    fs::write(p.join("meeting.md"), "This is not a timed transcript").unwrap();
    assert!(repair::reindex(p, "m").is_err());
    assert_eq!(
        db.query_row("SELECT count(*) FROM segments", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}
#[test]
fn sampled_duplicate_scan_is_stable_and_changed_files_are_not_reported_as_duplicates() {
    let root = fixture();
    let p = root.path();
    let other = p.join("copy.ogg");
    fs::copy(p.join("meeting.ogg"), &other).unwrap();
    let db = crate::db::open(p).unwrap();
    db.execute(
        "INSERT INTO media(id,title,path) VALUES ('copy','Copy',?1)",
        [other.to_string_lossy()],
    )
    .unwrap();
    repair::fingerprint(p, "m").unwrap();
    repair::fingerprint(p, "copy").unwrap();
    let audit = report::audit(p).unwrap();
    let duplicate = audit["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == "duplicates")
        .unwrap();
    assert_eq!(duplicate["count"], 2);
    fs::write(other, b"different and longer bytes").unwrap();
    let audit = report::audit(p).unwrap();
    assert!(!audit["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["id"] == "duplicates"));
    assert!(audit["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["id"] == "unhashed"));
}
#[test]
fn backup_round_trip_stages_until_restart_preserves_before_copy_and_private_config() {
    let root = fixture();
    let p = root.path();
    repair::reindex(p, "m").unwrap();
    let config = b"{\"test\":\"synthetic-private-key\"}";
    fs::write(p.join("ai-providers.json"), config).unwrap();
    let result = backup::create(p, &p.join("backups")).unwrap();
    let path = Path::new(result["path"].as_str().unwrap());
    let valid = backup::validate(path).unwrap();
    assert_eq!(valid["recordings"], 2);
    assert_eq!(valid["includesConfiguration"], true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let db = crate::db::open(p).unwrap();
    db.execute("UPDATE notes SET body='New edit' WHERE id='n'", [])
        .unwrap();
    fs::write(p.join("ai-providers.json"), b"{\"test\":\"new-key\"}").unwrap();
    backup::stage(p, path).unwrap();
    assert_eq!(
        db.query_row("SELECT body FROM notes WHERE id='n'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "New edit"
    );
    drop(db);
    let previous = backup::apply_pending(p).unwrap().unwrap();
    assert!(!p.join("restore-pending.sqlite").exists());
    assert_eq!(fs::read(p.join("ai-providers.json")).unwrap(), config);
    assert_eq!(
        crate::db::open(p)
            .unwrap()
            .query_row("SELECT body FROM notes WHERE id='n'", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "A thought"
    );
    assert_eq!(
        rusqlite::Connection::open(previous)
            .unwrap()
            .query_row("SELECT body FROM notes WHERE id='n'", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "New edit"
    );
    assert!(p.join("meeting.ogg").exists());
}
#[test]
fn backups_ignore_configuration_for_removed_features() {
    let root=fixture(); let p=root.path();
    // An old optional credential is neither included in new backups nor restored from old ones.
    fs::write(p.join("youtube-api.json"),br#"{"apiKey":"synthetic-removed-key"}"#).unwrap();
    let result=backup::create(p,&p.join("backups")).unwrap();
    let path=Path::new(result["path"].as_str().unwrap());
    let old=rusqlite::Connection::open(path).unwrap();
    assert_eq!(old.query_row("SELECT count(*) FROM concord_backup_files WHERE name='youtube-api.json'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    old.execute("INSERT INTO concord_backup_files VALUES ('youtube-api.json',?1)",[br#"{"apiKey":"synthetic-removed-key"}"#.as_slice()]).unwrap();
    drop(old);
    fs::remove_file(p.join("youtube-api.json")).unwrap();
    backup::validate(path).unwrap(); backup::stage(p,path).unwrap(); backup::apply_pending(p).unwrap();
    assert!(!p.join("youtube-api.json").exists());
}
#[test]
fn invalid_backup_does_not_stage_or_change_library() {
    let root = fixture();
    let p = root.path();
    let bad = p.join("invalid.sqlite");
    fs::write(&bad, b"not sqlite").unwrap();
    assert!(backup::stage(p, &bad).is_err());
    assert!(!p.join("restore-pending.sqlite").exists());
    assert!(backup::stage(p, &p.join("library.db")).is_err());
}
#[test]
fn failed_connection_edit_rolls_back_original() {
    use crate::research::{self, Link};
    let root = fixture();
    let db = crate::db::open(root.path()).unwrap();
    db.execute("INSERT INTO notes(id,title) VALUES ('b','Other')", [])
        .unwrap();
    let original = Link {
        source: "n".into(),
        target: "b".into(),
        kind: "same_claim".into(),
        ..Default::default()
    };
    research::link(root.path(), &original, false).unwrap();
    let invalid = Link {
        source_anchor: "deleted".into(),
        kind: "context".into(),
        ..original.clone()
    };
    assert!(research::replace_link(root.path(), &original, &invalid).is_err());
    assert_eq!(
        research::read(root.path()).unwrap()["links"][0]["kind"],
        "same_claim"
    );
}
