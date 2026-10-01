#[cfg(debug_assertions)]
mod smoke;
pub mod db;
pub mod pipeline;
pub mod documents;
pub mod health;
pub mod runtime_log;
pub mod legacy_research;
pub mod ai;
pub mod speakers;
pub mod research;
pub mod export;
pub mod system;
pub mod waveform;
pub mod playback;
pub mod speech;
pub mod speech_setup;
pub mod search_index;
mod speech_labels;
pub mod thumbnail;
pub mod transcript;
use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, State};

pub struct AppState {
    speech_setup: Arc<speech_setup::Control>,
    pipeline: Arc<pipeline::Control>,
    ai: Arc<ai::Control>,
    documents: Arc<documents::Control>,
    maintenance: Arc<health::Control>,
    root: PathBuf,
    runtime: speech::Runtime,
    thumbnail_generator: Arc<std::sync::Mutex<()>>,
    playback: Arc<playback::Playback>,
    export: Arc<export::ExportControl>,
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
async fn pipeline_save_source(state:State<'_,AppState>,source:pipeline::sources::Source)->Result<String,String>{let root=state.root.clone();let control=state.pipeline.clone();work(move||pipeline::sources::save(&root,&control,&source)).await}
#[tauri::command]
async fn pipeline_remove_source(state:State<'_,AppState>,id:String)->Result<(),String>{let root=state.root.clone();let control=state.pipeline.clone();work(move||pipeline::sources::remove(&root,&control,&id)).await}
#[tauri::command]
async fn pipeline_check(state:State<'_,AppState>,id:Option<String>,full:bool,category:Option<String>)->Result<(),String>{let root=state.root.clone();let control=state.pipeline.clone();work(move||pipeline::sources::start_filtered(root,control,id,full,category.unwrap_or_default())).await}
#[tauri::command]
fn pipeline_stop_check(state:State<'_,AppState>){state.pipeline.scanner.cancel();}
#[tauri::command]
async fn pipeline_tools()->Result<Value,String>{work(move||Ok(pipeline::download::status())).await}
#[tauri::command]
async fn pipeline_state(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();let control=state.pipeline.clone();work(move||{let mut s=pipeline::snapshot(&root)?;s["checking"]=serde_json::json!(control.checking.load(Ordering::SeqCst));Ok(s)}).await}
#[tauri::command]
async fn pipeline_candidates(state:State<'_,AppState>,batch:pipeline::Batch)->Result<Value,String>{let root=state.root.clone();work(move||pipeline::candidates(&root,&batch)).await}
#[tauri::command]
async fn pipeline_enqueue(state:State<'_,AppState>,batch:pipeline::Batch,start:bool)->Result<Value,String>{let root=state.root.clone();let control=state.pipeline.clone();work(move||pipeline::enqueue(&root,&control,&batch,start)).await}
#[tauri::command]
async fn pipeline_action(state:State<'_,AppState>,action:String,id:Option<String>)->Result<(),String>{let root=state.root.clone();let control=state.pipeline.clone();work(move||pipeline::action(&root,&control,&action,id.as_deref())).await}
#[tauri::command]
async fn pipeline_save_config(state:State<'_,AppState>,config:pipeline::Config)->Result<(),String>{let root=state.root.clone();work(move||pipeline::save_config(&root,&config)).await}
#[tauri::command]
async fn archive_status(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();work(move||health::report::snapshot(&root)).await}
#[tauri::command]
async fn archive_jobs(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();work(move||{let db=db::open(&root)?;Ok(serde_json::json!({"jobs":db::rows(&db,"SELECT * FROM maintenance_jobs ORDER BY created_at DESC,rowid DESC LIMIT 40",[])?,"aiJobs":db::rows(&db,"SELECT * FROM ai_jobs ORDER BY created_at DESC,rowid DESC LIMIT 20",[])?}))}).await}
#[tauri::command]
async fn archive_audit(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();work(move||health::report::audit(&root)).await}
#[tauri::command]
async fn archive_last_audit(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();work(move||{let rows=db::rows(&db::open(&root)?,"SELECT value FROM settings WHERE key='health.lastAudit'",[])?;Ok(rows.first().and_then(|v|v["value"].as_str()).and_then(|v|serde_json::from_str(v).ok()).unwrap_or(Value::Null))}).await}
#[tauri::command]
async fn archive_repair(state:State<'_,AppState>,action:String)->Result<String,String>{let root=state.root.clone();let control=state.maintenance.clone();let generator=state.thumbnail_generator.clone();let ai=state.ai.clone();work(move||{if action=="embed-recordings"||action=="embed-documents"{return ai::index::start_filtered(root,ai,Some(if action=="embed-recordings"{"recording"}else{"document"}.into()));}health::repair::start(root,control,generator,action)}).await}
#[tauri::command]
fn archive_cancel_repair(state:State<'_,AppState>){state.maintenance.cancel.store(true,Ordering::SeqCst);}
#[tauri::command]
async fn archive_verify_embedding(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();work(move||{let c=ai::config::read(&root)?;let p=if c.embedding.kind=="builtin"{ai::builtin::provider(&root,|_|Ok(()))?}else{c.embedding.clone()};let v=p.embed(&p.client()?,&["Concord embedding compatibility check".into()])?;let width=v[0].len();let db=db::open(&root)?;let rows=db::rows(&db,"SELECT dimensions FROM ai_indexes WHERE signature=?1",[c.embedding.signature()])?;if let Some(row)=rows.first(){anyhow::ensure!(row["dimensions"].as_u64()==Some(width as u64),"Model returns {width} dimensions, but the active index has {}. Choose the matching model or rebuild its index.",row["dimensions"]);}let result=serde_json::json!({"dimensions":width,"model":c.embedding.model,"checkedAt":health::now()});db.execute("INSERT INTO settings VALUES ('health.embeddingCheck',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[result.to_string()])?;runtime_log::push("info",&format!("Embedding compatibility verified: {width} dimensions"));Ok(result)}).await}
#[tauri::command]
async fn archive_create_backup(state:State<'_,AppState>,folder:String)->Result<Value,String>{let root=state.root.clone();work(move||health::backup::create(&root,Path::new(&folder))).await}
#[tauri::command]
async fn archive_validate_backup(path:String)->Result<Value,String>{work(move||health::backup::validate(Path::new(&path))).await}
#[tauri::command]
async fn archive_stage_restore(state:State<'_,AppState>,path:String)->Result<Value,String>{let root=state.root.clone();work(move||health::backup::stage(&root,Path::new(&path))).await}
#[tauri::command]
async fn archive_cancel_restore(state:State<'_,AppState>)->Result<(),String>{let root=state.root.clone();work(move||health::backup::cancel(&root)).await}
#[tauri::command]
fn runtime_logs(after:u64)->Vec<runtime_log::Entry>{runtime_log::read(after)}
#[tauri::command]
async fn ai_config(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();work(move||ai::config::view(&root)).await}
#[tauri::command]
async fn ai_save_provider(state:State<'_,AppState>,task:String,provider:ai::config::Provider,key:Option<String>)->Result<Value,String>{let root=state.root.clone();let control=state.ai.clone();work(move||{anyhow::ensure!(task!="embedding"||!control.indexing.load(Ordering::SeqCst),"Stop indexing before changing embedding providers");ai::config::save(&root,&task,provider,key)}).await}
#[tauri::command]
async fn ai_models(state:State<'_,AppState>,task:String)->Result<Vec<Value>,String>{let root=state.root.clone();work(move||{let c=ai::config::read(&root)?;let p=if task=="embedding"{c.embedding}else{c.chat};p.models(&task)}).await}
#[tauri::command]
async fn ai_check(state:State<'_,AppState>,task:String)->Result<Value,String>{let root=state.root.clone();work(move||{let c=ai::config::read(&root)?;if task=="embedding"{let p=if c.embedding.kind=="builtin"{ai::builtin::provider(&root,|_|Ok(()))?}else{c.embedding};let v=p.embed(&p.client()?,&["Concord connection check".into()])?;Ok(serde_json::json!({"message":format!("Embedding model ready · {} dimensions",v[0].len())}))}else{let text=ai::chat::complete(&c.chat,&[serde_json::json!({"role":"user","content":"Reply with OK."})],&std::sync::atomic::AtomicBool::new(false),|_|{})?;Ok(serde_json::json!({"message":format!("Chat model ready · {}",text.chars().take(80).collect::<String>())}))}}).await}
#[tauri::command]
async fn ai_status(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();work(move||ai::index::status(&root)).await}
#[tauri::command]
async fn ai_index(state:State<'_,AppState>)->Result<String,String>{let root=state.root.clone();let control=state.ai.clone();work(move||ai::index::start(root,control)).await}
#[tauri::command]
fn ai_cancel_index(state:State<'_,AppState>){state.ai.cancel_index.store(true,Ordering::SeqCst);}
#[tauri::command]
async fn ai_clear_index(state:State<'_,AppState>)->Result<(),String>{let root=state.root.clone();let control=state.ai.clone();work(move||ai::index::clear(&root,&control)).await}
#[tauri::command]
async fn research_search(state:State<'_,AppState>,query:String,semantic:bool,filter:ai::index::Filter)->Result<Vec<ai::index::Hit>,String>{let root=state.root.clone();work(move||ai::index::search(&root,&query,semantic,&filter,100)).await}
#[tauri::command]
async fn search_filters(state:State<'_,AppState>)->Result<Value,String>{let root=state.root.clone();work(move||ai::index::filters(&root)).await}
#[tauri::command]
async fn ai_conversations(state:State<'_,AppState>)->Result<Vec<Value>,String>{let root=state.root.clone();work(move||ai::chat::list(&root)).await}
#[tauri::command]
async fn ai_create_chat(state:State<'_,AppState>)->Result<String,String>{let root=state.root.clone();work(move||ai::chat::create(&root)).await}
#[tauri::command]
async fn ai_read_chat(state:State<'_,AppState>,id:String)->Result<Value,String>{let root=state.root.clone();work(move||ai::chat::read(&root,&id)).await}
#[tauri::command]
async fn ai_edit_chat(state:State<'_,AppState>,id:String,title:Option<String>,pinned:Option<bool>,remove:bool)->Result<(),String>{let root=state.root.clone();let control=state.ai.clone();work(move||ai::chat::edit(&root,&control,&id,title.as_deref(),pinned,remove)).await}
#[tauri::command]
async fn ai_send(app:tauri::AppHandle,state:State<'_,AppState>,request:ai::chat::Send)->Result<Value,String>{let root=state.root.clone();let control=state.ai.clone();work(move||ai::chat::send(&root,&control,&request,|text|{let _=app.emit("ai-chat-delta",serde_json::json!({"id":request.conversation_id,"text":text}));})).await}
#[tauri::command]
fn ai_cancel_chat(state:State<'_,AppState>,id:String){ai::chat::cancel(&state.ai,&id);}
#[tauri::command]
async fn ai_star_message(state:State<'_,AppState>,id:String,starred:bool)->Result<(),String>{let root=state.root.clone();work(move||ai::chat::star(&root,&id,starred)).await}
#[tauri::command]
async fn ai_suggest_tags(state:State<'_,AppState>,text:String)->Result<Vec<String>,String>{let root=state.root.clone();work(move||ai::chat::suggest_tags(&root,&text)).await}
#[tauri::command]
async fn ai_summary(state:State<'_,AppState>,id:String,generate:bool)->Result<Value,String>{let root=state.root.clone();work(move||ai::chat::summary(&root,&id,generate)).await}
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
async fn set_category(state: State<'_, AppState>, id: String, category: String) -> Result<(), String> {
    let root = state.root.clone();
    work(move || db::set_category(&root, &id, &category)).await
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
async fn speaker_appearances(state: State<'_, AppState>, id: String) -> Result<Vec<Value>, String> {
    let root = state.root.clone();
    work(move || db::speaker_appearances(&root, &id)).await
}
#[tauri::command]
async fn set_speaker_notes(state: State<'_, AppState>, id: String, notes: String) -> Result<(), String> {
    let root = state.root.clone();
    work(move || db::set_speaker_notes(&root, &id, &notes)).await
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
async fn unidentified_speakers(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let root = state.root.clone(); work(move || speakers::unidentified(&root)).await
}
#[tauri::command]
async fn edit_speaker(state: State<'_, AppState>, id: String, name: String, color: Option<String>, noise: bool) -> Result<(), String> {
    let root = state.root.clone(); work(move || speakers::edit(&root,&id,&name,color.as_deref(),noise)).await
}
#[tauri::command]
async fn delete_speaker(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let root = state.root.clone(); work(move || speakers::delete(&root,&id)).await
}
#[tauri::command]
async fn merge_speakers(state: State<'_, AppState>, source: String, target: String) -> Result<Value, String> {
    let root = state.root.clone(); work(move || speakers::merge(&root,&source,&target)).await
}
#[tauri::command]
async fn rescan_speakers(state: State<'_, AppState>, id: Option<String>) -> Result<Value, String> {
    let root = state.root.clone(); work(move || speakers::rescan(&root,id.as_deref())).await
}
#[tauri::command]
async fn label_speakers(state: State<'_, AppState>, label: speakers::Label) -> Result<Value, String> {
    let root = state.root.clone(); work(move || speakers::label(&root,&label)).await
}
#[tauri::command]
async fn import_media(state: State<'_, AppState>, paths: Vec<String>, category: Option<String>) -> Result<usize, String> {
    let root = state.root.clone();
    work(move || db::import_files_in_category(&root, &paths, category.as_deref().unwrap_or("personal"))).await
}
#[tauri::command]
async fn speech_status(state: State<'_, AppState>) -> Result<Value, String> {
    let runtime = state.runtime.for_root(&state.root);
    work(move || Ok(runtime.status())).await
}
#[tauri::command]
async fn speech_setup_status(state: State<'_, AppState>) -> Result<speech_setup::Status,String> {
    let root=state.root.clone();let control=state.speech_setup.clone();work(move||Ok(speech_setup::status(&root,&control))).await
}
#[tauri::command]
fn speech_setup_start(state: State<'_, AppState>) -> Result<(),String> {
    speech_setup::start(state.root.clone(),state.runtime.clone(),state.speech_setup.clone(),state.pipeline.clone()).map_err(|e|format!("{e:#}"))
}
#[tauri::command]
fn speech_setup_cancel(state: State<'_, AppState>) {state.speech_setup.process.cancel();}
#[tauri::command]
async fn transcribe(
    state: State<'_, AppState>,
    id: String,
    device: String,
) -> Result<String, String> {
    let root=state.root.clone();let control=state.pipeline.clone();
    work(move || pipeline::enqueue_one(&root,&control,id,device)).await
}
#[tauri::command]
fn cancel_transcription(state: State<'_, AppState>) {
    // The active item is cancelled persistently; the rest of the queue remains paused.
    let _=pipeline::action(&state.root,&state.pipeline,"stop",None);
}
#[tauri::command]
async fn jobs(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let root = state.root.clone();
    work(move || {
        db::rows(
            &db::open(&root)?,
            "SELECT * FROM jobs ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'retry' THEN 2 WHEN 'waiting_live' THEN 3 ELSE 4 END,created_at DESC LIMIT 100",
            [],
        )
    })
    .await
}
#[tauri::command]
async fn clear_jobs(state: State<'_, AppState>, id: Option<String>) -> Result<usize, String> {
    let root=state.root.clone(); work(move || db::clear_jobs(&root,id.as_deref())).await
}
#[tauri::command]
async fn research(state: State<'_, AppState>) -> Result<Value, String> {
    let root=state.root.clone(); work(move || research::read(&root)).await
}
#[tauri::command]
async fn delete_note(state: State<'_, AppState>, id:String) -> Result<(),String> {
    let root=state.root.clone(); work(move || research::delete(&root,&id)).await
}
#[tauri::command]
async fn set_note_link(state: State<'_, AppState>, link:research::Link, remove:bool) -> Result<(),String> {
    let root=state.root.clone(); work(move || research::link(&root,&link,remove)).await
}
#[tauri::command]
async fn replace_note_link(state: State<'_, AppState>, previous:research::Link, next:research::Link) -> Result<(),String> {
    let root=state.root.clone(); work(move || research::replace_link(&root,&previous,&next)).await
}
#[tauri::command]
async fn rename_note_tag(state: State<'_, AppState>, from:String, to:Option<String>, descendants:bool) -> Result<usize,String> {
    let root=state.root.clone(); work(move || research::rename_tag(&root,&from,to.as_deref(),descendants)).await
}
#[tauri::command]
async fn save_map_layout(state: State<'_, AppState>, view:String, nodes:Vec<Value>) -> Result<(),String> {
    let root=state.root.clone(); work(move || research::layout(&root,&view,&nodes)).await
}
#[tauri::command]
async fn document(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let root=state.root.clone();work(move||documents::read(&root,&id)).await
}
#[tauri::command]
async fn import_documents(state: State<'_, AppState>, paths: Vec<String>, category: Option<String>) -> Result<usize, String> {
    let root=state.root.clone();let control=state.documents.clone();work(move||documents::import_in_category(&root,&control,&paths,category.as_deref().unwrap_or("personal"))).await
}
#[tauri::command]
async fn documents_state(state:State<'_,AppState>)->Result<Value,String> {
    let root=state.root.clone();work(move||documents::snapshot(&root)).await
}
#[tauri::command]
async fn documents_sync(state:State<'_,AppState>)->Result<documents::SyncResult,String> {
    let root=state.root.clone();let control=state.documents.clone();work(move||documents::sync(&root,&control,true)).await
}
#[tauri::command]
async fn add_document_root(state:State<'_,AppState>,path:String,label:String)->Result<Value,String> {
    let root=state.root.clone();let control=state.documents.clone();work(move||documents::add_root(&root,&control,&path,&label)).await
}
#[tauri::command]
async fn edit_document_root(state:State<'_,AppState>,id:String,label:Option<String>,enabled:Option<bool>,remove:bool)->Result<(),String> {
    let root=state.root.clone();let control=state.documents.clone();work(move||documents::edit_root(&root,&control,&id,label.as_deref(),enabled,remove)).await
}
#[tauri::command]
async fn edit_document(state:State<'_,AppState>,id:String,starred:Option<bool>,category:Option<String>)->Result<(),String> {
    let root=state.root.clone();work(move||documents::edit(&root,&id,starred,category.as_deref())).await
}
#[tauri::command]
async fn document_asset(app:tauri::AppHandle,state:State<'_,AppState>,id:String,relative:String)->Result<String,String> {
    let root=state.root.clone();work(move||{
        let path=documents::resolve(&root,&id,&relative)?;
        let ext=path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        anyhow::ensure!(["png","jpg","jpeg","gif","webp","avif","svg","bmp"].contains(&ext.as_str()),"Choose an image in this document folder");
        anyhow::ensure!(path.metadata()?.len()<=20*1024*1024,"Image exceeds 20 MiB");
        app.asset_protocol_scope().allow_file(&path)?;Ok(path.to_string_lossy().into_owned())
    }).await
}
#[tauri::command]
async fn document_link(state:State<'_,AppState>,id:String,relative:String)->Result<String,String> {
    let root=state.root.clone();work(move||{
        let path=documents::resolve(&root,&id,&relative)?;
        let db=db::open(&root)?;
        db.query_row("SELECT id FROM docs WHERE path=?1",[path.to_string_lossy().as_ref()],|r|r.get(0)).context("Linked document is not indexed; refresh the document folder")
    }).await
}
#[tauri::command]
async fn save_note(state: State<'_, AppState>, note:research::Note) -> Result<String,String> {
    let root=state.root.clone(); work(move || research::save(&root,&note)).await
}
#[tauri::command]
async fn link_notes(state: State<'_, AppState>, source:String, target:String) -> Result<(),String> {
    let root=state.root.clone();work(move || research::link(&root,&research::Link{source,target,kind:"related".into(),..Default::default()},false)).await
}
#[tauri::command]
async fn transcript_text(state: State<'_, AppState>, id: String, start: f64, end: f64, format: String) -> Result<String, String> {
    let root = state.root.clone();
    work(move || Ok(export::render(&export::excerpt(&root, &id, start, end)?, export::TextFormat::parse(&format)?))).await
}
#[tauri::command]
async fn export_transcript(
    state: State<'_, AppState>,
    id: String,
    start: f64,
    end: f64,
    format: String,
    dest: String,
) -> Result<String, String> {
    let root = state.root.clone();
    work(move || {
        let path = export::export_transcript(&root, &id, start, end, export::TextFormat::parse(&format)?, Path::new(&dest))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}
#[tauri::command]
async fn export_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    start: f64,
    end: f64,
    format: String,
    dest: String,
) -> Result<String, String> {
    let (root, control) = (state.root.clone(), state.export.clone());
    work(move || {
        let _busy = match control.busy.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => anyhow::bail!("Another export is still running"),
        };
        control.cancel.store(false, Ordering::SeqCst);
        let format = export::MediaFormat::parse(&format)?;
        let path = export::export_media(&root, &id, start, end, format, Path::new(&dest), &control.cancel, |f| {
            let _ = app.emit("export-progress", f);
        })?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}
#[tauri::command]
fn cancel_export(state: State<'_, AppState>) {
    state.export.cancel.store(true, Ordering::SeqCst);
}
#[tauri::command]
async fn waveform(state: State<'_, AppState>, id: String) -> Result<Vec<f32>, String> {
    let root = state.root.clone();
    work(move || waveform::peaks(&root, &id)).await
}
#[tauri::command]
async fn open_external(url:String)->Result<(),String>{work(move||system::open_external(&url)).await}
#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    work(move || system::reveal(Path::new(&path))).await
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
      .on_page_load(|_webview, _payload| {
        #[cfg(debug_assertions)]
        smoke::on_load(_webview, _payload);
      })
      .setup(move |app| {
        health::backup::apply_pending(&root)?;
        let db = db::open(&root)?;
        if let Err(e)=health::legacy::seed(&root){runtime_log::push("warn",&format!("Additional legacy metadata import: {e:#}"));}
        if let Err(e)=legacy_research::seed(&root){runtime_log::push("warn",&format!("Extended research import: {e:#}"));}
        db.execute("UPDATE maintenance_jobs SET status='interrupted',message='Concord closed before the repair finished. Run it again to resume.' WHERE status='running'",[])?;
        runtime_log::push("info",concat!("Concord Next ",env!("CARGO_PKG_VERSION")," started"));
        db.execute("UPDATE jobs SET status='interrupted',message='Concord closed before processing finished; the previous transcript is preserved.' WHERE status='running'", [])?;
        ai::builtin::initialize(app.path().resource_dir()?);
        pipeline::download::initialize(app.path().resource_dir()?);
        db.execute("UPDATE ai_jobs SET status='interrupted',message='Concord closed before indexing finished. Update index to resume.' WHERE status='running'",[])?;
        if let Err(e)=documents::seed_legacy(&root){runtime_log::push("warn",&format!("Legacy document folders: {e:#}"));}
        let docs_control=Arc::new(documents::Control::default());
        documents::start(root.clone(),docs_control.clone());
        let runtime=speech::Runtime::resolve(app.path().resource_dir().ok());
        let pipeline=Arc::new(pipeline::Control::new(control.clone()));
        if let Err(e)=pipeline::sources::seed(&root){runtime_log::push("warn",&format!("Legacy download setup: {e:#}"));}
        pipeline::recover(&root)?;
        pipeline::launch(root.clone(),runtime.clone(),pipeline.clone());
        app.manage(AppState {
            speech_setup: Arc::new(speech_setup::Control::default()),
            pipeline,
            documents: docs_control,
            ai: Arc::new(ai::Control::default()),
            maintenance: Arc::new(health::Control::default()),
            root: root.clone(),
            runtime,
            thumbnail_generator: Arc::new(std::sync::Mutex::new(())),
            playback: Arc::new(playback::Playback::start()?),
            export: Arc::new(export::ExportControl::default()),
        });
        // Config has create=false: construct the window after state is ready, with
        // clipboard access so asynchronous transcript copying also works in WebKitGTK.
        let window_config = app.config().app.windows.first().context("Missing main window configuration")?;
        tauri::WebviewWindowBuilder::from_config(app, window_config)?.enable_clipboard_access().build()?;
        Ok(())
      })
      .invoke_handler(tauri::generate_handler![speech_setup_status,speech_setup_start,speech_setup_cancel,pipeline_save_source,pipeline_remove_source,pipeline_check,pipeline_stop_check,pipeline_tools,pipeline_state,pipeline_candidates,pipeline_enqueue,pipeline_action,pipeline_save_config,documents_state,documents_sync,add_document_root,edit_document_root,edit_document,document_asset,document_link,open_external,archive_status,archive_jobs,archive_audit,archive_last_audit,archive_repair,archive_cancel_repair,archive_verify_embedding,archive_create_backup,archive_validate_backup,archive_stage_restore,archive_cancel_restore,runtime_logs,ai_config,ai_save_provider,ai_models,ai_check,ai_status,ai_index,ai_cancel_index,ai_clear_index,research_search,search_filters,ai_conversations,ai_create_chat,ai_read_chat,ai_edit_chat,ai_send,ai_cancel_chat,ai_star_message,ai_summary,ai_suggest_tags,unidentified_speakers,edit_speaker,delete_speaker,merge_speakers,rescan_speakers,label_speakers,overview,import_legacy,library,recording,media_file,thumbnail_file,search,palette,set_category,set_starred,set_review,save_position,speakers,speaker_appearances,set_speaker_notes,assign_speaker,import_media,speech_status,transcribe,cancel_transcription,jobs,clear_jobs,research,delete_note,set_note_link,replace_note_link,rename_note_tag,save_map_layout,document,import_documents,save_note,link_notes,transcript_text,export_transcript,export_media,cancel_export,waveform,reveal_path])
      .build(tauri::generate_context!()).expect("Cannot launch Concord Next")
      .run(move|app,event|{if matches!(event,tauri::RunEvent::ExitRequested{..}|tauri::RunEvent::Exit){closing.cancel();if let Some(state)=app.try_state::<AppState>() {state.pipeline.shutdown();state.speech_setup.process.cancel();state.ai.cancel_index.store(true,Ordering::SeqCst);state.maintenance.cancel.store(true,Ordering::SeqCst);for cancel in state.ai.chats.lock().unwrap().values(){cancel.store(true,Ordering::SeqCst);}}ai::builtin::stop();}});
}
