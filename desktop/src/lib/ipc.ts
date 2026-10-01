import type { PopoutSession, PlaybackPosition, PopoutCommand } from "../player/popout-types.ts";
import type { YouTubeQuery, YouTubeHit, YouTubePage } from "../tools/discover-model.ts";
import type { ToolsState } from "../tools/types.ts";
import type { FileAction, RecordingFileInfo } from "../library/RecordingFileDialog.tsx";
import type { AutomaticAi, SourceInput, PipelineState, PipelineConfig, Batch, Candidates, Enqueued } from "../pipeline/types.ts";
import type { DocumentsState, DocumentSync } from "../documents/types.ts";
import type { ArchiveStatus, Audit, BackupValidation, LogEntry, MaintenanceJob } from "../health/types.ts";
import type { SetupStatus, SetupProgress, Preflight, LocalServer, ModelDownload } from "../setup/types.ts";
import type { ChatGPTStatus, AiConfig, Provider, SearchFilter, ResearchHit, FilterOptions, IndexStatus, Conversation, ChatDetail, SummaryState } from "../ai/types.ts";
import { invoke, isTauri, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  NoteLink,
  MapPosition,
  MatchResult,
  LabelVoice,
  Overview,
  LibraryFilter,
  LibraryPage,
  Recording,
  SearchHit,
  PaletteResults,
  Speaker,
  Appearance,
  Runtime,
  Job,
  Research,
  DocumentBody,
  Note,
  ReviewState,
  TextFormat,
  MediaFormat,
} from "./types.ts";

export type FilePick = { title: string; name: string; extensions: string[]; multiple: boolean };
export type SavePick = { title: string; name: string; extensions: string[]; defaultPath: string };

/** Everything the UI needs from its host. Tauri today; an HTTP transport can implement the same shape. */
export type Transport = {
  available(): boolean;
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  fileUrl(path: string): string;
  pickFiles(options: FilePick): Promise<string[]>;
  pickSavePath(options: SavePick): Promise<string | null>;
  version(): Promise<string>;
  pickFolder?(title?: string): Promise<string | null>;
};

const tauriTransport: Transport = {
  available: () => isTauri(),
  call: (command, args) => invoke(command, args),
  listen: (event, handler) => listen(event, (e) => handler(e.payload as never)),
  fileUrl: (path) => convertFileSrc(path),
  async pickFiles({ title, name, extensions, multiple }) {
    const result = await open({ title, multiple, filters: [{ name, extensions }] });
    return result == null ? [] : Array.isArray(result) ? result : [result];
  },
  pickSavePath: ({ title, name, extensions, defaultPath }) =>
    save({ title, defaultPath, filters: [{ name, extensions }] }),
  version: () => getVersion(),
  pickFolder: async (title = "Choose folder") => { const path = await open({ title, directory: true, multiple: false }); return typeof path === "string" ? path : null; },
};

let transport: Transport = tauriTransport;
export function setTransport(next: Transport) {
  transport = next;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await transport.call<T>(command, args);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}

export const MEDIA_EXTENSIONS = ["mp4", "mkv", "webm", "mov", "ogg", "wav", "mp3", "m4a", "flac", "aac", "opus"];

