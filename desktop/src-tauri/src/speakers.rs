//! Saved identities and local voice fingerprints. Manual labels always win over matching.
use crate::{db, transcript};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub const MATCH_THRESHOLD: f64 = 0.45;
pub fn floats(blob: &[u8]) -> Vec<f32> {
    if !blob.len().is_multiple_of(4) { return vec![]; }
    blob.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
}
fn normalized(mut values: Vec<f32>) -> Option<Vec<f32>> {
    let norm = values.iter().map(|v| (*v as f64).powi(2)).sum::<f64>().sqrt();
    if values.is_empty() || !norm.is_finite() || norm <= f64::EPSILON { return None; }
    values.iter_mut().for_each(|v| *v = (*v as f64 / norm) as f32);
    Some(values)
}
fn bytes(values: &[f32]) -> Vec<u8> { values.iter().flat_map(|v| v.to_le_bytes()).collect() }
fn require(db: &Connection, id: &str) -> Result<()> {
    anyhow::ensure!(db.query_row("SELECT EXISTS(SELECT 1 FROM speakers WHERE id=?1)", [id], |r| r.get::<_, bool>(0))?, "Speaker not found");
    Ok(())
}
fn validate_name(name: &str) -> Result<&str> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty() && name.chars().count() <= 200, "Enter a name of 1–200 characters");
    Ok(name)
}
fn validate_color(color: Option<&str>) -> Result<()> {
    if let Some(c) = color {
        anyhow::ensure!(c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|c| c.is_ascii_hexdigit()), "Choose a valid speaker color");
    }
    Ok(())
}

pub fn edit(root: &Path, id: &str, name: &str, color: Option<&str>, noise: bool) -> Result<()> {
    let name = validate_name(name)?;
    validate_color(color)?;
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM speakers WHERE lower(name)=lower(?1) AND id<>?2)", params![name,id], |r| r.get(0))?;
    anyhow::ensure!(!duplicate, "Another speaker already has that name. Merge the profiles instead.");
    require(&tx, id)?;
    tx.execute("UPDATE speakers SET name=?1,color=?2,is_noise=?3 WHERE id=?4", params![name,color,noise,id])?;
    tx.commit()?;
    Ok(())
}

pub fn unidentified(root: &Path) -> Result<Vec<Value>> {
    db::rows(&db::open(root)?, "SELECT a.media_id,a.local_id,a.airtime,a.start,a.end,m.title,m.channel,m.date,m.duration FROM assignments a JOIN media m ON m.id=a.media_id WHERE a.speaker_id IS NULL ORDER BY a.airtime DESC,m.date DESC", [])
}

