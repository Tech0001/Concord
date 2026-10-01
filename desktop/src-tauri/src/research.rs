//! Research notes, evidence, tags, typed connections and persisted map layouts.
use crate::db;
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

pub const LINK_KINDS: [&str; 6] = ["same_claim","contradicts","same_topic","follow_up","context","related"];
pub fn migrate(db: &Connection) -> Result<()> {
    let has_updated: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name='updated_at')",[],|r|r.get(0))?;
    if !has_updated { db.execute_batch("ALTER TABLE notes ADD COLUMN updated_at TEXT; UPDATE notes SET updated_at=created_at;")?; }
    db.execute_batch("CREATE TABLE IF NOT EXISTS note_anchors (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, media_id TEXT REFERENCES media(id), doc_id TEXT REFERENCES docs(id),
      start REAL, end REAL, quote TEXT NOT NULL DEFAULT '', doc_start INTEGER, doc_end INTEGER);
      CREATE INDEX IF NOT EXISTS note_anchors_media ON note_anchors(media_id,start);
      CREATE INDEX IF NOT EXISTS note_anchors_note ON note_anchors(note_id,position);
      CREATE TABLE IF NOT EXISTS note_tags(note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(note_id,tag));
      CREATE INDEX IF NOT EXISTS note_tags_tag ON note_tags(tag);
      CREATE TABLE IF NOT EXISTS map_positions(view TEXT NOT NULL,node TEXT NOT NULL,x REAL NOT NULL,y REAL NOT NULL,width REAL,height REAL,PRIMARY KEY(view,node));")?;
    let has_anchors:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('links') WHERE name='source_anchor')",[],|r|r.get(0))?;
    if !has_anchors {
        db.execute_batch("ALTER TABLE links RENAME TO links_v3;
          CREATE TABLE links (source TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,source_anchor TEXT NOT NULL DEFAULT '',target_anchor TEXT NOT NULL DEFAULT '',
            source_handle TEXT,target_handle TEXT,note TEXT NOT NULL DEFAULT '',PRIMARY KEY(source,target,kind,source_anchor,target_anchor));
          INSERT OR IGNORE INTO links(source,target,kind)
            SELECT CASE WHEN kind IN ('same_claim','same_topic','contradicts','related') AND source>target THEN target ELSE source END,
                   CASE WHEN kind IN ('same_claim','same_topic','contradicts','related') AND source>target THEN source ELSE target END,kind FROM links_v3;
          DROP TABLE links_v3;")?;
    }
    backfill(db)
}
pub fn backfill(db:&Connection)->Result<()> {
    db.execute_batch("INSERT OR IGNORE INTO note_anchors(id,note_id,position,media_id,start,end,quote)
      SELECT id||':original',id,0,media_id,start,end,quote FROM notes n WHERE media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM note_anchors a WHERE a.note_id=n.id);")?;
    Ok(())
}

pub fn read(root:&Path)->Result<Value> {
    let db=db::open(root)?;
    let mut notes=db::rows(&db,"SELECT n.*,m.title AS media_title FROM notes n LEFT JOIN media m ON m.id=n.media_id ORDER BY coalesce(n.updated_at,n.created_at) DESC",[])?;
    let anchors=db::rows(&db,"SELECT a.*,coalesce(m.title,d.title) AS title,m.channel,m.date FROM note_anchors a LEFT JOIN media m ON m.id=a.media_id LEFT JOIN docs d ON d.id=a.doc_id ORDER BY a.position",[])?;
    let tags=db::rows(&db,"SELECT * FROM note_tags ORDER BY tag",[])?;
    let mut by_note:HashMap<String,Vec<Value>>=HashMap::new();
    let mut tags_by_note:HashMap<String,Vec<Value>>=HashMap::new();
    for a in anchors { by_note.entry(a["note_id"].as_str().unwrap().to_owned()).or_default().push(a); }
    for t in tags { tags_by_note.entry(t["note_id"].as_str().unwrap().to_owned()).or_default().push(t["tag"].clone()); }
    for n in &mut notes {
        let id=n["id"].as_str().unwrap().to_owned();
        n["anchors"]=json!(by_note.remove(&id).unwrap_or_default());
        n["tags"]=json!(tags_by_note.remove(&id).unwrap_or_default());
    }
    Ok(json!({"notes":notes,"links":db::rows(&db,"SELECT * FROM links",[])?,"tags":db::rows(&db,"SELECT tag,count(*) AS count FROM note_tags GROUP BY tag ORDER BY count DESC,tag",[])?,"docs":db::rows(&db,"SELECT id,title,length(body) AS length FROM docs ORDER BY title",[])?,"positions":db::rows(&db,"SELECT * FROM map_positions",[])?}))
}

