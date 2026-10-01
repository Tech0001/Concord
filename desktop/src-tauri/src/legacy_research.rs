//! Recover extended research data omitted by the earliest preview importer.
//! Only untouched imported notes and unchanged imported graph data are eligible.
use crate::{db, research};
use anyhow::Result;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
fn component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
fn key(a: &str, b: &str, kind: &str) -> (String, String, String) {
    if ["same_claim", "same_topic", "contradicts", "related"].contains(&kind) && a > b {
        (b.into(), a.into(), kind.into())
    } else {
        (a.into(), b.into(), kind.into())
    }
}
pub fn seed(root: &Path) -> Result<()> {
    let mut db = db::open(root)?;
    let done: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key='research.extendedImport')",
        [],
        |r| r.get(0),
    )?;
    if done {
        return Ok(());
    }
    let source: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='imported_from'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(source) = source.filter(|p| Path::new(p).is_file()) else {
        return Ok(());
    };
    let old = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let compatible: bool = old.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('clip_links') WHERE name='from_ordinal')",
        [],
        |r| r.get(0),
    )?;
    if !compatible {
        return Ok(());
    }
    let legacy_notes = db::rows(&old, "SELECT * FROM transcript_clips", [])?;
    let legacy_anchors = db::rows(&old, "SELECT * FROM note_anchors ORDER BY ordinal", [])?;
    let legacy_links = db::rows(&old, "SELECT * FROM clip_links", [])?;
    let current_links = db::rows(&db, "SELECT * FROM links", [])?;
    let old_keys: HashSet<_> = legacy_links
        .iter()
        .map(|l| {
            key(
                l["from_clip_id"].as_str().unwrap(),
                l["to_clip_id"].as_str().unwrap(),
                l["kind"].as_str().unwrap(),
            )
        })
        .collect();
    let current_keys: HashSet<_> = current_links
        .iter()
        .map(|l| {
            key(
                l["source"].as_str().unwrap(),
                l["target"].as_str().unwrap(),
                l["kind"].as_str().unwrap(),
            )
        })
        .collect();
    let graph_untouched = old_keys == current_keys
        && current_links.iter().all(|l| {
            l["note"].as_str().unwrap_or("").is_empty()
                && l["source_anchor"].as_str().unwrap_or("").is_empty()
                && l["target_anchor"].as_str().unwrap_or("").is_empty()
                && l["source_handle"].is_null()
                && l["target_handle"].is_null()
        });
    let mut eligible = HashSet::new();
    let mut anchors = HashMap::new();
    let tx = db.transaction()?;
    for old_note in legacy_notes {
        let id = old_note["id"].as_str().unwrap();
        let rows = db::rows(&tx, "SELECT * FROM notes WHERE id=?1", [id])?;
        let Some(note) = rows.first() else {
            continue;
        };
        if note["updated_at"] != note["created_at"]
            || note["title"] != old_note["title"]
            || note["body"].as_str().unwrap_or("") != old_note["note"].as_str().unwrap_or("")
            || note["quote"].as_str().unwrap_or("") != old_note["quote"].as_str().unwrap_or("")
        {
            continue;
        }
        let current = db::rows(&tx, "SELECT * FROM note_anchors WHERE note_id=?1", [id])?;
        if current.len() > 1
            || current
                .first()
                .is_some_and(|a| a["id"] != format!("{id}:original"))
        {
            continue;
        }
        let sources: Vec<_> = legacy_anchors
            .iter()
            .filter(|a| a["clip_id"] == id)
            .collect();
        // An unavailable source must never replace the evidence already imported.
        // Skip the whole note so recovery cannot leave a partial set of passages.
        let mut complete = true;
        for a in &sources {
            let (table, source) = if let Some(doc) = a["document_id"].as_str() {
                ("docs", doc.to_owned())
            } else {
                (
                    "media",
                    serde_json::to_string(&[
                        a["channel_id"].as_str().unwrap_or(""),
                        a["video_id"].as_str().unwrap_or(""),
                    ])?,
                )
            };
            let exists: bool = tx.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
                [source],
                |r| r.get(0),
            )?;
            complete &= exists;
        }
        if !complete {
            continue;
        }
        eligible.insert(id.to_owned());
        if !sources.is_empty() {
            // Retain the first anchor's old ID so later links to that passage stay valid.
            tx.execute("DELETE FROM note_anchors WHERE note_id=?1", [id])?;
            for (index, a) in sources.iter().enumerate() {
                let ordinal = a["ordinal"].as_i64().unwrap_or(index as i64);
                let aid = if index == 0 && current.len() == 1 {
                    format!("{id}:original")
                } else {
                    format!("legacy:{id}:{ordinal}")
                };
                let doc = a["document_id"].as_str();
                let media = if doc.is_none() {
                    Some(serde_json::to_string(&[
                        a["channel_id"].as_str().unwrap_or(""),
                        a["video_id"].as_str().unwrap_or(""),
                    ])?)
                } else {
                    None
                };
                tx.execute("INSERT INTO note_anchors(id,note_id,position,media_id,doc_id,start,end,quote,doc_start,doc_end) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![aid,id,index,media,doc,a["start_seconds"].as_f64(),a["end_seconds"].as_f64(),a["excerpt"].as_str().unwrap_or(""),a["doc_start_char"].as_i64(),a["doc_end_char"].as_i64()])?;
                anchors.insert((id.to_owned(), ordinal), aid);
            }
        }
        let tag_count: i64 = tx.query_row(
            "SELECT count(*) FROM note_tags WHERE note_id=?1",
            [id],
            |r| r.get(0),
        )?;
        if tag_count == 0 {
            for tag in db::rows(&old, "SELECT tag FROM clip_tags WHERE clip_id=?1", [id])? {
                tx.execute(
                    "INSERT OR IGNORE INTO note_tags VALUES(?1,?2)",
                    params![id, tag["tag"].as_str()],
                )?;
            }
        }
    }
    if graph_untouched {
        // A transaction preserves all original links if any upgraded link fails validation.
        for l in &legacy_links {
            let from = l["from_clip_id"].as_str().unwrap();
            let to = l["to_clip_id"].as_str().unwrap();
            if !eligible.contains(from) || !eligible.contains(to) {
                continue;
            }
            let original = research::Link {
                source: from.into(),
                target: to.into(),
                kind: l["kind"].as_str().unwrap().into(),
                ..Default::default()
            };
            research::link_on(&tx, &original, true)?;
        }
        for l in &legacy_links {
            let from = l["from_clip_id"].as_str().unwrap();
            let to = l["to_clip_id"].as_str().unwrap();
            if !eligible.contains(from) || !eligible.contains(to) {
                continue;
            }
            let edge = research::Link {
                source: from.into(),
                target: to.into(),
                kind: l["kind"].as_str().unwrap().into(),
                note: l["note"].as_str().unwrap_or("").into(),
                source_handle: l["from_handle"].as_str().map(str::to_owned),
                target_handle: l["to_handle"].as_str().map(str::to_owned),
                source_anchor: l["from_ordinal"]
                    .as_i64()
                    .and_then(|o| anchors.get(&(from.to_owned(), o)).cloned())
                    .unwrap_or_default(),
                target_anchor: l["to_ordinal"]
                    .as_i64()
                    .and_then(|o| anchors.get(&(to.to_owned(), o)).cloned())
                    .unwrap_or_default(),
            };
            research::link_on(&tx, &edge, false)?;
        }
    }
    let layouts = db::rows(&old, "SELECT * FROM clip_map_layouts", [])?;
    for layout in layouts {
        let raw = layout["map_key"].as_str().unwrap_or("");
        let mut parts = raw.split('|');
        let mode = match parts.next().unwrap_or("") {
            "video" => "videos",
            "clip" => "cards",
            "force" => "cluster",
            _ => continue,
        };
        let params: HashMap<_, _> = parts.filter_map(|s| s.split_once('=')).collect();
        let channel = params.get("channel").copied().unwrap_or("all");
        let channel = if channel == "all" {
            "".to_owned()
        } else {
            old.query_row("SELECT name FROM channels WHERE id=?1", [channel], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .unwrap_or_default()
        };
        let mut tags: Vec<_> = params
            .get("tags")
            .unwrap_or(&"")
            .split(',')
            .filter(|s| !s.is_empty())
            .collect();
        tags.sort();
        let query = params.get("q").unwrap_or(&"").trim().to_lowercase();
        let limit = params
            .get("limit")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(150);
        let view = serde_json::to_string(&json!([mode, query, channel, tags, limit, ""]))?;
        let node = layout["node_id"].as_str().unwrap_or("");
        let node = if let Some(rest) = node.strip_prefix("video:") {
            let Some((channel, video)) = rest.split_once(':') else {
                continue;
            };
            format!(
                "recording:{}",
                component(&serde_json::to_string(&[channel, video])?)
            )
        } else {
            if !eligible.contains(node) {
                continue;
            }
            format!("note:{}", component(node))
        };
        tx.execute("INSERT OR IGNORE INTO map_positions(view,node,x,y,width,height) VALUES (?1,?2,?3,?4,?5,?6)",params![view,node,layout["x"].as_f64(),layout["y"].as_f64(),layout["width"].as_f64(),layout["height"].as_f64()])?;
    }
    tx.execute(
        "INSERT INTO settings VALUES ('research.extendedImport','1')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("electron.db");
        Connection::open(&old).unwrap().execute_batch(r#"
          CREATE TABLE transcript_clips(id,title,note,quote);
          CREATE TABLE note_anchors(clip_id,ordinal,video_id,channel_id,start_seconds,end_seconds,excerpt,document_id,doc_start_char,doc_end_char);
          CREATE TABLE clip_tags(clip_id,tag);
          CREATE TABLE clip_links(from_clip_id,to_clip_id,kind,from_ordinal,to_ordinal,from_handle,to_handle,note);
          CREATE TABLE clip_map_layouts(map_key,node_id,x,y,width,height);
          CREATE TABLE channels(id,name);
          INSERT INTO transcript_clips VALUES ('a','First','Original body','First passage'),('b','Second','','');
          INSERT INTO note_anchors VALUES ('a',0,'v','c',1,3,'First passage',NULL,NULL,NULL),('a',2,NULL,NULL,NULL,NULL,'Document passage','d',0,8);
          INSERT INTO clip_tags VALUES ('a','faith');
          INSERT INTO clip_links VALUES ('a','b','context',2,NULL,'right','left','Supporting evidence');
          INSERT INTO clip_map_layouts VALUES ('video|channel=all|q=|tags=|limit=150','video:c:v',123,456,360,290),('clip|channel=all|q=|tags=|limit=150','a',10,20,300,200);
        "#).unwrap();
        let db = db::open(root.path()).unwrap();
        db.execute_batch(
            r#"
          INSERT INTO media(id,title,duration) VALUES ('["c","v"]','Recording',60);
          INSERT INTO docs(id,title,body) VALUES ('d','Document','Document passage');
          INSERT INTO notes(id,title,body,quote,media_id,start,end,created_at,updated_at) VALUES
            ('a','First','Original body','First passage','["c","v"]',1,3,'old','old'),
            ('b','Second','','',NULL,NULL,NULL,'old','old');
          INSERT INTO links(source,target,kind) VALUES ('a','b','context');
        "#,
        )
        .unwrap();
        research::backfill(&db).unwrap();
        db.execute(
            "INSERT INTO settings VALUES('imported_from',?1)",
            [old.to_str().unwrap()],
        )
        .unwrap();
        root
    }
    #[test]
    fn recovers_all_passages_typed_links_tags_and_layouts_once() {
        let root = fixture();
        seed(root.path()).unwrap();
        seed(root.path()).unwrap();
        let db = db::open(root.path()).unwrap();
        let anchors = db::rows(
            &db,
            "SELECT * FROM note_anchors WHERE note_id='a' ORDER BY position",
            [],
        )
        .unwrap();
        assert_eq!(anchors.len(), 2);
        assert_eq!(anchors[0]["id"], "a:original");
        assert_eq!(anchors[1]["doc_id"], "d");
        let links = db::rows(&db, "SELECT * FROM links", []).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0]["source_anchor"], anchors[1]["id"]);
        assert_eq!(links[0]["note"], "Supporting evidence");
        assert_eq!(links[0]["source_handle"], "right");
        assert_eq!(
            db.query_row("SELECT tag FROM note_tags", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "faith"
        );
        let positions = db::rows(
            &db,
            "SELECT * FROM map_positions WHERE node LIKE 'recording:%'",
            [],
        )
        .unwrap();
        assert_eq!(positions[0]["node"], "recording:%5B%22c%22%2C%22v%22%5D");
        assert_eq!(positions[0]["view"], r#"["videos","","",[],150,""]"#);
        assert_eq!(positions[0]["x"], 123.);
    }
    #[test]
    fn retains_native_edits_and_existing_layouts() {
        let root = fixture();
        let db = db::open(root.path()).unwrap();
        db.execute(
            "UPDATE notes SET body='Native edit',updated_at='new' WHERE id='a'",
            [],
        )
        .unwrap();
        seed(root.path()).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM note_anchors WHERE note_id='a'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT source_anchor FROM links", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            ""
        );
        let root = fixture();
        let db = db::open(root.path()).unwrap();
        db.execute("UPDATE links SET note='Native connection'", [])
            .unwrap();
        db.execute(
            "INSERT INTO map_positions(view,node,x,y) VALUES (?1,'note:a',987,654)",
            [r#"["cards","","",[],150,""]"#],
        )
        .unwrap();
        seed(root.path()).unwrap();
        assert_eq!(
            db.query_row("SELECT note FROM links", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Native connection"
        );
        assert_eq!(
            db.query_row("SELECT x FROM map_positions WHERE node='note:a'", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            987.
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM note_anchors WHERE note_id='a'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
    #[test]
    fn missing_sources_do_not_erase_original_evidence() {
        let root = fixture();
        let db = db::open(root.path()).unwrap();
        db.execute("DELETE FROM docs", []).unwrap();
        seed(root.path()).unwrap();
        let rows = db::rows(&db, "SELECT * FROM note_anchors WHERE note_id='a'", []).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["quote"], "First passage");
        assert_eq!(
            db.query_row("SELECT count(*) FROM links", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
