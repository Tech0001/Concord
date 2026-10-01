// Dev-only host that answers IPC commands from synthetic fixtures (open with ?mock).
import { api, setTransport, type Transport } from "../lib/ipc.ts";
import type { LibraryFilter, Note, ReviewState } from "../lib/types.ts";
import * as fx from "./fixtures.ts";

const delay = <T>(value: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(value), ms));
const listeners = new Map<string, Set<(p: unknown) => void>>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload));

const DEFAULT_FILTER: LibraryFilter = {
  query: "",
  channel: "",
  kind: "",
  transcribed: "",
  starred: false,
  review: "",
  sort: "newest",
  offset: 0,
  limit: 60,
};

function library(f: LibraryFilter) {
  const q = f.query.trim().toLowerCase();
  let items = fx.mediaList.filter(
    (m) =>
      (!q || m.title.toLowerCase().includes(q) || m.channel.toLowerCase().includes(q)) &&
      (!f.channel || m.channel === f.channel) &&
      (!f.kind || m.kind === f.kind) &&
      (!f.transcribed || (f.transcribed === "yes") === !!m.transcript) &&
      (!f.starred || !!m.starred) &&
      (!f.review || m.review_state === f.review),
  );
  type M = (typeof items)[number];
  const by: Record<string, (a: M, b: M) => number> = {
    newest: (a, b) => b.date.localeCompare(a.date),
    oldest: (a, b) => a.date.localeCompare(b.date),
    opened: (a, b) => (b.opened_at ?? "").localeCompare(a.opened_at ?? ""),
    words: (a, b) => b.words - a.words,
    title: (a, b) => a.title.localeCompare(b.title),
    longest: (a, b) => b.duration - a.duration,
  };
  items = [...items].sort(by[f.sort] ?? by.newest);
  return {
    items: items.slice(f.offset, f.offset + f.limit),
    total: items.length,
    transcribed: items.filter((m) => m.transcript).length,
    channels: [...new Set(fx.mediaList.map((m) => m.channel))].sort().map((channel) => ({ channel })),
  };
}

const find = (id: string) => fx.mediaList.find((m) => m.id === id);