#[derive(Default,Deserialize,Serialize,Clone)]
#[serde(default)]
pub struct Anchor {
    pub id:Option<String>, pub media_id:Option<String>,pub doc_id:Option<String>,
    pub start:Option<f64>,pub end:Option<f64>,pub quote:String,pub doc_start:Option<i64>,pub doc_end:Option<i64>,
}
#[derive(Default,Deserialize)]
#[serde(default)]
pub struct Note {
    pub id:Option<String>,pub title:String,pub body:String,pub quote:String,
    pub media_id:Option<String>,pub start:Option<f64>,pub end:Option<f64>,
    pub anchors:Option<Vec<Anchor>>,pub tags:Option<Vec<String>>,
}
fn normalize_tag(tag:&str)->String { tag.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase() }
fn validate_anchor(db:&Connection,a:&Anchor)->Result<()> {
    anyhow::ensure!(a.media_id.is_some() != a.doc_id.is_some(),"Evidence must refer to one recording or document");
    if let Some(id)=&a.media_id {
        let duration:f64=db.query_row("SELECT duration FROM media WHERE id=?1",[id],|r|r.get(0)).context("Evidence recording not found")?;
        let start=a.start.context("Choose a start time")?; let end=a.end.unwrap_or(start);
        anyhow::ensure!(start.is_finite()&&end.is_finite()&&start>=0.&&end>=start,"Invalid evidence time range");
        anyhow::ensure!(duration<=0. || end<=duration+0.5,"Evidence ends beyond this recording");
    } else {
        let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM docs WHERE id=?1)",[&a.doc_id],|r|r.get(0))?;
        anyhow::ensure!(exists,"Evidence document not found");
        if let (Some(s),Some(e))=(a.doc_start,a.doc_end) { anyhow::ensure!(s>=0&&e>=s,"Invalid document passage"); }
    }
    Ok(())
}
pub fn save(root:&Path,n:&Note)->Result<String> {
    anyhow::ensure!(!n.title.trim().is_empty(),"Give the note a title");
    anyhow::ensure!(n.title.chars().count()<=500&&n.body.len()<=2_000_000,"Note is too large");
    let id=n.id.clone().unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    let mut db=db::open(root)?; let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1)",[&id],|r|r.get(0))?;
    let anchors=n.anchors.clone().or_else(|| (!exists).then(|| n.media_id.as_ref().map(|_|vec![Anchor{media_id:n.media_id.clone(),start:n.start,end:n.end,quote:n.quote.clone(),..Default::default()}]).unwrap_or_default()));
    if let Some(anchors)=&anchors {
        anyhow::ensure!(anchors.len()<=1000,"A note can contain at most 1,000 evidence passages");
        for a in anchors { validate_anchor(&tx,a)?; }
    }
    tx.execute("INSERT INTO notes(id,title,body,updated_at) VALUES (?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at",params![id,n.title.trim(),n.body])?;
    if let Some(anchors)=&anchors {
        // Stable IDs keep map connections attached when passages are reordered.
        let previous:Vec<String>={let mut q=tx.prepare("SELECT id FROM note_anchors WHERE note_id=?1")?;let r=q.query_map([&id],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;r};
        tx.execute("DELETE FROM note_anchors WHERE note_id=?1",[&id])?;
        for (position,a) in anchors.iter().enumerate() {
            let aid=a.id.clone().filter(|a|previous.contains(a)).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
            tx.execute("INSERT INTO note_anchors(id,note_id,position,media_id,doc_id,start,end,quote,doc_start,doc_end) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![aid,id,position,a.media_id,a.doc_id,a.start,a.end,a.quote,a.doc_start,a.doc_end])?;
        }
        // A removed passage's explicit links are removed too; ordinary note links survive.
        tx.execute("DELETE FROM links WHERE (source=?1 AND source_anchor<>'' AND source_anchor NOT IN (SELECT id FROM note_anchors WHERE note_id=?1)) OR (target=?1 AND target_anchor<>'' AND target_anchor NOT IN (SELECT id FROM note_anchors WHERE note_id=?1))",[&id])?;
        let first=anchors.first();
        tx.execute("UPDATE notes SET media_id=?1,start=?2,end=?3,quote=?4 WHERE id=?5",params![first.and_then(|a|a.media_id.as_deref()),first.and_then(|a|a.start),first.and_then(|a|a.end),first.map(|a|a.quote.as_str()).unwrap_or(""),id])?;
    }
    if let Some(tags)=&n.tags {
        anyhow::ensure!(tags.len()<=100,"Choose at most 100 tags");
        tx.execute("DELETE FROM note_tags WHERE note_id=?1",[&id])?;
        for tag in tags {
            let tag=normalize_tag(tag);if tag.is_empty(){continue;}
            anyhow::ensure!(tag.chars().count()<=100,"Tags must be at most 100 characters");
            tx.execute("INSERT OR IGNORE INTO note_tags(note_id,tag) VALUES (?1,?2)",params![id,tag])?;
        }
    }
    tx.commit()?;Ok(id)
}
pub fn delete(root:&Path,id:&str)->Result<()> {
    let mut db=db::open(root)?;let tx=db.transaction()?;
    tx.execute("DELETE FROM links WHERE source=?1 OR target=?1",[id])?;
    tx.execute("DELETE FROM notes WHERE id=?1",[id])?;
    tx.execute("DELETE FROM map_positions WHERE node=?1",[id])?;
    tx.commit()?;Ok(())
}
#[derive(Default,Deserialize,Serialize,Clone)]
#[serde(default)]
pub struct Link {
    pub source:String,pub target:String,pub kind:String,pub note:String,
    pub source_anchor:String,pub target_anchor:String,pub source_handle:Option<String>,pub target_handle:Option<String>,
}
pub fn link(root:&Path,input:&Link,remove:bool)->Result<()> {
    link_on(&db::open(root)?,input,remove)
}
pub fn replace_link(root:&Path,previous:&Link,next:&Link)->Result<()> {
    let mut db=db::open(root)?;let tx=db.transaction()?;
    link_on(&tx,previous,true)?;
    link_on(&tx,next,false)?;
    tx.commit()?;Ok(())
}
fn link_on(db:&Connection,input:&Link,remove:bool)->Result<()> {
    anyhow::ensure!(input.source!=input.target,"Choose a different note");
    anyhow::ensure!(LINK_KINDS.contains(&input.kind.as_str()),"Unknown connection type");
    let mut v=input.clone();
    if ["same_claim","contradicts","same_topic","related"].contains(&v.kind.as_str()) && v.source>v.target {
        std::mem::swap(&mut v.source,&mut v.target);std::mem::swap(&mut v.source_anchor,&mut v.target_anchor);std::mem::swap(&mut v.source_handle,&mut v.target_handle);
    }
    if remove {
        db.execute("DELETE FROM links WHERE source=?1 AND target=?2 AND kind=?3 AND source_anchor=?4 AND target_anchor=?5",params![v.source,v.target,v.kind,v.source_anchor,v.target_anchor])?;
        return Ok(());
    }
    for (note,anchor,handle) in [(&v.source,&v.source_anchor,&v.source_handle),(&v.target,&v.target_anchor,&v.target_handle)] {
        if !anchor.is_empty() {
            let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM note_anchors WHERE id=?1 AND note_id=?2)",params![anchor,note],|r|r.get(0))?;
            anyhow::ensure!(exists,"Evidence passage no longer exists");
        }
        if let Some(handle)=handle { anyhow::ensure!(["left","right","top","bottom"].contains(&handle.as_str()),"Unknown connection handle"); }
    }
    db.execute("INSERT INTO links(source,target,kind,source_anchor,target_anchor,source_handle,target_handle,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(source,target,kind,source_anchor,target_anchor) DO UPDATE SET source_handle=excluded.source_handle,target_handle=excluded.target_handle,note=excluded.note",params![v.source,v.target,v.kind,v.source_anchor,v.target_anchor,v.source_handle,v.target_handle,v.note])?;
    Ok(())
}
pub fn rename_tag(root:&Path,from:&str,to:Option<&str>,descendants:bool)->Result<usize> {
    let from=normalize_tag(from);anyhow::ensure!(!from.is_empty(),"Choose a tag");
    let to=to.map(normalize_tag);if let Some(to)=&to { anyhow::ensure!(!to.is_empty()&&to.chars().count()<=100,"Enter a valid tag"); }
    let mut db=db::open(root)?;let tx=db.transaction()?;
    let rows=db::rows(&tx,"SELECT note_id,tag FROM note_tags",[])?;
    let affected:Vec<_>=rows.into_iter().filter(|row| {
        let old=row["tag"].as_str().unwrap();old==from || (descendants&&old.starts_with(&format!("{from}.")))
    }).collect();
    if to.as_deref()==Some(from.as_str()) {return Ok(0);}
    for row in &affected {tx.execute("DELETE FROM note_tags WHERE note_id=?1 AND tag=?2",params![row["note_id"].as_str(),row["tag"].as_str()])?;}
    if let Some(to)=&to {
        for row in &affected {
            let old=row["tag"].as_str().unwrap();let next=format!("{to}{}",&old[from.len()..]);
            anyhow::ensure!(next.chars().count()<=100,"Renamed tag exceeds 100 characters");
            tx.execute("INSERT OR IGNORE INTO note_tags(note_id,tag) VALUES (?1,?2)",params![row["note_id"].as_str(),next])?;
        }
    }
    tx.commit()?;Ok(affected.len())
}

