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
const handlers: Record<string, (a: any) => unknown> = {
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
