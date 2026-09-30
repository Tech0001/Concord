pub mod db;
pub mod playback;
pub mod speech;
pub mod thumbnail;
pub mod transcript;
use anyhow::{Context, Result};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Manager, State};

pub struct AppState {
    root: PathBuf,
    runtime: speech::Runtime,
    control: Arc<speech::Control>,
    thumbnail_generator: Arc<std::sync::Mutex<()>>,
    playback: Arc<playback::Playback>,
}
async fn work<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn overview(state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.root.clone();
    work(move || db::stats(&root)).await
}
#[tauri::command]
async fn import_legacy(state: State<'_, AppState>, path: String) -> Result<Value, String> {
    let root = state.root.clone();
    work(move || db::import_legacy(&root, Path::new(&path))).await
}
#[tauri::command]
async fn library(state: State<'_, AppState>, filter: db::LibraryFilter) -> Result<Value, String> {
    let root = state.root.clone();
    work(move || db::library(&root, &filter)).await
}
#[tauri::command]
async fn set_starred(state: State<'_, AppState>, id: String, starred: bool) -> Result<(), String> {
    let root = state.root.clone();
    work(move || db::set_starred(&root, &id, starred)).await
}
#[tauri::command]
async fn set_review(state: State<'_, AppState>, id: String, state_name: String) -> Result<(), String> {
    let root = state.root.clone();
    work(move || db::set_review(&root, &id, &state_name)).await
}
#[tauri::command]
async fn save_position(state: State<'_, AppState>, id: String, seconds: f64) -> Result<(), String> {
    let root = state.root.clone();
    work(move || db::save_position(&root, &id, seconds)).await
}
#[tauri::command]
async fn recording(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let root = state.root.clone();
    work(move || db::transcript(&root, &id)).await
}
#[tauri::command]
async fn media_file(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let root = state.root.clone();
    let playback = state.playback.clone();
    work(move || {
        let record = db::media(&root, &id)?;
        let path = Path::new(record["path"].as_str().context("No local media file")?)
            .canonicalize()
            .context("Media unavailable. Reconnect its drive or import a copy.")?;
        Ok(playback.register(path))
    })
    .await
}
#[tauri::command]
async fn thumbnail_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    let root = state.root.clone();
    let generator = state.thumbnail_generator.clone();
    work(move || {
        let Some(path) = thumbnail::resolve(&root, &id, &generator)? else {
            return Ok(None);
        };
        app.asset_protocol_scope().allow_file(&path)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}
#[tauri::command]
async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<Value>, String> {
    let root = state.root.clone();
    work(move || db::search(&root, &query)).await
}
#[tauri::command]
async fn palette(state: State<'_, AppState>, query: String) -> Result<Value, String> {
    let root = state.root.clone();
    work(move || db::palette(&root, &query)).await
}
#[tauri::command]
async fn speakers(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let root = state.root.clone();
    work(move || db::speakers(&root)).await
}
#[tauri::command]
async fn assign_speaker(
    state: State<'_, AppState>,
    id: String,
    local: String,
    name: String,
) -> Result<(), String> {
    let root = state.root.clone();
    work(move || db::assign(&root, &id, &local, &name)).await
}
#[tauri::command]
async fn import_media(state: State<'_, AppState>, paths: Vec<String>) -> Result<usize, String> {
    let root = state.root.clone();
    work(move || db::import_files(&root, &paths)).await
}
#[tauri::command]
async fn speech_status(state: State<'_, AppState>) -> Result<Value, String> {
    let runtime = state.runtime.clone();
    work(move || Ok(runtime.status())).await
}
#[tauri::command]
async fn transcribe(
    state: State<'_, AppState>,
    id: String,
    device: String,
) -> Result<String, String> {
    let (root, runtime, control) = (
        state.root.clone(),
        state.runtime.clone(),
        state.control.clone(),
    );
    work(move || speech::start(root, runtime, control, id, device)).await
}
#[tauri::command]
fn cancel_transcription(state: State<'_, AppState>) {
    state.control.cancel();
}
#[tauri::command]
async fn jobs(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let root = state.root.clone();
    work(move || {
        db::rows(
            &db::open(&root)?,
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 30",
            [],
        )
    })
    .await
}
#[tauri::command]
async fn research(state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.root.clone();
    work(move||{
    let db=db::open(&root)?;Ok(json!({"notes":db::rows(&db,"SELECT * FROM notes ORDER BY created_at DESC",[])?,"links":db::rows(&db,"SELECT * FROM links",[])?,"docs":db::rows(&db,"SELECT id,title,length(body) AS length FROM docs ORDER BY title",[])?}))
}).await
}
#[tauri::command]
async fn document(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let root = state.root.clone();
    work(move || {
        db::rows(&db::open(&root)?, "SELECT * FROM docs WHERE id=?1", [id])?
            .pop()
            .context("Document not found")
    })
    .await
}
#[tauri::command]
async fn import_documents(state: State<'_, AppState>, paths: Vec<String>) -> Result<usize, String> {
    let root = state.root.clone();
    work(move || {
        let mut db = db::open(&root)?;
        let tx = db.transaction()?;
        for path in &paths {
            let p = Path::new(path);
            let ext = p
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            anyhow::ensure!(
                ["md", "txt", "markdown"].contains(&ext.as_str()),
                "Choose Markdown or plain text documents"
            );
            anyhow::ensure!(
                std::fs::metadata(p)?.len() < 20 * 1024 * 1024,
                "Document exceeds 20 MiB"
            );
            let text = std::fs::read_to_string(p)?;
            let title = p.file_stem().unwrap_or_default().to_string_lossy();
            tx.execute(
                "INSERT INTO docs(id,title,body) VALUES (?1,?2,?3)",
                params![uuid::Uuid::new_v4().to_string(), title, text],
            )?;
        }
        tx.commit()?;
        Ok(paths.len())
    })
    .await
}
#[tauri::command]
async fn save_note(state: State<'_, AppState>, note: Value) -> Result<String, String> {
    let root = state.root.clone();
    work(move||{
    let id=note["id"].as_str().map(str::to_owned).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    let title=note["title"].as_str().unwrap_or("").trim();anyhow::ensure!(!title.is_empty(),"Give the note a title");
    db::open(&root)?.execute("INSERT INTO notes(id,title,body,quote,media_id,start,end) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body",
      params![id,title,note["body"].as_str().unwrap_or(""),note["quote"].as_str().unwrap_or(""),note["media_id"].as_str(),note["start"].as_f64(),note["end"].as_f64()])?;Ok(id)
}).await
}
#[tauri::command]
async fn link_notes(
    state: State<'_, AppState>,
    source: String,
    target: String,
) -> Result<(), String> {
    let root = state.root.clone();
    work(move || {
        anyhow::ensure!(source != target, "Choose a different note");
        db::open(&root)?.execute(
            "INSERT OR IGNORE INTO links(source,target,kind) VALUES (?1,?2,'related')",
            params![source, target],
        )?;
        Ok(())
    })
    .await
}

pub fn run() {
    let root = db::data_root();
    // Small CLI surface lets maintainers exercise the same storage layer in CI.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--import-legacy") {
        let result = args
            .get(2)
            .context("Provide a Concord database path")
            .and_then(|p| db::import_legacy(&root, Path::new(p)));
        match result {
            Ok(v) => println!("{v}"),
            Err(e) => {
                eprintln!("{e:#}");
                std::process::exit(1);
            }
        }
        return;
    }
    let control = Arc::new(speech::Control::default());
    let closing = control.clone();
    tauri::Builder::default()
      .plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.show();
          let _ = window.set_focus();
        }
      }))
      .plugin(tauri_plugin_dialog::init())
      .setup(move|app|{
        let db=db::open(&root)?;
        db.execute("UPDATE jobs SET status='interrupted',message='Concord closed before processing finished; the previous transcript is preserved.' WHERE status='running'",[])?;
        app.manage(AppState {root:root.clone(),runtime:speech::Runtime::resolve(app.path().resource_dir().ok()),control:control.clone(),thumbnail_generator:Arc::new(std::sync::Mutex::new(())),playback:Arc::new(playback::Playback::start()?)});Ok(())
      })
      .invoke_handler(tauri::generate_handler![overview,import_legacy,library,recording,media_file,thumbnail_file,search,palette,set_starred,set_review,save_position,speakers,assign_speaker,import_media,speech_status,transcribe,cancel_transcription,jobs,research,document,import_documents,save_note,link_notes])
      .build(tauri::generate_context!()).expect("Cannot launch Concord Next")
      .run(move|_,event|{if matches!(event,tauri::RunEvent::ExitRequested{..}|tauri::RunEvent::Exit){closing.cancel();}});
}