pub fn layout(root:&Path,view:&str,nodes:&[Value])->Result<()> {
    anyhow::ensure!(!view.is_empty()&&view.len()<=4096&&nodes.len()<=10_000,"Invalid map layout");
    let mut db=db::open(root)?;let tx=db.transaction()?;
    for n in nodes {
        let id=n["node"].as_str().context("Missing node ID")?;
        let x=n["x"].as_f64().context("Missing position")?;let y=n["y"].as_f64().context("Missing position")?;
        anyhow::ensure!(x.is_finite()&&y.is_finite()&&x.abs()<1e7&&y.abs()<1e7,"Invalid map position");
        tx.execute("INSERT INTO map_positions(view,node,x,y,width,height) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(view,node) DO UPDATE SET x=excluded.x,y=excluded.y,width=excluded.width,height=excluded.height",params![view,id,x,y,n["width"].as_f64(),n["height"].as_f64()])?;
    }
    tx.commit()?;Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->tempfile::TempDir {
        let root=tempfile::tempdir().unwrap();db::open(root.path()).unwrap().execute_batch("INSERT INTO media(id,title,duration) VALUES ('m','Meeting',120); INSERT INTO docs(id,title,body) VALUES ('d','Document','A source passage.');").unwrap();root
    }
    fn note()->Note {Note{title:"Research".into(),body:"A thought".into(),anchors:Some(vec![Anchor{media_id:Some("m".into()),start:Some(10.),end:Some(20.),quote:"Spoken words".into(),..Default::default()},Anchor{doc_id:Some("d".into()),quote:"A source passage.".into(),..Default::default()}]),tags:Some(vec![" Faith ".into(),"faith".into(),"history.rome".into()]),..Default::default()}}
    #[test]
    fn multi_source_notes_preserve_evidence_and_validate_atomically() {
        let root=fixture();let id=save(root.path(),&note()).unwrap();
        let data=read(root.path()).unwrap();let n=&data["notes"][0];
        assert_eq!(n["anchors"].as_array().unwrap().len(),2);assert_eq!(n["tags"].as_array().unwrap().len(),2);
        save(root.path(),&Note{id:Some(id.clone()),title:"Edited".into(),body:"New thought".into(),..Default::default()}).unwrap();
        assert_eq!(read(root.path()).unwrap()["notes"][0]["anchors"].as_array().unwrap().len(),2);
        let mut bad=note();bad.id=Some(id.clone());bad.anchors.as_mut().unwrap()[0].end=Some(500.);
        assert!(save(root.path(),&bad).is_err());assert_eq!(read(root.path()).unwrap()["notes"][0]["title"],"Edited");
        assert_eq!(db::transcript(root.path(),"m").unwrap()["notes"].as_array().unwrap().len(),1);
        delete(root.path(),&id).unwrap();assert!(read(root.path()).unwrap()["notes"].as_array().unwrap().is_empty());
        let db=db::open(root.path()).unwrap();assert_eq!(db.query_row("SELECT count(*) FROM note_anchors",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(db.query_row("SELECT count(*) FROM docs",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn tag_rename_handles_collisions_and_overlapping_hierarchies() {
        let root=fixture();let mut n=note();n.tags=Some(vec!["topic".into(),"topic.child".into(),"other".into()]);let id=save(root.path(),&n).unwrap();
        assert_eq!(rename_tag(root.path(),"topic",Some("topic.child"),true).unwrap(),2);
        let data=read(root.path()).unwrap();assert_eq!(data["notes"][0]["tags"],json!(["other","topic.child","topic.child.child"]));
        rename_tag(root.path(),"topic.child",Some("other"),false).unwrap();
        assert_eq!(read(root.path()).unwrap()["notes"][0]["tags"],json!(["other","topic.child.child"]));
        rename_tag(root.path(),"other",None,false).unwrap();
        assert_eq!(read(root.path()).unwrap()["notes"][0]["id"],id);
    }
    #[test]
    fn links_are_typed_symmetric_and_keep_stable_anchor_ids() {
        let root=fixture();let a=save(root.path(),&note()).unwrap();let b=save(root.path(),&Note{title:"Other".into(),..Default::default()}).unwrap();
        let data=read(root.path()).unwrap();let original=data["notes"].as_array().unwrap().iter().find(|n|n["id"]==a).unwrap();
        let mut n:Note=serde_json::from_value(original.clone()).unwrap();let aid=n.anchors.as_ref().unwrap()[0].id.clone().unwrap();
        let edge=Link{source:a.clone(),target:b.clone(),kind:"same_claim".into(),source_anchor:aid.clone(),..Default::default()};
        link(root.path(),&edge,false).unwrap();
        n.anchors.as_mut().unwrap().reverse();save(root.path(),&n).unwrap();
        assert_eq!(read(root.path()).unwrap()["links"].as_array().unwrap().len(),1);
        let reverse=Link{source:b.clone(),target:a.clone(),target_anchor:aid,kind:"same_claim".into(),..Default::default()};
        link(root.path(),&reverse,true).unwrap();assert!(read(root.path()).unwrap()["links"].as_array().unwrap().is_empty());
        assert!(link(root.path(),&Link{source:a.clone(),target:a.clone(),kind:"context".into(),..Default::default()},false).is_err());
        link(root.path(),&edge,false).unwrap();n.anchors=Some(vec![]);save(root.path(),&n).unwrap();
        assert!(read(root.path()).unwrap()["links"].as_array().unwrap().is_empty());
        assert!(db::transcript(root.path(),"m").unwrap()["notes"].as_array().unwrap().is_empty());
    }
}