export const api = {
  chatgptStatus: () => call<ChatGPTStatus>("chatgpt_status"),
  chatgptStart: (accountId:string|null,consent=false) => call<void>("chatgpt_start",{accountId,consent}),
  chatgptCancel: () => call<void>("chatgpt_cancel"),
  chatgptSignOut: (id:string) => call<string>("chatgpt_sign_out",{id}),
  chatgptAcknowledge: (id:string) => call<void>("chatgpt_acknowledge",{id}),
  popoutState: () => call<PopoutSession | null>("popout_state"),
  popoutOpen: (id:string,position:PlaybackPosition,skipGaps:boolean) => call<PopoutSession>("popout_open",{id,position,skipGaps}),
  popoutUpdate: (token:string,position:PlaybackPosition) => call<void>("popout_update",{token,position}),
  popoutCommand: (token:string,command:PopoutCommand) => call<void>("popout_command",{token,command}),
  popoutClose: (resume:boolean) => call<void>("popout_close",{resume}),
  popoutFocus: () => call<void>("popout_focus"),
  onPopoutState: (handler:(session:PopoutSession)=>void) => transport.listen("concord-popout-state",handler),
  onPopoutClosed: (handler:(session:PopoutSession)=>void) => transport.listen("concord-popout-closed",handler),
  onPopoutReturn: (handler:(value:{token:string;resume:boolean})=>void) => transport.listen("concord-popout-return",handler),
  onPopoutCommand: (handler:(value:{token:string;command:PopoutCommand})=>void) => transport.listen("concord-popout-command",handler),
  youtubeStatus: () => call<{hasKey:boolean}>("youtube_status"),
  youtubeSaveKey: (key:string) => call<{hasKey:boolean}>("youtube_save_key",{key}),
  youtubeSearch: (query:YouTubeQuery) => call<YouTubePage>("youtube_search",{query}),
  youtubeQueue: (hit:YouTubeHit,category:string) => call<{id:string;action:"queued"|"existing"|"alreadyQueued"}>("youtube_queue",{hit,category}),
  toolsState: () => call<ToolsState>("tools_state"),
  toolsExtract: (source:string,destination:string,format:string) => call<void>("tools_extract",{source,destination,format}),
  toolsCancelExtract: () => call<void>("tools_cancel_extract"),
  recorderLiveStart: (id:string,device:string) => call<void>("recorder_live_start",{id,device}),
  recorderLiveStop: () => call<void>("recorder_live_stop"),
  recorderInputs: () => call<{inputs:{id:string;name:string}[];warning:string}>("recorder_inputs"),
  recorderStart: (input:string,title:string,category:string) => call<string>("recorder_start",{input,title,category}),
  recorderStop: () => call<void>("recorder_stop"),
  recorderPreview: (id:string) => call<string>("recorder_preview",{id}),
  recorderDiscard: (id:string) => call<void>("recorder_discard",{id}),
  recorderSave: (id:string,title:string,category:string,transcribe:boolean,device:string) => call<{id:string;warning:string}>("recorder_save",{id,title,category,transcribe,device}),
  recordingFileInfo: (id:string) => call<RecordingFileInfo>("recording_file_info",{id}),
  recordingFileAction: (id:string,action:Exclude<FileAction,"title">,value:string) => call<RecordingFileInfo>("recording_file_action",{id,action,value}),
  setRecordingTitle: (id:string,title:string) => call<void>("set_recording_title",{id,title}),
  pickRecordingFile: async () => (await transport.pickFiles({title:"Locate recording file",name:"Audio and video",extensions:MEDIA_EXTENSIONS,multiple:false}))[0] ?? null,
  setCategory: (id:string,category:"personal"|"work") => call<void>("set_category",{id,category}),
  pipelineSaveSource: (source: SourceInput) => call<string>("pipeline_save_source", { source }),
  pipelineRemoveSource: (id: string) => call<void>("pipeline_remove_source", { id }),
  pipelineCheck: (id?: string, full = false, category = "") => call<void>("pipeline_check", { id, full, category }),
  pipelineStopCheck: () => call<void>("pipeline_stop_check"),
  pipelineTools: () => call<{ ready: boolean; version?: string; error?: string }>("pipeline_tools"),
  pipelineState: () => call<PipelineState>("pipeline_state"),
  pipelineAiState: () => call<AutomaticAi>("pipeline_ai_state"),
  pipelineAiSave: (embedding: boolean, summary: boolean) => call<AutomaticAi>("pipeline_ai_save", { embedding, summary }),
  pipelineAiAction: (id: string, action: "cancel" | "retry") => call<void>("pipeline_ai_action", { id, action }),
  pipelineCandidates: (batch: Batch) => call<Candidates>("pipeline_candidates", { batch }),
  pipelineEnqueue: (batch: Batch, start: boolean) => call<Enqueued>("pipeline_enqueue", { batch, start }),
  pipelineAction: (action: string, id?: string) => call<void>("pipeline_action", { action, id }),
  pipelineSaveConfig: (config: PipelineConfig) => call<void>("pipeline_save_config", { config }),
  openExternal: (url:string) => call<void>("open_external",{url}),
  documentsState: () => call<DocumentsState>("documents_state"),
  documentsSync: () => call<DocumentSync>("documents_sync"),
  addDocumentRoot: (path:string,label:string) => call<void>("add_document_root",{path,label}),
  editDocumentRoot: (id:string, options:{label?:string;enabled?:boolean;remove?:boolean}) => call<void>("edit_document_root",{id,label:options.label??null,enabled:options.enabled??null,remove:options.remove??false}),
  editDocument: (id:string,options:{starred?:boolean;category?:string})=>call<void>("edit_document",{id,starred:options.starred??null,category:options.category??null}),
  documentAsset: async (id:string,relative:string) => transport.fileUrl(await call<string>("document_asset",{id,relative})),
  documentLink: (id:string,relative:string) => call<string>("document_link",{id,relative}),
  archiveStatus: () => call<ArchiveStatus>("archive_status"),
  archiveAudit: () => call<Audit>("archive_audit"),
  archiveLastAudit: () => call<Audit | null>("archive_last_audit"),
  archiveJobs: () => call<{jobs:MaintenanceJob[];aiJobs:MaintenanceJob[]}>("archive_jobs"),
  archiveRepair: (action:string) => call<string>("archive_repair",{action}),
  archiveCancelRepair: () => call<void>("archive_cancel_repair"),
  archiveVerifyEmbedding: () => call<{dimensions:number;model:string;checkedAt:string}>("archive_verify_embedding"),
  archiveCreateBackup: (folder:string) => call<{path:string;bytes:number}>("archive_create_backup",{folder}),
  archiveValidateBackup: (path:string) => call<BackupValidation>("archive_validate_backup",{path}),
  archiveStageRestore: (path:string) => call<BackupValidation>("archive_stage_restore",{path}),
  archiveCancelRestore: () => call<void>("archive_cancel_restore"),
  runtimeLogs: (after:number) => call<LogEntry[]>("runtime_logs",{after}),
  pickFiles: (options: FilePick) => transport.pickFiles(options),
  pickFolder: (title?: string) => transport.pickFolder ? transport.pickFolder(title) : Promise.resolve(null),
  aiSuggestTags: (text: string) => call<string[]>("ai_suggest_tags", { text }),
  aiConfig: () => call<AiConfig>("ai_config"),
  aiSaveProvider: (task: "embedding" | "chat", provider: Provider, key: string | null) => call<AiConfig>("ai_save_provider", { task, provider, key }),
  /** List models and run one test request without saving anything. */
  aiTryProvider: (task: "embedding" | "chat", provider: Provider, key: string | null) =>
    call<{ models: { id: string; name: string }[]; model: string; message?: string; error?: string }>("ai_try_provider", { task, provider, key }),
  aiModels: (task: "embedding" | "chat") => call<{ id: string; name: string }[]>("ai_models", { task }),
  aiCheck: (task: "embedding" | "chat") => call<{ message: string }>("ai_check", { task }),
  aiStatus: () => call<IndexStatus>("ai_status"),
  aiIndex: () => call<string>("ai_index"),
  aiCancelIndex: () => call<void>("ai_cancel_index"),
  aiClearIndex: () => call<void>("ai_clear_index"),
  researchSearch: (query: string, semantic: boolean, filter: SearchFilter) => call<ResearchHit[]>("research_search", { query, semantic, filter }),
  searchFilters: () => call<FilterOptions>("search_filters"),
  aiConversations: () => call<Conversation[]>("ai_conversations"),
  aiCreateChat: () => call<string>("ai_create_chat"),
  aiReadChat: (id: string) => call<ChatDetail>("ai_read_chat", { id }),
  aiEditChat: (id: string, options: { title?: string; pinned?: boolean; remove?: boolean }) => call<void>("ai_edit_chat", { id, title: options.title ?? null, pinned: options.pinned ?? null, remove: options.remove ?? false }),
  aiSend: (request: { conversationId: string; text: string; useLibrary: boolean; semantic: boolean; filter: SearchFilter }) => call<ChatDetail>("ai_send", { request }),
  aiCancelChat: (id: string) => call<void>("ai_cancel_chat", { id }),
  aiStarMessage: (id: string, starred: boolean) => call<void>("ai_star_message", { id, starred }),
  aiSummaryState: (id:string) => call<SummaryState>("ai_summary_state",{id}),
  aiStartSummary: (id:string) => call<string>("ai_summary_start",{id}),
  aiCancelSummary: (id:string) => call<void>("ai_summary_cancel",{id}),
  onAiDelta: (handler: (delta: { id: string; text: string }) => void) => transport.listen("ai-chat-delta", handler),
  available: () => transport.available(),
  version: () => transport.version(),
  overview: () => call<Overview>("overview"),
  startLibrary: () => call<void>("start_library"),
  importLegacy: (path: string) => call<Overview>("import_legacy", { path }),
  library: (filter: LibraryFilter) => call<LibraryPage>("library", { filter }),
  recording: (id: string) => call<Recording>("recording", { id }),
  mediaUrl: (id: string) => call<string>("media_file", { id }),
  async thumbnail(id: string): Promise<string | null> {
    const path = await call<string | null>("thumbnail_file", { id });
    return path ? transport.fileUrl(path) : null;
  },
  search: (query: string) => call<SearchHit[]>("search", { query }),
  palette: (query: string) => call<PaletteResults>("palette", { query }),
  speakers: () => call<Speaker[]>("speakers"),
  speakerAppearances: (id: string) => call<Appearance[]>("speaker_appearances", { id }),
  setSpeakerNotes: (id: string, notes: string) => call<void>("set_speaker_notes", { id, notes }),
  assignSpeaker: (id: string, local: string, name: string) => call<void>("assign_speaker", { id, local, name }),
  unidentifiedSpeakers: () => call<Appearance[]>("unidentified_speakers"),
  editSpeaker: (id: string, name: string, color: string | null, noise: boolean) => call<void>("edit_speaker", { id, name, color, noise }),
  deleteSpeaker: (id: string) => call<void>("delete_speaker", { id }),
  mergeSpeakers: (source: string, target: string) => call<MatchResult>("merge_speakers", { source, target }),
  rescanSpeakers: (id?: string) => call<MatchResult>("rescan_speakers", { id: id ?? null }),
  labelVoices: (label: LabelVoice) => call<MatchResult>("label_speakers", { label }),
  importMedia: (paths: string[], category = "personal") => call<number>("import_media", { paths, category }),
  importAndQueue: (paths: string[], category: string, device: string) => call<number>("import_and_queue", { paths, category, device }),
  speechStatus: () => call<Runtime>("speech_status"),
  speechSetupStatus: () => call<import("./types.ts").SpeechSetupStatus>("speech_setup_status"),
  speechSetupStart: () => call<void>("speech_setup_start"),
  speechSetupCancel: () => call<void>("speech_setup_cancel"),
  setupStatus: () => call<SetupStatus>("setup_status"),
  setupSave: (patch: Partial<Omit<SetupProgress, "furthest">>) => call<SetupProgress>("setup_save", { patch }),
  setupPreflight: () => call<Preflight>("setup_preflight"),
  setupProbeLocal: () => call<LocalServer[]>("setup_probe_local"),
  speechDevice: () => call<string>("speech_device"),
  setSpeechDevice: (device: string) => call<void>("set_speech_device", { device }),
  aiBuiltinStatus: () => call<ModelDownload>("ai_builtin_status"),
  aiBuiltinPrepare: (afterSpeech: boolean) => call<void>("ai_builtin_prepare", { afterSpeech }),
  aiBuiltinCancel: () => call<void>("ai_builtin_cancel"),
  transcribe: (id: string, device: string) => call<string>("transcribe", { id, device }),
  cancelTranscription: () => call<void>("cancel_transcription"),
  clearJobs: (id?: string) => call<number>("clear_jobs", { id: id ?? null }),
  jobs: () => call<Job[]>("jobs"),
  research: () => call<Research>("research"),
  document: (id: string) => call<DocumentBody>("document", { id }),
  importDocuments: (paths: string[], category = "personal") => call<number>("import_documents", { paths, category }),
  saveNote: (note: Note) => call<string>("save_note", { note }),
  deleteNote: (id: string) => call<void>("delete_note", { id }),
  setNoteLink: (link: NoteLink, remove = false) => call<void>("set_note_link", { link: { source_anchor: "", target_anchor: "", source_handle: null, target_handle: null, note: "", ...link }, remove }),
  renameNoteTag: (from: string, to: string | null, descendants = false) => call<number>("rename_note_tag", { from, to, descendants }),
  replaceNoteLink: (previous: NoteLink, next: NoteLink) => call<void>("replace_note_link", { previous, next }),
  saveMapLayout: (view: string, nodes: Omit<MapPosition, "view">[]) => call<void>("save_map_layout", { view, nodes }),
  linkNotes: (source: string, target: string) => call<void>("link_notes", { source, target }),
  setStarred: (id: string, starred: boolean) => call<void>("set_starred", { id, starred }),
  setReview: (id: string, state: ReviewState) => call<void>("set_review", { id, stateName: state }),
  savePosition: (id: string, seconds: number) => call<void>("save_position", { id, seconds }),
  transcriptText: (id: string, start: number, end: number, format: TextFormat) =>
    call<string>("transcript_text", { id, start, end, format }),
  exportTranscript: (id: string, start: number, end: number, format: TextFormat, dest: string) =>
    call<string>("export_transcript", { id, start, end, format, dest }),
  exportMedia: (id: string, start: number, end: number, format: MediaFormat, dest: string) =>
    call<string>("export_media", { id, start, end, format, dest }),
  cancelExport: () => call<void>("cancel_export"),
  waveform: (id: string) => call<number[]>("waveform", { id }),
  reveal: (path: string) => call<void>("reveal_path", { path }),
  onExportProgress: (handler: (fraction: number) => void) => transport.listen<number>("export-progress", handler),
  pickMedia: () =>
    transport.pickFiles({ title: "Add recordings", name: "Audio and video", extensions: MEDIA_EXTENSIONS, multiple: true }),
  pickDatabase: () =>
    transport.pickFiles({
      title: "Choose your Concord library database",
      name: "Concord library",
      extensions: ["db", "sqlite", "sqlite3"],
      multiple: false,
    }),
  pickDocuments: () =>
    transport.pickFiles({ title: "Add documents", name: "Text and Markdown", extensions: ["md", "txt", "markdown"], multiple: true }),
  pickSavePath: (options: SavePick) => transport.pickSavePath(options),
};
