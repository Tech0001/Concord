//! Read-only document folders with cached text, stable evidence IDs and local sync.
use crate::{db, runtime_log};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Default)]
pub struct Control {
    lock: Mutex<()>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub added: usize,
    pub updated: usize,
    pub missing: usize,
    pub unchanged: usize,
    pub errors: Vec<String>,
}
pub fn migrate(db: &Connection) -> Result<()> {
    for (table, name, ddl) in [
        ("document_roots", "label", "TEXT NOT NULL DEFAULT ''"),
        ("document_roots", "last_scan", "TEXT"),
        ("document_roots", "error", "TEXT"),
        ("docs", "relative", "TEXT"),
        ("docs", "bytes", "INTEGER"),
        ("docs", "mtime", "INTEGER"),
        ("docs", "content_hash", "TEXT"),
        ("docs", "missing", "INTEGER NOT NULL DEFAULT 0"),
        ("docs", "error", "TEXT"),
        ("docs", "author", "TEXT"),
    ] {
        let exists: bool = db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"),
            [name],
            |r| r.get(0),
        )?;
        if !exists {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {ddl}"))?;
        }
    }
    db.execute_batch("CREATE INDEX IF NOT EXISTS docs_path ON docs(path); CREATE INDEX IF NOT EXISTS docs_root ON docs(root_id);")?;
    // Paths from the preview importer retain their original document IDs.
    let roots = db::rows(db, "SELECT id,path FROM document_roots", [])?;
    for root in roots {
        let base = Path::new(root["path"].as_str().unwrap());
        for d in db::rows(
            db,
            "SELECT id,path FROM docs WHERE root_id=?1 AND relative IS NULL",
            [root["id"].as_str()],
        )? {
            if let Some(rel) = d["path"]
                .as_str()
                .and_then(|p| Path::new(p).strip_prefix(base).ok())
            {
                db.execute(
                    "UPDATE docs SET relative=?2 WHERE id=?1",
                    params![d["id"].as_str(), rel.to_string_lossy().replace('\\', "/")],
                )?;
            }
        }
    }
    Ok(())
}
pub fn seed_legacy(root: &Path) -> Result<()> {
    let mut db = db::open(root)?;
    let done: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key='documents.metadataImported')",
        [],
        |r| r.get(0),
    )?;
    if done {
        return Ok(());
    }
    let path: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='imported_from'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(path) = path.filter(|p| Path::new(p).is_file()) else {
        return Ok(());
    };
    let old = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let compatible: bool = old.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('documents') WHERE name='root_id')",
        [],
        |r| r.get(0),
    )?;
    if !compatible {
        return Ok(());
    }
    let config: Option<String> = old
        .query_row(
            "SELECT value FROM app_config WHERE key='docs.rootFolders'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let roots: Value = config
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let tx = db.transaction()?;
    for folder in roots.as_array().into_iter().flatten() {
        if let (Some(id), Some(label)) = (folder["id"].as_str(), folder["label"].as_str()) {
            tx.execute(
                "UPDATE document_roots SET label=?2 WHERE id=?1 AND label=''",
                params![id, label],
            )?;
        }
    }
    for doc in db::rows(
        &old,
        "SELECT id,coalesce(root_id,'') AS root_id,rel_path FROM documents",
        [],
    )? {
        let id = doc["id"].as_str().unwrap();
        let root_id = doc["root_id"].as_str().unwrap();
        let folder: Option<String> = tx
            .query_row(
                "SELECT path FROM document_roots WHERE id=?1",
                [root_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(folder) = folder {
            let relative = doc["rel_path"].as_str().unwrap_or("");
            if relative.is_empty()
                || Path::new(relative).components().any(|c| {
                    !matches!(
                        c,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                })
            {
                continue;
            }
            let path = Path::new(&folder).join(relative);
            // An intentional detach keeps its path; only repair the early import omission.
            tx.execute("UPDATE docs SET path=?2,root_id=?3,relative=?4 WHERE id=?1 AND path IS NULL AND root_id IS NULL",params![id,path.to_string_lossy(),root_id,relative])?;
        }
    }
    tx.execute(
        "INSERT INTO settings VALUES('documents.metadataImported','1')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}
fn label(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}
fn supported(path: &Path) -> bool {
    path.extension().is_some_and(|e| {
        ["md", "markdown", "txt"].contains(&e.to_string_lossy().to_lowercase().as_str())
    })
}
fn metadata(body: &str, path: &Path) -> (String, Option<String>) {
    let clean = body.trim_start_matches('\u{feff}').trim_start();
    let mut title = None;
    let mut author = None;
    let mut prose = clean;
    if let Some(first) = clean
        .strip_prefix("---\r\n")
        .or_else(|| clean.strip_prefix("---\n"))
    {
        if let Some(end) = first.lines().position(|l| l.trim() == "---") {
            for line in first.lines().take(end) {
                if let Some((k, v)) = line.split_once(':') {
                    let v = v.trim().trim_matches(['\'', '"']).trim();
                    if !v.is_empty() {
                        match k.trim().to_lowercase().as_str() {
                            "title" => title = Some(v.to_owned()),
                            "author" => author = Some(v.trim_matches(['[', ']']).trim().to_owned()),
                            _ => {}
                        }
                    }
                }
            }
            let offset = first
                .split_inclusive('\n')
                .take(end + 1)
                .map(str::len)
                .sum::<usize>();
            prose = &first[offset.min(first.len())..];
        }
    }
    let title = title
        .or_else(|| {
            prose.lines().find_map(|l| {
                l.strip_prefix("# ")
                    .map(|s| s.trim().trim_end_matches('#').trim().to_owned())
            })
        })
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    (title, author)
}
struct FileData {
    path: String,
    relative: Option<String>,
    bytes: u64,
    mtime: u64,
    hash: String,
    body: String,
    title: String,
    author: Option<String>,
}
fn load(path: &Path, relative: Option<String>) -> Result<FileData> {
    ensure!(supported(path), "Choose Markdown or plain text documents");
    let (bytes, mtime) = crate::health::stamp(path)?;
    ensure!(bytes <= 20 * 1024 * 1024, "Document exceeds 20 MiB");
    let body = fs::read_to_string(path).context("Document is not readable UTF-8 text")?;
    let (title, author) = metadata(&body, path);
    Ok(FileData {
        path: path.to_string_lossy().into_owned(),
        relative,
        bytes,
        mtime,
        hash: format!("{:x}", Sha256::digest(body.as_bytes())),
        body,
        title,
        author,
    })
}
fn write(db: &Connection, file: &FileData, id: &str, root: Option<&str>) -> Result<bool> {
    let hash: Option<String> = db
        .query_row("SELECT content_hash FROM docs WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();
    let changed = hash.as_deref() != Some(file.hash.as_str());
    if changed {
        db.execute("INSERT INTO docs(id,title,body,path,root_id,relative,bytes,mtime,content_hash,author) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,path=excluded.path,root_id=coalesce(excluded.root_id,docs.root_id),relative=coalesce(excluded.relative,docs.relative),bytes=excluded.bytes,mtime=excluded.mtime,content_hash=excluded.content_hash,author=excluded.author,missing=0,error=NULL",params![id,file.title,file.body,file.path,root,file.relative,file.bytes,file.mtime,file.hash,file.author])?;
    } else {
        db.execute("UPDATE docs SET path=?2,root_id=coalesce(?3,root_id),relative=coalesce(?4,relative),bytes=?5,mtime=?6,missing=0,error=NULL WHERE id=?1",params![id,file.path,root,file.relative,file.bytes,file.mtime])?;
    }
    if changed {
        db.execute(
            "DELETE FROM ai_chunks WHERE kind='document' AND source_id=?1",
            [id],
        )?;
        db.execute(
            "DELETE FROM ai_sources WHERE kind='document' AND source_id=?1",
            [id],
        )?;
    }
    Ok(changed)
}
#[cfg(test)]
pub fn import(root: &Path, control: &Control, paths: &[String]) -> Result<usize> { import_in_category(root,control,paths,"personal") }
pub fn import_in_category(root: &Path, control: &Control, paths: &[String], category: &str) -> Result<usize> {
    anyhow::ensure!(["personal", "work"].contains(&category), "Choose Personal or Work");
    let _guard = control
        .lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Document sync interrupted"))?;
    let mut files = Vec::new();
    for p in paths {
        files.push(load(&Path::new(p).canonicalize()?, None)?);
    }
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    for file in &files {
        let id: Option<String> = tx
            .query_row("SELECT id FROM docs WHERE path=?1", [&file.path], |r| {
                r.get(0)
            })
            .optional()?;
        let new = id.is_none();
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        write(&tx, file, &id, None)?;
        if new { tx.execute("UPDATE docs SET category=?1 WHERE id=?2",params![category,id])?; }
    }
    tx.commit()?;
    Ok(files.len())
}
pub fn add_root(root: &Path, control: &Control, path: &str, name: &str) -> Result<Value> {
    let _guard = control
        .lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Document sync interrupted"))?;
    let path = Path::new(path.trim())
        .canonicalize()
        .context("Folder is unavailable")?;
    ensure!(path.is_dir(), "Choose a folder");
    let db = db::open(root)?;
    for old in db::rows(&db, "SELECT path FROM document_roots", [])? {
        let old = PathBuf::from(old["path"].as_str().unwrap());
        let old = old.canonicalize().unwrap_or(old);
        ensure!(
            !path.starts_with(&old) && !old.starts_with(&path),
            "This folder overlaps a folder already being synced"
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = if name.trim().is_empty() {
        label(&path)
    } else {
        name.trim().to_owned()
    };
    ensure!(name.chars().count() <= 200, "Folder label is too long");
    db.execute(
        "INSERT INTO document_roots(id,path,label) VALUES (?1,?2,?3)",
        params![id, path.to_string_lossy(), name],
    )?;
    Ok(json!({"id":id,"path":path,"label":name}))
}
pub fn edit_root(
    root: &Path,
    control: &Control,
    id: &str,
    name: Option<&str>,
    enabled: Option<bool>,
    remove: bool,
) -> Result<()> {
    let _guard = control
        .lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Document sync interrupted"))?;
    let mut db = db::open(root)?;
    let tx = db.transaction()?;
    if remove {
        // Keep cached text and note evidence. Removing a subscription never deletes user files.
        tx.execute("UPDATE docs SET root_id=NULL WHERE root_id=?1", [id])?;
        tx.execute("DELETE FROM document_roots WHERE id=?1", [id])?;
    } else {
        if let Some(name) = name {
            ensure!(
                !name.trim().is_empty() && name.chars().count() <= 200,
                "Enter a folder label"
            );
            tx.execute(
                "UPDATE document_roots SET label=?2 WHERE id=?1",
                params![id, name.trim()],
            )?;
        }
        if let Some(enabled) = enabled {
            tx.execute(
                "UPDATE document_roots SET enabled=?2 WHERE id=?1",
                params![id, enabled],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}
pub fn edit(root: &Path, id: &str, starred: Option<bool>, category: Option<&str>) -> Result<()> {
    let db = db::open(root)?;
    if let Some(starred) = starred {
        db.execute(
            "UPDATE docs SET starred=?2 WHERE id=?1",
            params![id, starred],
        )?;
    }
    if let Some(category) = category {
        ensure!(
            ["personal", "work"].contains(&category),
            "Choose Personal or Work"
        );
        db.execute(
            "UPDATE docs SET category=?2 WHERE id=?1",
            params![id, category],
        )?;
    }
    Ok(())
}
pub fn snapshot(root: &Path) -> Result<Value> {
    let db = db::open(root)?;
    let mut roots = db::rows(&db, "SELECT * FROM document_roots ORDER BY label,path", [])?;
    for r in &mut roots {
        let path = PathBuf::from(r["path"].as_str().unwrap());
        if r["label"].as_str().unwrap_or("").is_empty() {
            r["label"] = json!(label(&path));
        }
        r["connected"] = json!(path.is_dir());
    }
    Ok(
        json!({"roots":roots,"docs":db::rows(&db,"SELECT id,title,path,root_id,relative,starred,category,missing,error,author,content_hash,length(body) AS length FROM docs ORDER BY lower(coalesce(relative,title))",[])?}),
    )
}
pub fn read(root: &Path, id: &str) -> Result<Value> {
    let db = db::open(root)?;
    let mut doc=db::rows(&db,"SELECT d.*,s.id AS speaker_id,s.name AS speaker_name,s.color AS speaker_color FROM docs d LEFT JOIN speakers s ON s.id=(SELECT id FROM speakers WHERE lower(trim(name))=lower(trim(d.author)) AND is_noise=0 ORDER BY id LIMIT 1) WHERE d.id=?1",[id])?.pop().context("Document not found")?;
    doc["notes"]=json!(db::rows(&db,"SELECT DISTINCT n.id,n.title FROM notes n JOIN note_anchors a ON a.note_id=n.id WHERE a.doc_id=?1 ORDER BY n.updated_at DESC",[id])?);
    Ok(doc)
}
fn walk(
    path: &Path,
    base: &Path,
    out: &mut Vec<(PathBuf, String)>,
    errors: &mut Vec<String>,
) -> bool {
    let entries = match fs::read_dir(path) {
        Ok(v) => v,
        Err(e) => {
            errors.push(format!("{}: {e}", path.display()));
            return false;
        }
    };
    let mut complete = true;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                errors.push(e.to_string());
                complete = false;
                continue;
            }
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let kind = match entry.file_type() {
            Ok(t) => t,
            Err(e) => {
                errors.push(e.to_string());
                complete = false;
                continue;
            }
        };
        let path = entry.path();
        // Do not follow symlinks outside a root or into directory loops.
        if kind.is_dir() {
            complete &= walk(&path, base, out, errors);
        } else if kind.is_file() && supported(&path) {
            out.push((
                path.clone(),
                path.strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            ));
        }
    }
    complete
}
pub fn sync(root: &Path, control: &Control, force: bool) -> Result<SyncResult> {
    let _guard = control
        .lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Document sync interrupted"))?;
    sync_locked(root, force)
}
fn sync_locked(root: &Path, force: bool) -> Result<SyncResult> {
    let mut db = db::open(root)?;
    let mut result = SyncResult::default();
    for folder in db::rows(&db, "SELECT * FROM document_roots WHERE enabled=1", [])? {
        let id = folder["id"].as_str().unwrap();
        let path = Path::new(folder["path"].as_str().unwrap());
        let mut errors = Vec::new();
        let mut files = Vec::new();
        let complete = walk(path, path, &mut files, &mut errors);
        let existing = db::rows(
            &db,
            "SELECT id,path,relative,bytes,mtime,missing FROM docs WHERE root_id=?1",
            [id],
        )?;
        let mut by_path: HashMap<String, &Value> = HashMap::new();
        for d in &existing {
            if let Some(p) = d["path"].as_str() {
                by_path.insert(p.into(), d);
            }
        }
        let mut seen = HashSet::new();
        let mut writes = Vec::new();
        let mut failed = Vec::new();
        for (path, relative) in files {
            let pathstr = path.to_string_lossy().into_owned();
            seen.insert(pathstr.clone());
            let old = by_path.get(&pathstr);
            let stamp = crate::health::stamp(&path);
            if !force
                && old.is_some_and(|d| {
                    stamp.as_ref().is_ok_and(|(b, m)| {
                        d["bytes"].as_u64() == Some(*b)
                            && d["mtime"].as_u64() == Some(*m)
                            && d["missing"] == 0
                    })
                })
            {
                result.unchanged += 1;
                continue;
            }
            match load(&path, Some(relative)) {
                Ok(file) => writes.push((old.map(|d| d["id"].as_str().unwrap().to_owned()), file)),
                Err(e) => {
                    errors.push(format!("{}: {e:#}", path.display()));
                    if let Some(d) = old {
                        failed.push((d["id"].as_str().unwrap().to_owned(), format!("{e:#}")));
                    }
                }
            }
        }
        let tx = db.transaction()?;
        for (old, file) in writes {
            // Re-adding a previously detached root reuses the document, notes and stars.
            let prior: Option<String> = tx
                .query_row("SELECT id FROM docs WHERE path=?1", [&file.path], |r| {
                    r.get(0)
                })
                .optional()?;
            let existed = old.is_some() || prior.is_some();
            let did = old
                .or(prior)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            if write(&tx, &file, &did, Some(id))? {
                if existed {
                    result.updated += 1;
                } else {
                    result.added += 1;
                }
            } else {
                result.unchanged += 1;
            }
        }
        if complete {
            for d in &existing {
                if d["missing"] == 0 && !seen.contains(d["path"].as_str().unwrap_or("")) {
                    tx.execute("UPDATE docs SET missing=1,error='Source file is unavailable; showing the last synced copy.' WHERE id=?1",[d["id"].as_str()])?;
                    result.missing += 1;
                }
            }
        }
        for (did, error) in failed {
            tx.execute("UPDATE docs SET error=?2 WHERE id=?1", params![did, error])?;
        }
        tx.execute(
            "UPDATE document_roots SET last_scan=datetime('now'),error=?2 WHERE id=?1",
            params![
                id,
                if errors.is_empty() {
                    None
                } else {
                    Some(errors.join("\n"))
                }
            ],
        )?;
        tx.commit()?;
        result.errors.extend(errors);
    }
    if result.added + result.updated + result.missing > 0 {
        runtime_log::push(
            "info",
            &format!(
                "Document sync: {} added, {} updated, {} unavailable",
                result.added, result.updated, result.missing
            ),
        );
    }
    Ok(result)
}
pub fn start(root: PathBuf, control: Arc<Control>) {
    std::thread::spawn(move || loop {
        if let Ok(_guard) = control.lock.try_lock() {
            if let Err(e) = sync_locked(&root, false) {
                runtime_log::push("warn", &format!("Document sync: {e:#}"));
            }
        }
        std::thread::sleep(Duration::from_secs(10));
    });
}
/// Resolve relative images/links only inside this document's authorized folder.
pub fn resolve(root: &Path, id: &str, relative: &str) -> Result<PathBuf> {
    let db = db::open(root)?;
    let (path,folder):(String,Option<String>)=db.query_row("SELECT d.path,r.path FROM docs d LEFT JOIN document_roots r ON r.id=d.root_id WHERE d.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let path = Path::new(&path);
    let base = path.parent().context("Document has no folder")?;
    let bound = folder
        .map(PathBuf::from)
        .unwrap_or_else(|| base.to_path_buf())
        .canonicalize()?;
    let target = base.join(relative).canonicalize()?;
    ensure!(
        target.starts_with(bound) && target.is_file(),
        "Link leaves the document folder"
    );
    Ok(target)
}
#[cfg(test)]
mod tests;