fn add_print(db: &Connection, id: &str, sample: &[u8], weight: i64) -> Result<()> {
    let Some(sample) = normalized(floats(sample)) else { return Ok(()); };
    let (old, count): (Option<Vec<u8>>, i64) = db.query_row("SELECT embedding,sample_count FROM speakers WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?)))?;
    let prior = old.as_deref().and_then(|b| normalized(floats(b)));
    let (values, total) = match prior {
        Some(prior) if prior.len() == sample.len() => {
            let n = count.max(1);
            let total = n + weight;
            let sum = prior.iter().zip(&sample).map(|(a,b)| ((*a as f64 * n as f64 + *b as f64 * weight as f64) / total as f64) as f32).collect();
            (normalized(sum).context("Voice samples cancel each other out")?, total)
        }
        Some(_) => anyhow::bail!("These voice fingerprints use different models; re-transcribe before combining them"),
        None => (sample, weight),
    };
    db.execute("UPDATE speakers SET embedding=?1,sample_count=?2 WHERE id=?3", params![bytes(&values),total,id])?;
    Ok(())
}

pub fn match_unidentified(db: &Connection, only: Option<&str>) -> Result<Value> {
    if let Some(id) = only { require(db, id)?; }
    let profiles = {
        let mut q = db.prepare("SELECT id,embedding FROM speakers WHERE embedding IS NOT NULL AND (?1 IS NULL OR id=?1) ORDER BY id")?;
        let result = q.query_map([only], |r| Ok((r.get::<_,String>(0)?, floats(&r.get::<_,Vec<u8>>(1)?))))?.collect::<rusqlite::Result<Vec<_>>>()?;
        result
    };
    let candidates = {
        let mut q = db.prepare("SELECT media_id,local_id,centroid FROM assignments WHERE speaker_id IS NULL AND centroid IS NOT NULL")?;
        let result = q.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,floats(&r.get::<_,Vec<u8>>(2)?))))?.collect::<rusqlite::Result<Vec<_>>>()?;
        result
    };
    let mut matched = 0;
    let mut recordings = std::collections::HashSet::new();
    for (media, local, centroid) in candidates {
        let best = profiles.iter().map(|(id,p)| (id,transcript::cosine(&centroid,p)))
            .filter(|(_,s)| s.is_finite() && *s >= MATCH_THRESHOLD)
            .max_by(|a,b| a.1.total_cmp(&b.1));
        if let Some((id,score)) = best {
            matched += db.execute("UPDATE assignments SET speaker_id=?1,confidence=?2 WHERE media_id=?3 AND local_id=?4 AND speaker_id IS NULL", params![id,score,media,local])?;
            recordings.insert(media);
        }
    }
    Ok(json!({"matched":matched,"recordings":recordings.len()}))
}
pub fn rescan(root: &Path, only: Option<&str>) -> Result<Value> {
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let result = match_unidentified(&tx,only)?;
    tx.commit()?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Label {
    pub media_id: String,
    pub locals: Vec<String>,
    pub speaker_id: Option<String>,
    pub name: Option<String>,
    pub color: Option<String>,
    #[serde(default)] pub noise: bool,
    #[serde(default)] pub unlink: bool,
}
pub fn label(root: &Path, input: &Label) -> Result<Value> {
    anyhow::ensure!(!input.locals.is_empty(), "Choose a voice to label");
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let id = if input.unlink { None } else if let Some(id) = &input.speaker_id {
        require(&tx,id)?; Some(id.clone())
    } else {
        let name = if input.noise { "(noise)" } else { validate_name(input.name.as_deref().unwrap_or_default())? };
        validate_color(input.color.as_deref())?;
        let known: Option<String> = tx.query_row("SELECT id FROM speakers WHERE lower(name)=lower(?1)", [name], |r| r.get(0)).optional()?;
        Some(match known {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute("INSERT INTO speakers(id,name,color,is_noise,sample_count) VALUES (?1,?2,?3,?4,0)", params![id,name,input.color,input.noise])?;
                id
            }
        })
    };
    let locals: std::collections::BTreeSet<_> = input.locals.iter().collect();
    for local in locals {
        let centroid: Option<Vec<u8>> = tx.query_row("SELECT centroid FROM assignments WHERE media_id=?1 AND local_id=?2", params![input.media_id,local], |r| r.get(0)).context("Voice not found")?;
        if let (Some(id),Some(centroid)) = (&id,&centroid) {
            // A repeated Save or unlink/relabel must not teach the same sample twice.
            let added = tx.execute("INSERT OR IGNORE INTO speaker_training(speaker_id,media_id,local_id) VALUES (?1,?2,?3)", params![id,input.media_id,local])?;
            if added > 0 { add_print(&tx,id,centroid,1)?; }
        }
        tx.execute("UPDATE assignments SET speaker_id=?1,confidence=NULL WHERE media_id=?2 AND local_id=?3", params![id,input.media_id,local])?;
    }
    let mut result = if let Some(id) = &id { match_unidentified(&tx,Some(id))? } else { json!({"matched":0,"recordings":0}) };
    result["speakerId"] = json!(id);
    tx.commit()?;
    Ok(result)
}

