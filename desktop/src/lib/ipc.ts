import { invoke, isTauri, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  Overview,
  LibraryFilter,
  LibraryPage,
  Recording,
  SearchHit,
  PaletteResults,
  Speaker,
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
  available: () => transport.available(),
  version: () => transport.version(),
  overview: () => call<Overview>("overview"),
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
  assignSpeaker: (id: string, local: string, name: string) => call<void>("assign_speaker", { id, local, name }),
  importMedia: (paths: string[]) => call<number>("import_media", { paths }),
  speechStatus: () => call<Runtime>("speech_status"),
  transcribe: (id: string, device: string) => call<string>("transcribe", { id, device }),
  cancelTranscription: () => call<void>("cancel_transcription"),
  jobs: () => call<Job[]>("jobs"),
  research: () => call<Research>("research"),
  document: (id: string) => call<DocumentBody>("document", { id }),
  importDocuments: (paths: string[]) => call<number>("import_documents", { paths }),
  saveNote: (note: Note) => call<string>("save_note", { note }),
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
