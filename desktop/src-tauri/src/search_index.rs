//! Timed passages need both fast per-recording access and a full-text index.
//! FTS5 UNINDEXED metadata cannot use a B-tree: it scanned the archive for each file.
use anyhow::Result;
use rusqlite::Connection;

pub fn migrate(db: &Connection) -> Result<()> {
    let old: String = db.query_row(
        "SELECT sql FROM sqlite_master WHERE name='segments'",
        [],
        |r| r.get(0),
    )?;
    let virtual_table = old.to_ascii_lowercase().contains("virtual table");
    let indexed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='segments_fts')",
        [],
        |r| r.get(0),
    )?;
    if virtual_table {
        db.execute_batch("ALTER TABLE segments RENAME TO segments_previous;
          CREATE TABLE segments(id INTEGER PRIMARY KEY,media_id TEXT,start REAL,end REAL,speaker TEXT,text TEXT);
          INSERT INTO segments(id,media_id,start,end,speaker,text)
            SELECT rowid,media_id,CAST(start AS REAL),CAST(end AS REAL),speaker,text FROM segments_previous;
          DROP TABLE segments_previous;")?;
    }
    db.execute_batch("CREATE INDEX IF NOT EXISTS segments_recording_time ON segments(media_id,start,id);
      CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(text,content='segments',content_rowid='id',tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS segments_insert AFTER INSERT ON segments BEGIN
        INSERT INTO segments_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS segments_delete AFTER DELETE ON segments BEGIN
        INSERT INTO segments_fts(segments_fts,rowid,text) VALUES('delete',old.id,old.text); END;
      CREATE TRIGGER IF NOT EXISTS segments_update AFTER UPDATE OF text,id ON segments BEGIN
        INSERT INTO segments_fts(segments_fts,rowid,text) VALUES('delete',old.id,old.text);
        INSERT INTO segments_fts(rowid,text) VALUES(new.id,new.text); END;")?;
    if virtual_table || !indexed {
        db.execute_batch(
            "INSERT INTO segments_fts(segments_fts) VALUES('rebuild');
          INSERT INTO segments_fts(segments_fts,rank) VALUES('integrity-check',1);",
        )?;
    }
    Ok(())
}

pub fn query(text: &str, exact: bool) -> String {
    let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    if exact {
        quote(text.trim())
    } else {
        text.split_whitespace()
            .map(quote)
            .collect::<Vec<_>>()
            .join(" AND ")
    }
}
pub fn date(value: &str) -> String {
    if value.len() == 8 && value.bytes().all(|c| c.is_ascii_digit()) {
        format!("{}-{}-{}", &value[..4], &value[4..6], &value[6..])
    } else {
        value.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires an explicitly prepared archive copy in CONCORD_TEST_ARCHIVE_ROOT"]
    fn migrate_real_archive_copy() {
        let root = std::path::PathBuf::from(
            std::env::var("CONCORD_TEST_ARCHIVE_ROOT").expect("CONCORD_TEST_ARCHIVE_ROOT"),
        );
        assert!(root.starts_with(std::env::temp_dir()));
        let started = std::time::Instant::now();
        let db = crate::db::open(&root).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
        println!("Archive migration: {:.3}s", started.elapsed().as_secs_f64());
    }
    #[test]
    fn migration_preserves_passages_and_keeps_full_text_synchronized() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE VIRTUAL TABLE segments USING fts5(media_id UNINDEXED,start UNINDEXED,end UNINDEXED,speaker UNINDEXED,text);
          INSERT INTO segments(rowid,media_id,start,end,speaker,text) VALUES(12,'one',2.5,5,'S0','A quiet harbour'),(24,'two',10,15,'S1','Prayer together');").unwrap();
        let tx = db.transaction().unwrap();
        migrate(&tx).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            db.query_row("SELECT start FROM segments WHERE id=12", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            2.5
        );
        assert_eq!(
            db.query_row(
                "SELECT rowid FROM segments_fts WHERE segments_fts MATCH 'harbour'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            12
        );
        db.execute_batch("UPDATE segments SET text='A sunny morning' WHERE id=12;DELETE FROM segments WHERE id=24;
          INSERT INTO segments(media_id,start,end,text) VALUES('one',7,8,'Welcome back');").unwrap();
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM segments_fts WHERE segments_fts MATCH 'harbour OR prayer'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM segments_fts WHERE segments_fts MATCH 'sunny OR welcome'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        migrate(&db).unwrap();
        db.execute_batch("INSERT INTO segments_fts(segments_fts,rank) VALUES('integrity-check',1)")
            .unwrap();
        let plan:String=db.query_row("EXPLAIN QUERY PLAN SELECT text FROM segments WHERE media_id='one' ORDER BY start,id",[],|r|r.get(3)).unwrap();
        assert!(plan.contains("segments_recording_time"), "{plan}");
    }
}