pub fn delete(root: &Path, id: &str) -> Result<()> {
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    require(&tx,id)?;
    tx.execute("UPDATE assignments SET speaker_id=NULL,confidence=NULL WHERE speaker_id=?1", [id])?;
    tx.execute("DELETE FROM speakers WHERE id=?1", [id])?;
    tx.commit()?;
    Ok(())
}
pub fn merge(root: &Path, source: &str, target: &str) -> Result<Value> {
    anyhow::ensure!(source != target, "Choose a different target speaker");
    let mut db = db::open(root)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    require(&tx,target)?;
    let (embedding,weight): (Option<Vec<u8>>,i64) = tx.query_row("SELECT embedding,sample_count FROM speakers WHERE id=?1", [source], |r| Ok((r.get(0)?,r.get(1)?))).context("Speaker not found")?;
    if let Some(embedding) = embedding { add_print(&tx,target,&embedding,weight.max(1))?; }
    let moved = tx.execute("UPDATE assignments SET speaker_id=?1 WHERE speaker_id=?2", params![target,source])?;
    tx.execute("INSERT OR IGNORE INTO speaker_training SELECT ?1,media_id,local_id FROM speaker_training WHERE speaker_id=?2", params![target,source])?;
    tx.execute("DELETE FROM speakers WHERE id=?1", [source])?;
    let mut result = match_unidentified(&tx,Some(target))?;
    result["reassigned"] = json!(moved);
    tx.commit()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let db = db::open(root.path()).unwrap();
        db.execute_batch("INSERT INTO media(id,title) VALUES ('a','Meeting A'),('b','Meeting B');
          INSERT INTO speakers(id,name,notes,color) VALUES ('s','Sarah','Keep these notes','#123456'),('d','David',NULL,NULL);
          INSERT INTO assignments(media_id,local_id,airtime) VALUES ('a','S0',12),('a','S1',8),('b','S0',20),('b','S1',1);").unwrap();
        for (media,local,v) in [("a","S0",vec![1.,0.]),("a","S1",vec![0.8,0.2]),("b","S0",vec![0.9,0.1]),("b","S1",vec![0.,1.])] {
            db.execute("UPDATE assignments SET centroid=?1 WHERE media_id=?2 AND local_id=?3",params![bytes(&v),media,local]).unwrap();
        }
        root
    }
    fn input(locals: &[&str], speaker: &str) -> Label {
        Label { media_id:"a".into(),locals:locals.iter().map(|s|s.to_string()).collect(),speaker_id:Some(speaker.into()),name:None,color:None,noise:false,unlink:false }
    }
    #[test]
    fn label_trains_once_and_matching_preserves_named_voices() {
        let root=fixture();
        let db=db::open(root.path()).unwrap();
        db.execute("UPDATE assignments SET speaker_id='d' WHERE media_id='a' AND local_id='S1'",[]).unwrap();
        let result=label(root.path(),&input(&["S0"],"s")).unwrap();
        assert_eq!(result["matched"],1);
        label(root.path(),&input(&["S0"],"s")).unwrap();
        assert_eq!(db.query_row("SELECT sample_count FROM speakers WHERE id='s'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.query_row("SELECT speaker_id FROM assignments WHERE media_id='a' AND local_id='S1'",[],|r|r.get::<_,String>(0)).unwrap(),"d");
        let mut unlink=input(&["S0"],"s");unlink.unlink=true;
        label(root.path(),&unlink).unwrap();
        label(root.path(),&input(&["S0"],"s")).unwrap();
        assert_eq!(db.query_row("SELECT sample_count FROM speakers WHERE id='s'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(unidentified(root.path()).unwrap().len(),1);
    }
    #[test]
    fn multi_voice_label_is_atomic_and_prints_are_normalized() {
        let root=fixture();
        assert!(label(root.path(),&input(&["S0","missing"],"s")).is_err());
        assert_eq!(unidentified(root.path()).unwrap().len(),4);
        label(root.path(),&input(&["S0","S1","S1"],"s")).unwrap();
        let db=db::open(root.path()).unwrap();
        let (p,n):(Vec<u8>,i64)=db.query_row("SELECT embedding,sample_count FROM speakers WHERE id='s'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(n,2);
        assert!((floats(&p).iter().map(|v|v*v).sum::<f32>()-1.).abs()<0.0001);
    }
    #[test]
    fn merge_delete_and_noise_keep_the_archive_intact() {
        let root=fixture();
        label(root.path(),&input(&["S0"],"s")).unwrap();
        label(root.path(),&input(&["S1"],"d")).unwrap();
        merge(root.path(),"d","s").unwrap();
        let db=db::open(root.path()).unwrap();
        assert_eq!(db.query_row("SELECT notes FROM speakers WHERE id='s'",[],|r|r.get::<_,String>(0)).unwrap(),"Keep these notes");
        assert_eq!(db.query_row("SELECT count(*) FROM speakers",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        edit(root.path(),"s","Sarah",Some("#123456"),true).unwrap();
        assert!(db::palette(root.path(),"Sarah").unwrap()["speakers"].as_array().unwrap().is_empty());
        assert_eq!(db::library(root.path(),&db::LibraryFilter::default()).unwrap()["items"][0]["speaker_total"],0);
        delete(root.path(),"s").unwrap();
        assert_eq!(unidentified(root.path()).unwrap().len(),4);
        assert_eq!(db.query_row("SELECT count(*) FROM assignments WHERE centroid IS NOT NULL",[],|r|r.get::<_,i64>(0)).unwrap(),4);
    }
    #[test]
    fn rename_collision_and_bad_color_are_rejected() {
        let root=fixture();
        assert!(edit(root.path(),"s","david",None,false).is_err());
        assert!(edit(root.path(),"s","Sarah",Some("red;bad"),false).is_err());
        assert!(merge(root.path(),"s","s").is_err());
    }
}