// Handlers receive the IPC argument object; `any` keeps this dev shim short.
const mockCoverage = (covered:number,total=42) => ({covered,total});
const mockArchive = () => ({pipeline:{running:false,active:0,queued:1,retry:1,failed:0},generatedAt:String(Date.now()),archive:{total:48,complete:42,hours:185,pending:6,failed:0,words:180000},coverage:{transcripts:mockCoverage(42),fts:mockCoverage(40),segments:18750,embeddings:mockCoverage(35),summaries:mockCoverage(28),diarization:mockCoverage(40),documents:mockCoverage(4,4),documentEmbeddings:mockCoverage(3,4)},speakers:{total:9,unidentified:6},documents:{starred:1,personal:3,work:1},channels:[{id:"mock-channel",name:"Tuesday Study",enabled:1,diarize:1,include_shorts:0,total:48,complete:42,pending:6,failed:0,embedded:35,summarized:28,diarized:40}],embedding:{model:"Qwen3-Embedding-0.6B-Q8_0",dimensions:1024,enabled:true},chat:{configured:false,model:""},jobs:[],aiJobs:[],restorePending:false});
const mockAudit = () => ({generatedAt:String(Date.now()),errors:0,warnings:2,databaseBytes:195000000,mediaBytes:43700000000,issues:[{id:"stale-fts",category:"transcripts",severity:"warning",title:"Stale transcript search index",description:"Transcript files changed or have not reached full-text search yet.",count:2,items:[{id:"rec-01",title:"Harbour conversation",kind:"recording",detail:"Search index needs rebuilding"}],repair:"reindex"}]});
const handlers: Record<string, (a: any) => unknown> = {
  pipeline_state: () => ({ running: false, checking:false, overview:{dailyDownloads:9,dailyLimit:200,atDailyLimit:false}, sources:[{id:"mock-source",name:"Tuesday Study",kind:"youtube",url:"https://www.youtube.com/@TuesdayStudy",enabled:1,diarize:1,include_shorts:0,category:"personal",last_check:0,check_status:"complete",check_message:"2 new recordings queued",recordings:48}], config: {device:"auto",retries:2,retryMinutes:5,downloadDirectory:"",quality:"1080",codec:"any",audioLanguage:"en",audioOnly:false,speed:"conservative",rateMib:3,dailyLimit:200,checkMinutes:1440,automaticChecks:false,cookiesFile:"",cookiesBrowser:"",speechLanguage:"en-US"}, channels:[{channel:"Tuesday Study"}], jobs:fx.mediaList.slice(0,2).map((m,i)=>({id:`queue-${i}`,media_id:m.id,title:m.title,channel:m.channel,path:m.path,status:i?"retry":"queued",message:i?"The media drive disconnected. Reconnect it to resume.":"Waiting in the processing queue",kind:"transcribe",device:"auto",attempts:i,retry_at:Date.now()/1000+300,cancelled:0})) }),
  pipeline_candidates: () => ({total:fx.mediaList.length,eligible:fx.mediaList.length,unavailable:0,alreadyQueued:0,hours:24,items:fx.mediaList}),
  pipeline_enqueue: () => ({added:2,ids:["test"],unavailable:0,alreadyQueued:0}),
  pipeline_action: () => undefined,
  pipeline_save_config: () => undefined,
  pipeline_tools: () => ({ready:true,version:"2026.08.19"}),
  documents_state: () => ({roots:[{id:"study",label:"Research",path:"/home/you/Documents/Research",enabled:1,connected:true},{id:"work",label:"Work",path:"/home/you/Documents/Work",enabled:1,connected:true}],docs:fx.docsList.map((d,i)=>({...d,root_id:i<3?"study":"work",relative:(i<3?"study/":"references/")+d.title+".md",path:"/home/you/Documents/"+d.title+".md",starred:i===0?1:0,category:i<3?"personal":"work"}))}),
  documents_sync: () => ({added:0,updated:0,missing:0,unchanged:5,errors:[]}),
  edit_document: () => undefined,
  open_external: () => undefined,
  archive_status: mockArchive,
  archive_jobs: () => ({jobs:[],aiJobs:[]}),
  archive_last_audit: mockAudit,
  archive_audit: mockAudit,
  runtime_logs: ({after}) => after ? [] : [{id:1,timestamp:Date.now(),level:"info",message:"Concord Next started"},{id:2,timestamp:Date.now(),level:"info",message:"Archive audit completed: 0 errors, 2 warnings"}],
  ai_config: () => ({ embedding: { enabled: true, kind: "builtin", model: "Qwen3-Embedding-0.6B-Q8_0", baseUrl: "http://127.0.0.1", hasKey: false, local: true }, chat: { enabled: false, kind: "local", model: "", baseUrl: "http://127.0.0.1:11434/v1", hasKey: false, local: true } }),
  ai_status: () => ({ modelReady: true, indexed: 0, total: fx.mediaList.length, chunks: 0, dimensions: null, job: null }),
  ai_summary: () => null,
  search_filters: () => ({ channels: [], speakers: [], tags: [] }),
  research_search: ({ query }) => fx.searchHits(query).map((h: any) => ({ ...h, kind: "recording", score: 1 })),
  overview: () => ({
    media: fx.mediaList.length,
    speakers: fx.speakerList.length,
    notes: fx.notesList.length,
    docs: fx.docsList.length,
    dataRoot: "/home/you/.local/share/concord-next",
    legacyDatabase: "/home/you/.local/share/concord/pipeline.db",
  }),
  library: ({ filter }) => library({ ...DEFAULT_FILTER, ...filter }),
  recording: ({ id }) => fx.recordingFor(id),
  media_file: () => fx.silentWav(600),
  thumbnail_file: ({ id }) => fx.thumbnailFor(id),
  search: ({ query }) => fx.searchHits(query),
  palette: ({ query }) => fx.paletteFor(query),
  speakers: () => fx.speakerList,
  unidentified_speakers: () => [],
  rescan_speakers: () => ({ matched: 0, recordings: 0 }),
  clear_jobs: () => 0,
  edit_speaker: ({ id, name, color, noise }) => {
    const speaker = fx.speakerList.find(s => s.id === id);
    if (speaker) Object.assign(speaker, { name, color, is_noise: noise ? 1 : 0 });
  },
  delete_speaker: ({ id }) => { const index = fx.speakerList.findIndex(s => s.id === id); if (index >= 0) fx.speakerList.splice(index,1); },
  merge_speakers: () => ({ matched: 0, recordings: 0 }),
  label_speakers: () => ({ matched: 0, recordings: 0 }),
  speaker_appearances: ({ id }) => fx.appearancesFor(id),
  set_speaker_notes: ({ id, notes }) => {
    const s = fx.speakerList.find((x) => x.id === id);
    if (s) s.notes = notes.trim() || null;
  },
  research: () => ({
    notes: fx.notesList,
    links: [
      {
        source: fx.notesList[0].id,
        target: fx.notesList[1].id,
        kind: "related",
      },
    ],
    docs: fx.docsList,
  }),
  document: ({ id }) => ({
    id,
    title: fx.docsList.find((d) => d.id === id)?.title ?? "Document",
    body: fx.docBody(id),
  }),
  jobs: () => [
    {
      id: "j1",
      media_id: fx.mediaList[3].id,
      title: fx.mediaList[3].title,
      status: "running",
      message: "Transcribing · 42%",
    },
    {
      id: "j0",
      media_id: fx.mediaList[8].id,
      title: fx.mediaList[8].title,
      status: "complete",
      message: "Transcript saved",
    },
  ],
  speech_setup_status: () => ({status:"",message:"",details:""}),
  speech_setup_start: () => undefined,
  speech_setup_cancel: () => undefined,
  speech_status: () => ({
    ready: true,
    device: "vulkan:0",
    gpu: "NVIDIA GeForce RTX 2080 Ti",
    modelsReady: true,
    voiceMatchingReady: true,
    model: "nemotron",
    models: "",
    python: "",
  }),
  waveform: ({ id }) => fx.peaksFor(id),
  set_starred: ({ id, starred }) => {
    const m = find(id);
    if (m) m.starred = starred ? 1 : 0;
  },
  set_review: ({ id, stateName, state }) => {
    const m = find(id);
    if (m) m.review_state = (stateName ?? state) as ReviewState;
  },
  save_position: ({ id, seconds }) => {
    const m = find(id);
    if (m) {
      m.position = seconds;
      m.opened_at = new Date().toISOString();
    }
  },
  save_note: ({ note }: { note: Note }) => {
    const id = note.id ?? `note-${Date.now()}`;
    const existing = fx.notesList.find((n) => n.id === id);
    if (existing) Object.assign(existing, note);
    else
      fx.notesList.unshift({
        ...note,
        id,
        created_at: new Date().toISOString(),
      });
    return id;
  },
  transcript_text: () => "Harbour conversation\nTuesday Study · 2025-09-02 · 1:05–1:40\n\n[1:05] Ada Marsh: Mock transcript text.",
  export_media: async ({ dest }) => {
    for (let i = 1; i <= 10; i++) {
      await delay(null, 120);
      emit("export-progress", i / 10);
    }
    return dest;
  },
  export_transcript: ({ dest }) => dest,
  transcribe: () => "job",
  import_media: () => 0,
};

export function installMock(): void {
  const transport: Transport = {
    available: () => true,
    call: async (command, args) => {
      const handler = handlers[command];
      const value = new URLSearchParams(location.search).get(`delay.${command}`);
      const ms = value === null ? 120 : Math.max(0, Math.min(10000, Number(value) || 0));
      await delay(null, ms);
      return (handler ? await handler(args ?? {}) : null) as never;
    },
    listen: async (event, handler) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (p: unknown) => void);
      listeners.set(event, set);
      return () => {
        set.delete(handler as (p: unknown) => void);
      };
    },
    fileUrl: (path) => path,
    pickFiles: async () => [],
    pickSavePath: async ({ defaultPath }) => `/home/you/Exports/${defaultPath}`,
    version: async () => "0.2.0-dev",
  };
  setTransport(transport);
  Object.assign(window, { __concordMockApi: api });
}
