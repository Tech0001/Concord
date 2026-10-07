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
    debug_entries: VecDeque<Entry>,
}
fn buffer() -> &'static Mutex<Buffer> {
    static LOG: OnceLock<Mutex<Buffer>> = OnceLock::new();
    LOG.get_or_init(Mutex::default)
}
pub fn push(level: &str, message: &str) {
    let message = redact(message);
    let mut b = buffer().lock().unwrap_or_else(|e| e.into_inner());
    let entries = if level == "debug" {
        &b.debug_entries
    } else {
        &b.entries
    };
    if entries
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
    let entries = if level == "debug" {
        &mut b.debug_entries
    } else {
        &mut b.entries
    };
    entries.push_back(Entry {
        id,
        timestamp,
        level: level.into(),
        message: message.chars().take(3000).collect(),
    });
    while entries.len() > 2000 {
        entries.pop_front();
    }
}
/// Debug is retained alongside activity so opening the terminal after a failure
/// still shows the lead-up. Separate 2,000-line rings protect readable activity.
pub fn debug(component: &str, message: &str) {
    push("debug", &format!("{component} · {message}"));
}

/// Defence in depth for diagnostics. Callers must never pass prompts, response
/// bodies or command arguments. Credential-bearing lines are withheld entirely.
fn redact(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if [
        "authorization",
        "api_key",
        "api-key",
        "api key",
        "apikey",
        "access_token",
        "refresh_token",
        "token=",
        "token\"",
        "bearer ",
        "cookie",
        "password",
        "secret",
        "sk-",
        "hf_",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return "[Credential-bearing diagnostic omitted]".into();
    }
    // Network errors can contain signed URLs or embedded credentials. Keep the
    // surrounding error, but never retain the URL or its query parameters.
    message
        .split_whitespace()
        .map(|word| {
            if word.contains("://") {
                "[URL omitted]".to_string()
            } else {
                word.chars().filter(|c| !c.is_control()).collect()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Only known runtime diagnostics, never arbitrary subprocess stdout (which can
/// contain transcript text, metadata JSON, or embedding input/output).
pub fn native_line(component: &str, line: &str) {
    if native_diagnostic(line) {
        debug(component, line.trim());
    }
}
fn native_diagnostic(line: &str) -> bool {
    let text = line.trim();
    let lower = text.to_ascii_lowercase();
    ![
        "prompt", "content", "request", "response", "token", "text =", "text:",
    ]
    .iter()
    .any(|v| lower.contains(v))
        && [
            "ggml_vulkan:",
            "ggml_cuda_init:",
            "load_tensors:",
            "llama_model_load:",
            "llama_model_loader:",
            "[nemo]",
        ]
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

/// Incremental bounded tail of a known runtime log; never rescans the whole file.
#[derive(Default)]
pub struct DiagnosticTail {
    offset: u64,
    pending: Vec<u8>,
}
impl DiagnosticTail {
    pub fn poll(&mut self, path: &std::path::Path, component: &str) {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut file) = std::fs::File::open(path) else {
            return;
        };
        let length = file.metadata().map(|m| m.len()).unwrap_or(0);
        if length < self.offset {
            self.offset = 0;
            self.pending.clear();
        }
        if length.saturating_sub(self.offset) > 64 * 1024 {
            self.offset = length - 64 * 1024;
            self.pending.clear();
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut bytes = [0; 16 * 1024];
        let Ok(count) = file.read(&mut bytes) else {
            return;
        };
        self.offset += count as u64;
        for byte in &bytes[..count] {
            if *byte == b'\n' || *byte == b'\r' {
                native_line(component, &String::from_utf8_lossy(&self.pending));
                self.pending.clear();
            } else if self.pending.len() < 3000 {
                self.pending.push(*byte);
            }
        }
    }
}
pub fn read(after: u64) -> Vec<Entry> {
    let buffer = buffer().lock().unwrap_or_else(|e| e.into_inner());
    let mut entries: Vec<_> = buffer
        .entries
        .iter()
        .chain(buffer.debug_entries.iter())
        .filter(|e| e.id > after)
        .cloned()
        .collect();
    entries.sort_unstable_by_key(|e| e.id);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_urls_and_untrusted_runtime_output_are_excluded() {
        for text in [
            "Authorization: Bearer abc",
            "api_key=abc",
            "API key: abc",
            "token=abc",
            "{\"token\":\"abc\"}",
            "Cookie: abc",
            "failed https://user:pass@server/path?token=abc",
            "error sk-private",
        ] {
            let clean = redact(text);
            assert!(
                !clean.contains("abc") && !clean.contains("private") && !clean.contains("pass@")
            );
        }
        for line in [
            "{\"text\":\"private recording\"}",
            "[00:03] private recording",
            "slot process: prompt = private",
            "load_tensors: request body",
            "llama_model_loader: token text",
        ] {
            assert!(!native_diagnostic(line), "{line}");
        }
        assert!(native_diagnostic("ggml_vulkan: Found 1 Vulkan devices:"));
        assert!(native_diagnostic(
            "load_tensors: offloaded 29/29 layers to GPU"
        ));
    }
    #[test]
    fn incremental_tail_waits_for_lines_and_does_not_repeat_or_copy_transcripts() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.log");
        std::fs::write(&path, "ggml_vulkan: fixture-partial").unwrap();
        let mut tail = DiagnosticTail::default();
        tail.poll(&path, "tail-test");
        let before = read(0).last().map(|r| r.id).unwrap_or(0);
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap(),
            " complete\nprivate transcript"
        )
        .unwrap();
        tail.poll(&path, "tail-test");
        tail.poll(&path, "tail-test");
        let lines: Vec<_> = read(before)
            .into_iter()
            .filter(|e| e.message.starts_with("tail-test"))
            .collect();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].message.ends_with("fixture-partial complete"));
        assert_eq!(lines[0].level, "debug");
    }
}
