pub mod subscription;
pub mod automation;
pub mod builtin;
pub mod chat;
pub mod chatgpt;
pub mod config;
pub mod index;
pub mod summary;
use anyhow::Result;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::{atomic::AtomicBool, Mutex};
#[derive(Default)]
pub struct Control {
    pub chatgpt: Arc<chatgpt::Control>,
    pub indexing: AtomicBool,
    pub index_job: Mutex<Option<String>>,
    pub automation_gate: Mutex<()>,
    pub closing: AtomicBool,
    pub cancel_index: AtomicBool,
    pub chats: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub summaries: Mutex<HashMap<String, summary::Task>>,
}
pub fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS ai_indexes(signature TEXT PRIMARY KEY,model TEXT NOT NULL,dimensions INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_sources(signature TEXT NOT NULL REFERENCES ai_indexes(signature) ON DELETE CASCADE,kind TEXT NOT NULL,source_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(signature,kind,source_id));
    CREATE TABLE IF NOT EXISTS ai_chunks(id INTEGER PRIMARY KEY,signature TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,position INTEGER NOT NULL,text TEXT NOT NULL,start REAL,end REAL,vector BLOB NOT NULL,FOREIGN KEY(signature,kind,source_id) REFERENCES ai_sources(signature,kind,source_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS ai_chunks_source ON ai_chunks(signature,kind,source_id);
    CREATE TABLE IF NOT EXISTS ai_jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',done INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ai_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ai_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',sources TEXT NOT NULL DEFAULT '[]',starred INTEGER NOT NULL DEFAULT 0,error INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')));
    CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages(conversation_id,created_at);
    CREATE TABLE IF NOT EXISTS ai_summaries(media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,content TEXT NOT NULL,model TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TRIGGER IF NOT EXISTS ai_doc_changed AFTER UPDATE OF body,title ON docs BEGIN DELETE FROM ai_sources WHERE kind='document' AND source_id=new.id; END;
    CREATE TRIGGER IF NOT EXISTS ai_doc_deleted AFTER DELETE ON docs BEGIN DELETE FROM ai_sources WHERE kind='document' AND source_id=old.id; END;
    CREATE TRIGGER IF NOT EXISTS ai_note_changed AFTER UPDATE ON notes BEGIN DELETE FROM ai_sources WHERE kind='note' AND source_id=new.id; END;
    CREATE TRIGGER IF NOT EXISTS ai_note_deleted AFTER DELETE ON notes BEGIN DELETE FROM ai_sources WHERE kind='note' AND source_id=old.id; END;
    CREATE TRIGGER IF NOT EXISTS ai_anchor_added AFTER INSERT ON note_anchors BEGIN DELETE FROM ai_sources WHERE kind='note' AND source_id=new.note_id; END;
    CREATE TRIGGER IF NOT EXISTS ai_anchor_removed AFTER DELETE ON note_anchors BEGIN DELETE FROM ai_sources WHERE kind='note' AND source_id=old.note_id; END;
    CREATE TRIGGER IF NOT EXISTS ai_anchor_changed AFTER UPDATE ON note_anchors BEGIN DELETE FROM ai_sources WHERE kind='note' AND source_id=new.note_id; END;
    CREATE TRIGGER IF NOT EXISTS ai_media_changed AFTER UPDATE OF transcript ON media BEGIN DELETE FROM ai_sources WHERE kind='recording' AND source_id=new.id; DELETE FROM ai_summaries WHERE media_id=new.id; END;
    CREATE TRIGGER IF NOT EXISTS ai_media_deleted AFTER DELETE ON media BEGIN DELETE FROM ai_sources WHERE kind='recording' AND source_id=old.id; END;")?;
    Ok(())
}

#[cfg(test)]
mod tests;
