//! Bounded read-only application log. Never log prompts, API keys or HTTP bodies.
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};
#[derive(Clone, Serialize)]
pub struct Entry {
    pub id: u64,
    pub timestamp: u64,
    pub level: String,
    pub message: String,
}
#[derive(Default)]
struct Buffer {
    next: u64,
    entries: VecDeque<Entry>,
}
fn buffer() -> &'static Mutex<Buffer> {
    static LOG: OnceLock<Mutex<Buffer>> = OnceLock::new();
    LOG.get_or_init(Mutex::default)
}
pub fn push(level: &str, message: &str) {
    let mut b = buffer().lock().unwrap_or_else(|e| e.into_inner());
    if b.entries
        .back()
        .is_some_and(|e| e.level == level && e.message == message)
    {
        return;
    }
    b.next += 1;
    let id = b.next;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    b.entries.push_back(Entry {
        id,
        timestamp,
        level: level.into(),
        message: message.chars().take(3000).collect(),
    });
    while b.entries.len() > 2000 {
        b.entries.pop_front();
    }
}
pub fn read(after: u64) -> Vec<Entry> {
    buffer()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entries
        .iter()
        .filter(|e| e.id > after)
        .cloned()
        .collect()
}
