use super::*;
#[test]
fn live_sync_preserves_identity_notes_stars_and_invalidates_only_changed_vectors() {
    let root = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let control = Control::default();
    fs::create_dir(files.path().join("nested")).unwrap();
    let path = files.path().join("nested/first.md");
    fs::write(
        &path,
        "---\ntitle: Test source\nauthor: Alice\n---\n# Heading\nA first passage",
    )
    .unwrap();
    let folder = add_root(
        root.path(),
        &control,
        files.path().to_str().unwrap(),
        "Research",
    )
    .unwrap();
    assert_eq!(sync(root.path(), &control, false).unwrap().added, 1);
    let snap = snapshot(root.path()).unwrap();
    let id = snap["docs"][0]["id"].as_str().unwrap();
    assert_eq!(snap["docs"][0]["relative"], "nested/first.md");
    assert_eq!(snap["docs"][0]["title"], "Test source");
    edit(root.path(), id, Some(true), Some("work")).unwrap();
    let db = db::open(root.path()).unwrap();
    db.execute("INSERT INTO speakers(id,name) VALUES ('alice','Alice')", [])
        .unwrap();
    assert_eq!(read(root.path(), id).unwrap()["speaker_id"], "alice");
    let note = crate::research::save(
        root.path(),
        &crate::research::Note {
            title: "Evidence".into(),
            anchors: Some(vec![crate::research::Anchor {
                doc_id: Some(id.into()),
                quote: "A first passage".into(),
                ..Default::default()
            }]),
            ..Default::default()
        },
    )
    .unwrap();
    db.execute("INSERT INTO ai_indexes VALUES ('test','fixture',2)", [])
        .unwrap();
    db.execute("INSERT INTO ai_sources(signature,kind,source_id,digest) VALUES('test','document',?1,'old')",[id]).unwrap();
    assert_eq!(sync(root.path(), &control, false).unwrap().unchanged, 1);
    assert_eq!(sync(root.path(), &control, true).unwrap().unchanged, 1);
    assert_eq!(
        db.query_row("SELECT count(*) FROM ai_sources", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    fs::write(&path, "# New title\nReplacement passage").unwrap();
    assert_eq!(sync(root.path(), &control, true).unwrap().updated, 1);
    let doc = read(root.path(), id).unwrap();
    assert_eq!(doc["title"], "New title");
    assert_eq!(doc["starred"], 1);
    assert_eq!(doc["category"], "work");
    assert_eq!(doc["notes"][0]["id"], note);
    assert_eq!(
        db.query_row("SELECT count(*) FROM ai_sources", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(sync(root.path(), &control, true).unwrap().missing, 1);
    let doc = read(root.path(), id).unwrap();
    assert_eq!(doc["missing"], 1);
    assert!(doc["body"].as_str().unwrap().contains("Replacement"));
    assert_eq!(doc["notes"][0]["id"], note);
    fs::write(&path, "# Restored\nSource is back").unwrap();
    sync(root.path(), &control, true).unwrap();
    assert_eq!(read(root.path(), id).unwrap()["missing"], 0);
    edit_root(
        root.path(),
        &control,
        folder["id"].as_str().unwrap(),
        None,
        None,
        true,
    )
    .unwrap();
    assert!(snapshot(root.path()).unwrap()["roots"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(path.exists());
    assert_eq!(read(root.path(), id).unwrap()["notes"][0]["id"], note);
    add_root(root.path(), &control, files.path().to_str().unwrap(), "").unwrap();
    sync(root.path(), &control, true).unwrap();
    assert_eq!(
        snapshot(root.path()).unwrap()["docs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn disconnected_folders_and_invalid_text_keep_cached_evidence() {
    let root = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let control = Control::default();
    let path = files.path().join("good.md");
    fs::write(&path, "# Original\nDo not lose this").unwrap();
    add_root(root.path(), &control, files.path().to_str().unwrap(), "").unwrap();
    sync(root.path(), &control, false).unwrap();
    let snap = snapshot(root.path()).unwrap();
    let id = snap["docs"][0]["id"].as_str().unwrap();
    fs::write(&path, [0xff, 0xfe]).unwrap();
    let result = sync(root.path(), &control, true).unwrap();
    assert_eq!(result.errors.len(), 1);
    assert_eq!(read(root.path(), id).unwrap()["title"], "Original");
    fs::remove_file(&path).unwrap();
    fs::remove_dir(files.path()).unwrap();
    let result = sync(root.path(), &control, true).unwrap();
    assert!(!result.errors.is_empty());
    assert_eq!(read(root.path(), id).unwrap()["missing"], 0);
    assert_eq!(
        snapshot(root.path()).unwrap()["roots"][0]["connected"],
        false
    );
}
#[test]
fn import_is_idempotent_and_root_links_cannot_escape_or_follow_symlinks() {
    let root = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let control = Control::default();
    let path = files.path().join("a.md");
    fs::write(&path, "# A").unwrap();
    let p = path.to_string_lossy().into_owned();
    import(root.path(), &control, std::slice::from_ref(&p)).unwrap();
    import(root.path(), &control, &[p]).unwrap();
    assert_eq!(
        snapshot(root.path()).unwrap()["docs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    add_root(root.path(), &control, files.path().to_str().unwrap(), "").unwrap();
    assert!(add_root(root.path(), &control, files.path().to_str().unwrap(), "").is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.path(), files.path().join("escape")).unwrap();
    }
    sync(root.path(), &control, false).unwrap();
    let snap = snapshot(root.path()).unwrap();
    assert_eq!(snap["docs"].as_array().unwrap().len(), 1);
    let id = snap["docs"][0]["id"].as_str().unwrap();
    assert_eq!(resolve(root.path(), id, "a.md").unwrap(), path);
    assert!(resolve(
        root.path(),
        id,
        root.path().join("library.db").to_str().unwrap()
    )
    .is_err());
    #[cfg(unix)]
    {
        assert!(resolve(root.path(), id, "escape/library.db").is_err());
    }
}

#[test]
fn older_null_root_ids_recover_the_original_folder_without_duplication() {
    let root = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let path = files.path().join("source.md");
    fs::write(&path, "# Source\nEvidence").unwrap();
    let oldpath = root.path().join("electron.db");
    let old = Connection::open(&oldpath).unwrap();
    old.execute_batch("CREATE TABLE documents(id,root_id,rel_path); CREATE TABLE app_config(key,value); INSERT INTO documents VALUES('old',NULL,'source.md');").unwrap();
    old.execute(
        "INSERT INTO app_config VALUES('docs.rootFolders',?1)",
        [json!([{"id":"","label":"Old research","path":files.path()}]).to_string()],
    )
    .unwrap();
    let db = db::open(root.path()).unwrap();
    db.execute(
        "INSERT INTO docs(id,title,body,category) VALUES('old','Source','Cached evidence','work')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO settings VALUES('imported_from',?1)",
        [oldpath.to_str().unwrap()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO document_roots(id,path) VALUES('',?1)",
        [files.path().to_str().unwrap()],
    )
    .unwrap();
    seed_legacy(root.path()).unwrap();
    seed_legacy(root.path()).unwrap();
    sync(root.path(), &Control::default(), true).unwrap();
    let state = snapshot(root.path()).unwrap();
    assert_eq!(state["docs"].as_array().unwrap().len(), 1);
    assert_eq!(state["docs"][0]["id"], "old");
    assert_eq!(state["docs"][0]["category"], "work");
    assert_eq!(state["roots"][0]["label"], "Old research");
}

#[test]
fn imported_document_category_is_set_once_and_kept_on_reimport() {
    let root=tempfile::tempdir().unwrap();let control=Control::default();
    let path=root.path().join("category.md");std::fs::write(&path,"# Work document\nResearch").unwrap();
    let paths=vec![path.to_string_lossy().into_owned()];
    import_in_category(root.path(),&control,&paths,"work").unwrap();
    import_in_category(root.path(),&control,&paths,"personal").unwrap();
    let data=snapshot(root.path()).unwrap();assert_eq!(data["docs"].as_array().unwrap().len(),1);assert_eq!(data["docs"][0]["category"],"work");
}
