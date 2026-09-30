# Concord Next Delivery 1 (Foundation, Polish, Player Ranges) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Concord Next's interface on a themeable, phone-ready design system. Bring the Library and player to Electron parity plus polish, including line-level range selection, loop, copy, export, and save-as-note.

**Architecture:**
- **Frontend layout:** the React frontend (`desktop/src`) is split into feature folders on top of a small primitives layer (`ui/`), a tweakcn-compatible token theme (`theme/`), and a typed IPC seam (`lib/ipc.ts`) with no direct `invoke` calls in screens.
- **Pure logic:** range math, formatting, and routing live in dependency-free `lib/*.ts` files with `node --test` tests.
- **Backend:** Rust (`desktop/src-tauri`) gains a versioned migration, filterable library queries, and state commands. It also gains an `export` module (ffmpeg media and text export), a `waveform` module, and a `system` module (show in folder).

**Tech Stack:** Tauri 2, Rust (rusqlite, serde_json, anyhow), React 19, TypeScript 5.6, Vite 8, Radix Dialog/Popover/Select, cmdk, lucide-react, ffmpeg/ffprobe, Node 26 `node --test`, headless Chromium over CDP for screenshots.

**Spec:** `docs/superpowers/specs/2026-09-30-next-foundation-polish-design.md`

## Global Constraints

- Branch `rewrite/rust-tauri`. Never stage `.aws`. Commit messages are descriptive sentences in the repo's style, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- New npm packages are limited to `@radix-ui/react-dialog@1.1.15`, `@radix-ui/react-popover@1.1.15`, `@radix-ui/react-select@2.2.6`, and `cmdk@1.1.1`, all exact versions already in the root lockfile. No other new npm packages.
- No new Rust crates.
- Fonts are vendored woff2 (Inter, Source Serif 4, JetBrains Mono) under OFL. No network fonts.
- Screens never import `@tauri-apps/*` directly; only `lib/ipc.ts` does.
- App CSS reads colors only from tokens. Literal colors appear only in `theme/*.css` and `lib/speakers.ts`.
- Token names follow tweakcn: `--background --foreground --card --card-foreground --popover --popover-foreground --primary --primary-foreground --secondary --secondary-foreground --muted --muted-foreground --accent --accent-foreground --destructive --destructive-foreground --border --input --ring --sidebar --sidebar-foreground --sidebar-primary --sidebar-primary-foreground --sidebar-accent --sidebar-accent-foreground --sidebar-border --sidebar-ring --chart-1..5 --font-sans --font-serif --font-mono --radius`.
- Brand palette: navy `#1B2230`, amber `#E0A24B`, cream `#EFEBE3`. Dark is the default mode.
- Breakpoints:
  - Phone: `<640px`, with a bottom tab bar.
  - Tablet: `640–899px`; the player stacks.
  - Icon rail: `900–1199px`.
  - Full: `≥1200px`.
  - Coarse pointers get ≥44px hit targets. No hover-only controls on touch.
- Keyboard shortcuts never fire while typing in a field or while a dialog is open. Every action is also reachable through visible controls.
- Range export formats:
  - Media: `m4a` (AAC 160k), `mp3` (libmp3lame q2), `mp4-fast` (video stream copy with AAC audio), `mp4-accurate` (libx264 veryfast crf 20 with AAC 160k).
  - Text: `txt`, `md`, `srt`.
  - Accurate is the default for video.
- Library page sizes: 60/120/240. Sorts: `newest|oldest|opened|words|title|longest`. Review states: `unreviewed|in_review|reviewed`.
- The user's installed Concord Next and the original Concord are never overwritten while running. Install only via `scripts/install-next-local.sh`, which swaps the AppImage atomically.
- Private data (recordings, transcripts, library DB) is never committed. The mock fixtures are synthetic.

## Review Focus

1. **Missing media, such as a disconnected drive.** The player shows a quiet inline state. Media export returns "Media unavailable. Reconnect its drive or import a copy." Transcript export and copy still work, and the waveform fails quietly. Tests: Task 9 `exports_real_media_ranges` (missing-file assertion) and `waveform_errors_for_missing_media`.
2. **Awkward titles in export file names** (slashes, quotes, colons, emoji, 300-character titles, titles made only of dots). They must produce a valid, bounded, readable name. Test: Task 1 `safeFileName` cases.
3. **Recordings without a transcript, speakers, or segments.** The timeline, range tools, and text export must not crash; an empty excerpt renders its header only. Tests: Task 8 `speakerTurns`/`linesIn` empties, and Task 9 `empty_excerpt_renders_header_only`.
4. **Media IDs such as `["UC-x","a/b?c#d"]`** (JSON arrays with quotes, slashes, `?` and `#`) passed through hash routes and IPC. They must round-trip exactly. Test: Task 5 router round-trip.
5. **Shortcuts versus typing, and ranges out of bounds.** Typing "i" in Find must not set a range start, and Space on a focused button must not also toggle play. Dragged handles past the ends or crossed over each other must clamp to a valid range. Tests: Task 8 `isTypingTarget`/`isInteractiveTarget` and `clampRange`; Task 9 `rejects_bad_ranges`.

## Conventions used below

- Run commands from the repo root: `/home/pc/Documents/GitHub/Concord`.
- `TS tests`: `pnpm --dir desktop test:ts`, which runs `node --test "src/**/*.test.ts"`. Node 26 runs erasable TypeScript directly, so modules imported by tests use explicit `.ts` import extensions and no `enum`/`namespace`.
- `Rust tests`: `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
- `Build`: `pnpm --dir desktop build`, which runs `tsc --noEmit` and then `vite build`.
- `Screens`:
  1. Start `pnpm --dir desktop dev` in the background.
  2. Run `node desktop/scripts/screens.mjs <outdir> [filter]`.
  3. Open the PNGs with the Read tool.
- **Visual components:** each UI task lists files, props, structure, behaviors, and screenshot acceptance criteria. The executor writes the markup and CSS to match the spec's design direction. Everything with logic has full code here.

## File map

| Path | Responsibility |
|---|---|
| `desktop/src/lib/types.ts` | Shared data types (replaces `src/types.ts`) |
| `desktop/src/lib/ipc.ts` | Transport seam and typed `api` |
| `desktop/src/lib/format.ts` | Time, date, count, and file-name formatting |
| `desktop/src/lib/storage.ts` | Safe localStorage and `useStoredState` |
| `desktop/src/lib/cx.ts` | Class-name join |
| `desktop/src/lib/router.ts` | Hash routes |
| `desktop/src/lib/range.ts` | Line/time/range math, speaker turns, find |
| `desktop/src/lib/timeStore.ts` | Playback-time store (limits re-renders) |
| `desktop/src/lib/shortcuts.ts` | Keyboard shortcut matching and hook |
| `desktop/src/lib/speakers.ts` | Speaker colors and labels |
| `desktop/src/lib/search.ts` | Hit grouping and highlight parsing |
| `desktop/src/lib/clipboard.ts` | Copy text with a fallback |
| `desktop/src/lib/session.ts` | Library order for previous/next |
| `desktop/src/lib/media-query.ts` | `useMediaQuery`, breakpoints |
| `desktop/src/fonts/` | Vendored woff2, `fonts.css`, licenses |
| `desktop/src/theme/` | `concord.css`, `tokens.css`, `base.css`, `scope.ts`, `theme.ts`, `themes/*.css` |
| `desktop/src/ui/` | Button, IconButton, Menu, Dialog/Sheet/ConfirmDialog, Toasts, Select, Segmented, Chip/SpeakerChip, PageHeader, Empty, Kbd, `ui.css` |
| `desktop/src/shell/` | AppContext, Sidebar, TabBar, Topbar, CommandPalette, ActivityPanel, `shell.css` |
| `desktop/src/library/` | LibraryPage, Toolbar, RecordingCard, RecordingRow, Cover, recordingMenu, `library.css` |
| `desktop/src/player/` | PlayerPage, useMedia, MediaStage, Transport, Timeline, Transcript, RangeBar, ExportDialog, SpeakerPanel, ShortcutSheet, `player.css` |
| `desktop/src/search/`, `documents/`, `notes/`, `speakers/`, `map/`, `settings/` | Restyled pages |
| `desktop/src/dev/` | Mock transport, fixtures, UI gallery (dev only) |
| `desktop/scripts/screens.mjs` | CDP screenshot runner |
| `desktop/src-tauri/src/db.rs` | Migration v2, library filter, state commands, palette, search highlight |
| `desktop/src-tauri/src/export.rs` | Excerpt, text rendering, ffmpeg export, export control |
| `desktop/src-tauri/src/waveform.rs` | Audio peaks with cache |
| `desktop/src-tauri/src/system.rs` | Show in folder |
| `desktop/src-tauri/src/lib.rs` | Command wiring |

---

### Task 1: IPC seam, shared types, formatting and storage utilities

**Files:**
- Create: `desktop/src/lib/types.ts`, `desktop/src/lib/ipc.ts`, `desktop/src/lib/format.ts`, `desktop/src/lib/format.test.ts`, `desktop/src/lib/storage.ts`, `desktop/src/lib/cx.ts`
- Modify: `desktop/src/App.tsx`, `desktop/src/views.tsx` (switch to `api`), `desktop/package.json` (script), `desktop/tsconfig.json` (exclude tests)
- Delete: `desktop/src/types.ts`

**Interfaces:**
- Produces:
  - `api` (below), and `Transport` with `setTransport(t)`.
  - The types in `lib/types.ts`.
  - `clock`, `clockPrecise`, `humanDuration`, `prettyDate`, `count`, `rangeLabel`, `safeFileName`, `exportName`, `parseClock`, `initials`, `extension`.
  - `readStored`, `writeStored`, `useStoredState`, and `cx`.

- [ ] **Step 1: Add the TS test script and exclude tests from tsc**

In `desktop/package.json` `scripts` add `"test:ts": "node --test \"src/**/*.test.ts\""`. In `desktop/tsconfig.json` add `"exclude": ["src/**/*.test.ts"]` (tests import `node:test`, and there is no `@types/node` in the desktop package).

- [ ] **Step 2: Write the failing format tests**

`desktop/src/lib/format.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clock, clockPrecise, humanDuration, prettyDate, count, rangeLabel,
  safeFileName, exportName, parseClock, initials, extension,
} from "./format.ts";

test("clock formats minutes and hours and tolerates bad input", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(65.9), "1:05");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(clock(Number.NaN), "0:00");
  assert.equal(clock(-4), "0:00");
  assert.equal(clockPrecise(65.47), "1:05.4");
});

test("human durations and dates", () => {
  assert.equal(humanDuration(42), "42s");
  assert.equal(humanDuration(720), "12m");
  assert.equal(humanDuration(6420), "1h 47m");
  assert.equal(prettyDate("20251022"), "2025-10-22");
  assert.equal(prettyDate("2025-10-22"), "2025-10-22");
  assert.equal(prettyDate(""), "Undated");
});

test("counts pluralise with grouping", () => {
  assert.equal(count(1, "recording"), "1 recording");
  assert.equal(count(2020, "recording"), "2,020 recordings");
  assert.equal(count(3, "match", "matches"), "3 matches");
});

test("range labels are file-name friendly", () => {
  assert.equal(rangeLabel(723, 850), "12m03s–14m10s");
  assert.equal(rangeLabel(3723, 3730), "1h02m03s–1h02m10s");
});

test("safe file names strip separators, bound length, keep emoji whole", () => {
  assert.equal(safeFileName('A/B: "C"?'), "A B C");
  assert.equal(safeFileName("..."), "Recording");
  assert.equal(safeFileName("   "), "Recording");
  const emoji = safeFileName("🎙".repeat(200));
  assert.equal(Array.from(emoji).length, 120);
  assert.ok(!emoji.includes("�"));
  assert.equal(Array.from(safeFileName("x".repeat(300))).length, 120);
  assert.equal(exportName("Oct 7 / meeting", 723, 850, "m4a"), "Oct 7 meeting — 12m03s–14m10s.m4a");
});

test("parseClock accepts s, m:ss, h:mm:ss and fractions", () => {
  assert.equal(parseClock("45"), 45);
  assert.equal(parseClock("12:03"), 723);
  assert.equal(parseClock("1:02:03"), 3723);
  assert.equal(parseClock("1:05.5"), 65.5);
  assert.equal(parseClock(" 0:07 "), 7);
  assert.equal(parseClock("1:75"), null);
  assert.equal(parseClock("abc"), null);
  assert.equal(parseClock(""), null);
});

test("initials and extensions", () => {
  assert.equal(initials("Ellen McFarlane"), "EM");
  assert.equal(initials("  cher "), "C");
  assert.equal(extension("/a/b.OGG"), "ogg");
  assert.equal(extension(null), "");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --dir desktop test:ts`
Expected: FAIL with `Cannot find module .../format.ts`.

- [ ] **Step 4: Implement `format.ts` and `cx.ts`**

`desktop/src/lib/format.ts`:
```ts
const pad = (n: number) => String(n).padStart(2, "0");
const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export function clock(seconds: number): string {
  const v = Math.max(0, Math.floor(finite(seconds)));
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  const s = v % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function clockPrecise(seconds: number): string {
  const v = Math.max(0, finite(seconds));
  return `${clock(v)}.${Math.floor((v % 1) * 10)}`;
}

export function humanDuration(seconds: number): string {
  const v = Math.max(0, Math.round(finite(seconds)));
  if (v < 60) return `${v}s`;
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function prettyDate(s: string): string {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s || "Undated";
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

function compact(seconds: number): string {
  const v = Math.max(0, Math.floor(finite(seconds)));
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  const s = v % 60;
  return h ? `${h}h${pad(m)}m${pad(s)}s` : `${m}m${pad(s)}s`;
}

export function rangeLabel(start: number, end: number): string {
  return `${compact(start)}–${compact(end)}`;
}

export function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return Array.from(cleaned || "Recording").slice(0, 120).join("").trim();
}

export function exportName(title: string, start: number, end: number, ext: string): string {
  return `${safeFileName(title)} — ${rangeLabel(start, end)}.${ext}`;
}

export function parseClock(input: string): number | null {
  const text = input.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const parts = whole.split(":").map(Number);
  if (parts.slice(1).some((p) => p > 59)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds + (fraction ? Number(`0.${fraction}`) : 0);
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

export function extension(path: string | null | undefined): string {
  const match = /\.([a-z0-9]+)$/i.exec(path ?? "");
  return match ? match[1].toLowerCase() : "";
}
```

`desktop/src/lib/cx.ts`:
```ts
export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir desktop test:ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Write `types.ts`, `storage.ts`, `ipc.ts`**

`desktop/src/lib/types.ts`:
```ts
export type ReviewState = "unreviewed" | "in_review" | "reviewed";
export type LibrarySort = "newest" | "oldest" | "opened" | "words" | "title" | "longest";
export type SpeakerSummary = { name: string; color: string | null; airtime: number };
export type Media = {
  id: string; title: string; channel: string; date: string; duration: number;
  path: string | null; transcript: string | null; words: number; status: string;
  kind: "audio" | "video"; starred: number; review_state: ReviewState;
  position: number; opened_at: string | null;
  speaker_count?: number; speakers?: SpeakerSummary[]; speaker_total?: number;
};
export type Segment = { start: number; end: number; text: string; speaker?: string | null };
export type Assignment = {
  local_id: string; speaker_id: string | null; name: string | null; color: string | null; airtime: number;
};
export type NoteMarker = { id: string; title: string; start: number; end: number | null };
export type Recording = {
  media: Media; segments: Segment[]; assignments: Assignment[]; notes: NoteMarker[]; model: string;
};
export type LibraryFilter = {
  query: string; channel: string; kind: "" | "audio" | "video"; transcribed: "" | "yes" | "no";
  starred: boolean; review: "" | ReviewState; sort: LibrarySort; offset: number; limit: 60 | 120 | 240;
};
export type LibraryPage = { items: Media[]; total: number; transcribed: number; channels: { channel: string }[] };
export type Overview = {
  media: number; speakers: number; notes: number; docs: number; dataRoot: string; legacyDatabase: string;
};
export type Speaker = {
  id: string; name: string; color: string | null; notes: string | null; recordings: number; airtime: number;
};
export type Note = {
  id?: string; title: string; body: string; quote?: string;
  media_id?: string | null; start?: number | null; end?: number | null; created_at?: string;
};
export type Research = {
  notes: Note[];
  links: { source: string; target: string; kind: string }[];
  docs: { id: string; title: string; length: number }[];
};
export type Job = { id: string; media_id: string; title: string; status: string; message: string; created_at?: string };
export type Runtime = {
  ready: boolean; device: string; gpu?: string; modelsReady: boolean; voiceMatchingReady: boolean;
  model: string; models: string; python: string;
};
export type SearchHit = {
  id: string; title: string; channel: string; date: string; text: string; marked: string;
  start: number; speaker: string | null; speaker_name: string | null; speaker_color: string | null;
};
export type PaletteResults = {
  recordings: { id: string; title: string; channel: string; date: string }[];
  speakers: { id: string; name: string; color: string | null }[];
  notes: { id: string; title: string; media_id: string | null; start: number | null }[];
  documents: { id: string; title: string }[];
};
export type MediaFormat = "m4a" | "mp3" | "mp4-fast" | "mp4-accurate";
export type TextFormat = "txt" | "md" | "srt";
export type DocumentBody = { id: string; title: string; body: string };
```

`desktop/src/lib/storage.ts`:
```ts
import { useCallback, useState } from "react";

/** Read a stored value. Values written before JSON storage (plain strings) are still accepted. */
export function readStored<T>(key: string, fallback: T, valid: (v: unknown) => boolean = () => true): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return valid(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage can be unavailable in a restricted webview; keep the value in memory. */
  }
}

export function useStoredState<T>(key: string, fallback: T, valid?: (v: unknown) => boolean) {
  const [value, setValue] = useState<T>(() => readStored(key, fallback, valid));
  const update = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        writeStored(key, v);
        return v;
      }),
    [key],
  );
  return [value, update] as const;
}
```

`desktop/src/lib/ipc.ts`:
```ts
import { invoke, isTauri, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  Overview, LibraryFilter, LibraryPage, Recording, SearchHit, PaletteResults, Speaker, Runtime, Job,
  Research, DocumentBody, Note, ReviewState, TextFormat, MediaFormat,
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
  setReview: (id: string, state: ReviewState) => call<void>("set_review", { id, state }),
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
    transport.pickFiles({ title: "Choose your Concord library database", name: "Concord library", extensions: ["db", "sqlite", "sqlite3"], multiple: false }),
  pickDocuments: () =>
    transport.pickFiles({ title: "Add documents", name: "Text and Markdown", extensions: ["md", "txt", "markdown"], multiple: true }),
  pickSavePath: (options: SavePick) => transport.pickSavePath(options),
};
```

- [ ] **Step 7: Move the existing screens onto `api`**

In `desktop/src/App.tsx` and `desktop/src/views.tsx`:
- Replace every `invoke("x", args)` with the matching `api.*` call.
- Replace `open(...)` with `api.pickMedia()` / `api.pickDatabase()` / `api.pickDocuments()`. Each returns `string[]`; treat an empty array as cancelled.
- Replace `convertFileSrc(path)` in `RecordingCover` with `api.thumbnail(media.id)`.
- Replace `isTauri()` with `api.available()`.
- Change `import type ... from "./types"` to `"./lib/types.ts"`.
- Delete `desktop/src/types.ts`.

Do not change behavior. The backend `library` command still takes `{query, channel, offset}` until Task 6, so for now call it as `call("library", { query, channel, offset })` through a temporary `api.libraryLegacy = (query, channel, offset) => call<LibraryPage>("library", { query, channel, offset })`. Task 6 deletes it.

- [ ] **Step 8: Build and verify no direct Tauri imports remain in screens**

Run: `pnpm --dir desktop build && grep -rn "@tauri-apps" desktop/src --include=*.tsx`
Expected: the build passes and grep prints nothing (only `lib/ipc.ts`, a `.ts` file, imports Tauri).

- [ ] **Step 9: Commit**

```bash
git add desktop/src desktop/package.json desktop/tsconfig.json
git commit -m "Route Concord Next through a typed IPC seam with tested formatting utilities

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Theme system, brand theme, vendored fonts, base styles

**Files:**
- Create: `desktop/src/fonts/{InterVariable.woff2,SourceSerif4Variable-Roman.woff2,SourceSerif4Variable-Italic.woff2,JetBrainsMono-Regular.woff2,JetBrainsMono-Medium.woff2,fonts.css,README.md,OFL-Inter.txt,OFL-SourceSerif.txt,OFL-JetBrainsMono.txt}`
- Create: `desktop/src/theme/{concord.css,tokens.css,base.css,scope.ts,scope.test.ts,theme.ts}`, `desktop/src/theme/themes/*.css` (12 files copied from `client/src/themes/`)
- Modify: `desktop/src/main.tsx`, `desktop/index.html`

**Interfaces:**
- Produces:
  - `scopeTweakcn(raw, name): string` and `themeNameFromPath(path): string | null`.
  - `THEMES: string[]`, `Appearance`, `ThemeMode`, `ReadingFont`, and `DEFAULT_APPEARANCE`.
  - `loadAppearance()`, `saveAppearance(a)`, `applyAppearance(a)`, `injectThemes()`, and `useAppearance(): [Appearance, (a: Appearance) => void]`.
  - CSS tokens as listed in Global Constraints, plus the app tokens defined in `tokens.css`.

- [ ] **Step 1: Write the failing scope tests**

`desktop/src/theme/scope.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeTweakcn, themeNameFromPath } from "./scope.ts";

const sample = `@import "tailwindcss";
@custom-variant dark (&:is(.dark *));
:root { --background: #fff; --primary: red; }
.dark { --background: #000; }
@theme inline { --color-background: var(--background); }
@layer base { * { border-color: var(--border); } }`;

test("scopes light and dark blocks to the theme and drops build directives", () => {
  const css = scopeTweakcn(sample, "lifeOS");
  assert.equal(
    css,
    ":root.theme-lifeOS { --background: #fff; --primary: red; }\n:root.theme-lifeOS.dark { --background: #000; }",
  );
});

test("a theme without a dark block yields only its light block", () => {
  assert.equal(scopeTweakcn(":root{--a:1;}", "mono"), ":root.theme-mono {--a:1;}");
});

test("theme names come from file names; underscore files are ignored", () => {
  assert.equal(themeNameFromPath("./themes/lifeOS.css"), "lifeOS");
  assert.equal(themeNameFromPath("./themes/altar-invert.css"), "altar-invert");
  assert.equal(themeNameFromPath("./themes/_draft.css"), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir desktop test:ts`
Expected: FAIL (`scope.ts` not found).

- [ ] **Step 3: Implement `scope.ts`**

```ts
/** Rewrite a pasted tweakcn export so several themes can coexist. Only :root and .dark token blocks are kept. */
export function scopeTweakcn(raw: string, name: string): string {
  const blocks: string[] = [];
  const light = /:root\s*\{([^{}]*)\}/.exec(raw);
  const dark = /\.dark\s*\{([^{}]*)\}/.exec(raw);
  if (light) blocks.push(`:root.theme-${name} {${light[1]}}`);
  if (dark) blocks.push(`:root.theme-${name}.dark {${dark[1]}}`);
  return blocks.join("\n");
}

export function themeNameFromPath(path: string): string | null {
  const match = /\/([^/]+)\.css$/.exec(path);
  return match && !match[1].startsWith("_") ? match[1] : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir desktop test:ts`
Expected: PASS.

- [ ] **Step 5: Vendor the fonts**

1. Use `curl -fL` to download into the scratchpad:
   - Inter v4.1: `https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip`. Take `web/InterVariable.woff2` and `LICENSE.txt`.
   - Source Serif 4: list the release assets with `curl -s https://api.github.com/repos/adobe-fonts/source-serif/releases/latest | grep browser_download_url`. Download the release zip. Take the variable WOFF2 roman and italic files (`WOFF2/VAR/SourceSerif4Variable-Roman.ttf.woff2` and `-Italic.ttf.woff2`) and `LICENSE.md`.
   - JetBrains Mono v2.304: `https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip`. Take `fonts/webfonts/JetBrainsMono-Regular.woff2`, `JetBrainsMono-Medium.woff2`, and `OFL.txt`.
2. Copy them into `desktop/src/fonts/` with the names in **Files**.
3. Write `desktop/src/fonts/README.md` listing each file's source URL, version, and `sha256sum` output.
4. If a download fails, stop and report. Do not substitute npm font packages.

`desktop/src/fonts/fonts.css`:
```css
@font-face { font-family: "Inter Variable"; src: url("./InterVariable.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Source Serif 4 Variable"; src: url("./SourceSerif4Variable-Roman.woff2") format("woff2"); font-weight: 200 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Source Serif 4 Variable"; src: url("./SourceSerif4Variable-Italic.woff2") format("woff2"); font-weight: 200 900; font-style: italic; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("./JetBrainsMono-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("./JetBrainsMono-Medium.woff2") format("woff2"); font-weight: 500; font-display: swap; }
```

- [ ] **Step 6: Write the brand theme and app tokens**

`desktop/src/theme/concord.css` (tweakcn shape; `:root` = light paper, `.dark` = navy):
```css
:root {
  --background: #f5f1ea; --foreground: #1b2230;
  --card: #fbf9f5; --card-foreground: #1b2230;
  --popover: #ffffff; --popover-foreground: #1b2230;
  --primary: #a35d0b; --primary-foreground: #fffaf2;
  --secondary: #ebe5da; --secondary-foreground: #2a3342;
  --muted: #eee9e0; --muted-foreground: #5f6875;
  --accent: #e7e0d3; --accent-foreground: #1b2230;
  --destructive: #b83a26; --destructive-foreground: #ffffff;
  --border: #ddd5c7; --input: #d4cbbb; --ring: #a35d0b;
  --chart-1: #b36b12; --chart-2: #2f7fa3; --chart-3: #4f8a3c; --chart-4: #b04a82; --chart-5: #6d5fc0;
  --sidebar: #efeae1; --sidebar-foreground: #2a3342;
  --sidebar-primary: #a35d0b; --sidebar-primary-foreground: #fffaf2;
  --sidebar-accent: #e5ded1; --sidebar-accent-foreground: #1b2230;
  --sidebar-border: #e0d8ca; --sidebar-ring: #a35d0b;
  --font-sans: "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif;
  --font-serif: "Source Serif 4 Variable", "Iowan Old Style", Georgia, serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --radius: 0.5rem;
}
.dark {
  --background: #0f141c; --foreground: #ece7de;
  --card: #151b25; --card-foreground: #ece7de;
  --popover: #1a212c; --popover-foreground: #ece7de;
  --primary: #e0a24b; --primary-foreground: #1b1206;
  --secondary: #1e2632; --secondary-foreground: #d9d3c8;
  --muted: #1a212c; --muted-foreground: #8e98a7;
  --accent: #232c39; --accent-foreground: #ece7de;
  --destructive: #e5675c; --destructive-foreground: #1b0d0b;
  --border: #252e3b; --input: #2e3846; --ring: #e0a24b;
  --chart-1: #e0a24b; --chart-2: #6fb3d2; --chart-3: #9ccf8a; --chart-4: #d68ab4; --chart-5: #a79bdc;
  --sidebar: #121821; --sidebar-foreground: #c9c4bb;
  --sidebar-primary: #e0a24b; --sidebar-primary-foreground: #1b1206;
  --sidebar-accent: #1c2430; --sidebar-accent-foreground: #ece7de;
  --sidebar-border: #1f2733; --sidebar-ring: #e0a24b;
}
```

`desktop/src/theme/tokens.css` (derived app tokens; themes never define these):
```css
:root {
  --font-ui: var(--font-sans);
  --font-reading: var(--font-serif);
  --font-code: var(--font-mono);
  --text-xs: 11px; --text-sm: 12.5px; --text-md: 13.5px; --text-lg: 15px; --text-xl: 18px; --text-2xl: 22px;
  --reading-size: 15.5px;
  --r-1: clamp(3px, calc(var(--radius) * 0.4), 6px);
  --r-2: clamp(5px, calc(var(--radius) * 0.75), 10px);
  --r-3: clamp(8px, var(--radius), 16px);
  --hover: color-mix(in oklab, var(--foreground) 6%, transparent);
  --active: color-mix(in oklab, var(--foreground) 10%, transparent);
  --selected: color-mix(in oklab, var(--primary) 16%, transparent);
  --current-line: color-mix(in oklab, var(--primary) 9%, transparent);
  --range-fill: color-mix(in oklab, var(--primary) 20%, transparent);
  --mark: color-mix(in oklab, var(--primary) 38%, transparent);
  --overlay: color-mix(in oklab, #05070b 60%, transparent);
  --shadow-float: 0 1px 2px rgb(27 34 48 / 0.08), 0 12px 32px -8px rgb(27 34 48 / 0.2);
  --control-h: 32px; --row-h: 36px; --hit: 32px;
  --sidebar-w: 232px; --rail-w: 56px; --topbar-h: 52px; --tabbar-h: 60px;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1); --dur: 150ms;
}
:root.dark { --shadow-float: 0 1px 2px rgb(0 0 0 / 0.3), 0 16px 40px -8px rgb(0 0 0 / 0.55); }
:root[data-reading="sans"] { --font-reading: var(--font-sans); --reading-size: 14.5px; }
@media (pointer: coarse) { :root { --control-h: 44px; --row-h: 48px; --hit: 44px; } }
@media (prefers-reduced-motion: reduce) { :root { --dur: 0ms; } }
```

`desktop/src/theme/base.css` must define:
- The reset: box-sizing, margins, and `button, input, select, textarea { font: inherit; color: inherit }`.
- `html, body, #root` at full height, with `body { background: var(--background); color: var(--foreground); font: var(--text-md)/1.45 var(--font-ui); -webkit-font-smoothing: antialiased; font-synthesis: none; }`.
- Headings: `h1` uses `var(--text-2xl)` at weight 600 with letter-spacing -0.01em; `h2` uses `--text-xl`; `h3` uses `--text-lg`.
- `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }`.
- `::selection { background: var(--mark); }`.
- Thin scrollbars: `::-webkit-scrollbar` 10px, thumb `var(--border)` with a 3px transparent border, `background-clip: padding-box`.
- Utility classes: `.num { font-variant-numeric: tabular-nums; }`, `.mono { font-family: var(--font-code); font-size: 0.92em; }`, `.muted { color: var(--muted-foreground); }`, and `.sr-only` (the standard visually-hidden pattern).
- `a { color: inherit; text-decoration: none; }`.
- `[hidden] { display: none !important; }`.

- [ ] **Step 7: Implement `theme.ts`**

```ts
import { useCallback, useState } from "react";
import { readStored, writeStored } from "../lib/storage.ts";
import { scopeTweakcn, themeNameFromPath } from "./scope.ts";

const files = import.meta.glob("./themes/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export type ThemeMode = "system" | "dark" | "light";
export type ReadingFont = "serif" | "sans";
export type Appearance = { theme: string; mode: ThemeMode; reading: ReadingFont };
export const DEFAULT_APPEARANCE: Appearance = { theme: "concord", mode: "dark", reading: "serif" };
const KEY = "appearance-v1";

export const THEMES: string[] = [
  "concord",
  ...Object.keys(files).map(themeNameFromPath).filter((n): n is string => !!n).sort((a, b) => a.localeCompare(b)),
];

export function injectThemes(): void {
  const id = "concord-themes";
  const el = document.getElementById(id) ?? Object.assign(document.createElement("style"), { id });
  el.textContent = Object.entries(files)
    .map(([path, raw]) => {
      const name = themeNameFromPath(path);
      return name ? scopeTweakcn(raw, name) : "";
    })
    .join("\n");
  document.head.append(el);
}

export function loadAppearance(): Appearance {
  const v = readStored<Partial<Appearance>>(KEY, {}, (x) => typeof x === "object" && x !== null);
  return {
    theme: v.theme && THEMES.includes(v.theme) ? v.theme : DEFAULT_APPEARANCE.theme,
    mode: v.mode === "system" || v.mode === "light" || v.mode === "dark" ? v.mode : DEFAULT_APPEARANCE.mode,
    reading: v.reading === "sans" ? "sans" : "serif",
  };
}

export function saveAppearance(a: Appearance): void {
  writeStored(KEY, a);
}

let stopFollowingSystem: (() => void) | null = null;

export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  for (const name of THEMES) root.classList.remove(`theme-${name}`);
  if (a.theme !== "concord") root.classList.add(`theme-${a.theme}`);
  stopFollowingSystem?.();
  stopFollowingSystem = null;
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const set = () => {
    const dark = a.mode === "dark" || (a.mode === "system" && query.matches);
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  };
  set();
  if (a.mode === "system") {
    query.addEventListener("change", set);
    stopFollowingSystem = () => query.removeEventListener("change", set);
  }
  root.dataset.reading = a.reading;
}

export function useAppearance(): [Appearance, (a: Appearance) => void] {
  const [appearance, setAppearance] = useState(loadAppearance);
  const update = useCallback((a: Appearance) => {
    applyAppearance(a);
    saveAppearance(a);
    setAppearance(a);
  }, []);
  return [appearance, update];
}
```

- [ ] **Step 8: Apply the theme before React mounts**

Copy the 12 theme files: `cp client/src/themes/*.css desktop/src/theme/themes/`.

`desktop/src/main.tsx`:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import "./fonts/fonts.css";
import "./theme/concord.css";
import "./theme/tokens.css";
import "./theme/base.css";
import "./style.css";
import { applyAppearance, injectThemes, loadAppearance } from "./theme/theme.ts";
import App from "./App";

injectThemes();
applyAppearance(loadAppearance());
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```
(`style.css` stays until Task 13 removes it.)

In `desktop/index.html`, set the viewport to `width=device-width,initial-scale=1,viewport-fit=cover`. Also add `<meta name="color-scheme" content="dark light">`.

- [ ] **Step 9: Build, run the tests, and check the fonts are bundled**

Run: `pnpm --dir desktop test:ts && pnpm --dir desktop build && ls desktop/dist/assets | grep -Ei "woff2"`
Expected: tests pass, the build passes, and 5 woff2 assets are listed.

- [ ] **Step 10: Commit**

```bash
git add desktop/src/fonts desktop/src/theme desktop/src/main.tsx desktop/index.html
git commit -m "Add the Concord brand theme, tweakcn theme support, and vendored interface fonts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Dev mock transport, synthetic fixtures, and the screenshot runner

**Files:**
- Create: `desktop/src/dev/fixtures.ts`, `desktop/src/dev/mock-ipc.ts`, `desktop/scripts/screens.mjs`
- Modify: `desktop/src/main.tsx`, `desktop/package.json` (`"screens": "node scripts/screens.mjs"`)

**Interfaces:**
- Consumes: `Transport`, `setTransport` (Task 1), and the types.
- Produces:
  - `installMock(): void`.
  - Browser URL flags `?mock`, `&theme=<name>`, `&mode=dark|light`, `&gallery`.
  - `screens.mjs <outdir> [filter]`, which writes `<name>-<size>-<mode>.png`.

- [ ] **Step 1: Write the synthetic fixtures**

`desktop/src/dev/fixtures.ts` must export:
- `mediaList: Media[]`: 48 synthetic recordings with ids `rec-01` … `rec-48`. The screenshot runner depends on two of them: `rec-01` is a 600 s video, and `rec-03` is audio.
  - Channels: "Tuesday Study", "Field Interviews", "Voice notes", "Conference 2025".
  - Titles come from two word lists, e.g. `["Harbour", "Covenant", "Early", "Northern", ...]` × `["conversation", "interview", "session", "walkthrough", ...]`.
  - Dates run between `20240101` and `20250930`. Durations run from 300 to 10,800 s.
  - Recordings whose number is divisible by 3 are `.ogg` audio; the rest are `.mp4`.
  - Stars on ids 2, 5, 9. Review states cycle. `position` is set on 4 recordings.
  - `speakers` hold 0–3 chips from `speakerList`, and `transcript` is null on every 7th.
- `speakerList: Speaker[]`: 9 people with names, colors (some null), airtime, and counts.
- `recordingFor(id): Recording`:
  - Deterministic segments covering the duration: a line every 4–9 s, text cycled from 24 plain English sentences about archives, memory and meetings, speakers S0–S3.
  - Assignments name S0 and S1 and leave S2 and S3 unnamed.
  - Two notes.
  - The first recording is 600 s long so the player screenshots show a full timeline.
- `notesList: Note[]` (6), `docsList: { id; title; length }[]` (5, ids `doc-1` … `doc-5`), and `docBody(id): string`. Doc bodies are Markdown with headings, lists, a blockquote, code, and a link.
- `peaksFor(id): number[]`: 2,000 values from a seeded pseudo-random walk, clamped to 0.05–1.
- `thumbnailFor(id): string | null`: null for audio. For video, an SVG `data:` URI with a two-stop gradient seeded by id and a large faint glyph.
- `silentWav(seconds: number): string`: an 8-bit mono 2 kHz WAV as a Blob URL (`URL.createObjectURL`).

Use a small seeded generator:
```ts
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32;
}
```

- [ ] **Step 2: Write the mock transport**

`desktop/src/dev/mock-ipc.ts`:
```ts
import { setTransport, type Transport } from "../lib/ipc.ts";
import type { LibraryFilter } from "../lib/types.ts";
import * as fx from "./fixtures.ts";

const delay = <T>(value: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(value), ms));
const listeners = new Map<string, Set<(p: unknown) => void>>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload));

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
  const by: Record<string, (a: typeof items[0], b: typeof items[0]) => number> = {
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

const handlers: Record<string, (a: any) => unknown> = {
  overview: () => ({ media: fx.mediaList.length, speakers: fx.speakerList.length, notes: fx.notesList.length, docs: fx.docsList.length, dataRoot: "/home/you/.local/share/concord-next", legacyDatabase: "/home/you/.local/share/concord/pipeline.db" }),
  library: ({ filter }) => library(filter),
  recording: ({ id }) => fx.recordingFor(id),
  media_file: () => fx.silentWav(600),
  thumbnail_file: ({ id }) => fx.thumbnailFor(id),
  search: ({ query }) => fx.searchHits(query),
  palette: ({ query }) => fx.paletteFor(query),
  speakers: () => fx.speakerList,
  research: () => ({ notes: fx.notesList, links: [{ source: fx.notesList[0].id, target: fx.notesList[1].id, kind: "related" }], docs: fx.docsList }),
  document: ({ id }) => ({ id, title: fx.docsList.find((d) => d.id === id)?.title ?? "Document", body: fx.docBody(id) }),
  jobs: () => [{ id: "j1", media_id: fx.mediaList[3].id, title: fx.mediaList[3].title, status: "running", message: "Transcribing · 42%" }],
  speech_status: () => ({ ready: true, device: "vulkan:0", gpu: "NVIDIA GeForce RTX 2080 Ti", modelsReady: true, voiceMatchingReady: true, model: "nemotron", models: "", python: "" }),
  waveform: ({ id }) => fx.peaksFor(id),
  transcript_text: () => "Harbour conversation\nTuesday Study · 2025-09-02 · 1:05–1:40\n\n[1:05] Ada: Mock transcript text.",
  export_media: async ({ dest }) => {
    for (let i = 1; i <= 10; i++) { await delay(null, 120); emit("export-progress", i / 10); }
    return dest;
  },
  export_transcript: ({ dest }) => dest,
};

export function installMock(): void {
  const transport: Transport = {
    available: () => true,
    call: async (command, args) => {
      const handler = handlers[command];
      return delay(handler ? await handler(args ?? {}) : null) as never;
    },
    listen: async (event, handler) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (p: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(handler as (p: unknown) => void);
    },
    fileUrl: (path) => path,
    pickFiles: async () => [],
    pickSavePath: async ({ defaultPath }) => `/home/you/Exports/${defaultPath}`,
    version: async () => "0.2.0-dev",
  };
  setTransport(transport);
}
```
Also add `fx.searchHits(query)` and `fx.paletteFor(query)` to the fixtures:
- `searchHits(query)`: case-insensitive matches over the first 12 recordings' segments, returning `marked` with `\u0002…\u0003` around the match.
- `paletteFor(query)`: filters each list by title or name, up to 6 per group.

- [ ] **Step 3: Install the mock in dev and add the gallery switch**

`desktop/src/main.tsx` becomes an async boot. Keep the imports from Task 2.
```tsx
async function boot() {
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.has("mock")) {
    (await import("./dev/mock-ipc.ts")).installMock();
    const theme = params.get("theme");
    const mode = params.get("mode");
    if (theme || mode) {
      const current = loadAppearance();
      saveAppearance({ ...current, theme: theme ?? current.theme, mode: mode === "light" ? "light" : mode === "dark" ? "dark" : current.mode });
    }
  }
  injectThemes();
  applyAppearance(loadAppearance());
  const Root = import.meta.env.DEV && params.has("gallery") ? (await import("./dev/Gallery.tsx")).default : App;
  createRoot(document.getElementById("root")!).render(<React.StrictMode><Root /></React.StrictMode>);
}
void boot();
```
Create a placeholder `desktop/src/dev/Gallery.tsx` (`export default function Gallery() { return <main className="gallery" />; }`); Task 4 fills it in.

- [ ] **Step 4: Write the screenshot runner**

`desktop/scripts/screens.mjs`:
```js
// Capture Concord Next pages from the Vite dev server using headless Chromium over CDP.
// Usage: node desktop/scripts/screens.mjs <outdir> [name-filter]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const out = process.argv[2] ?? "screens";
const only = process.argv[3] ?? "";
const base = process.env.BASE ?? "http://127.0.0.1:1420/";
const port = 9333;
const sizes = {
  desktop: { width: 1440, height: 940, mobile: false },
  small: { width: 960, height: 640, mobile: false },
  tablet: { width: 820, height: 1180, mobile: true },
  phone: { width: 390, height: 844, mobile: true },
};
// Each shot: name, hash route, optional script run after load (e.g. open a menu).
const shots = [
  { name: "gallery", query: "gallery", hash: "" },
  { name: "library", hash: "#/library" },
  { name: "library-list", hash: "#/library", before: "localStorage.setItem('library-view-v1', JSON.stringify('list'))" },
  { name: "player", hash: "#/recording/" + encodeURIComponent("rec-01") + "?t=65" },
  { name: "player-audio", hash: "#/recording/" + encodeURIComponent("rec-03") },
  { name: "search", hash: "#/search?q=harbour" },
  { name: "documents", hash: "#/documents" },
  { name: "document", hash: "#/documents/doc-1" },
  { name: "notes", hash: "#/notes" },
  { name: "speakers", hash: "#/speakers" },
  { name: "map", hash: "#/map" },
  { name: "settings", hash: "#/settings" },
  ...(process.env.EXTRA ? JSON.parse(process.env.EXTRA) : []),
];

mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "concord-screens-"));
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });
try {
  let version;
  for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(100); }
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  for (const shot of shots.filter((s) => !only || s.name.includes(only))) {
    for (const mode of ["dark", "light"]) {
      for (const [sizeName, size] of Object.entries(sizes)) {
        await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
        await send("Emulation.setTouchEmulationEnabled", { enabled: size.mobile, maxTouchPoints: size.mobile ? 5 : 0 });
        await send("Emulation.setEmitTouchEventsForMouse", { enabled: size.mobile });
        const url = `${base}?mock&mode=${mode}${shot.query ? `&${shot.query}` : ""}${shot.hash}`;
        await send("Page.navigate", { url: "about:blank" });
        await send("Page.navigate", { url });
        await sleep(300);
        if (shot.before) { await send("Runtime.evaluate", { expression: shot.before }); await send("Page.reload"); }
        await sleep(900);
        if (shot.after) { await send("Runtime.evaluate", { expression: shot.after, awaitPromise: true }); await sleep(400); }
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        const file = join(out, `${shot.name}-${sizeName}-${mode}.png`);
        writeFileSync(file, Buffer.from(data, "base64"));
        console.log(file);
      }
    }
  }
  ws.close();
} finally {
  chrome.kill();
}
```

- [ ] **Step 5: Verify the harness end to end**

Run `pnpm --dir desktop dev` in the background. Wait for "ready", then:
`node desktop/scripts/screens.mjs "$SCRATCH/screens" library`
Expected: 8 PNGs are printed. Open `library-desktop-dark.png` with the Read tool. It should show the existing Library rendered with mock data (the old styling is expected at this point).

- [ ] **Step 6: Build and commit**

Run: `pnpm --dir desktop build`. Then check that the dev modules stay out of the production bundle: `grep -l "installMock" desktop/dist/assets/*.js` should print nothing.
```bash
git add desktop/src/dev desktop/src/main.tsx desktop/scripts/screens.mjs desktop/package.json
git commit -m "Add a dev-only mock host and headless screenshot runner for design review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: UI primitives and the component gallery

**Files:**
- Modify: `desktop/package.json` (dependencies), `pnpm-lock.yaml`
- Create: `desktop/src/lib/media-query.ts`, `desktop/src/ui/{Button.tsx,Menu.tsx,Dialog.tsx,Toasts.tsx,Select.tsx,Segmented.tsx,Chip.tsx,PageHeader.tsx,Empty.tsx,Kbd.tsx,ui.css}`
- Modify: `desktop/src/dev/Gallery.tsx`

**Interfaces:**
- Consumes: `cx`, the tokens.
- Produces:
  - `Button({variant: "primary"|"secondary"|"ghost"|"danger", size: "sm"|"md", icon?})`.
  - `IconButton({label, icon, size?, active?})`.
  - `Menu({trigger, entries: MenuEntry[], label, align?})`, with `MenuEntry` as below.
  - `Dialog({open, onOpenChange, title, description?, footer?, size?: "sm"|"md"|"lg", variant?: "center"|"side"|"sheet", children})`.
  - `Sheet` (Dialog with `variant="sheet"`) and `ConfirmDialog({open, onOpenChange, title, body, confirmLabel, danger?, onConfirm})`.
  - `ToastProvider`, and `useToast(): { success(msg, action?), info(msg, action?), error(err: unknown) }`.
  - `Select<T>({value, onChange, options, label, size?})`.
  - `Segmented<T>({value, onChange, options: {value, label, icon?}[], label})`.
  - `Chip({tone?: "neutral"|"accent"|"success"|"warn"|"danger"})` and `SpeakerChip({name, color, onClick?, size?})`.
  - `PageHeader({title, meta?, actions?})`, `Empty({icon, title, text, action?})`, and `Kbd`.
  - `useMediaQuery(q)`, with `PHONE = "(max-width: 639px)"`, `TABLET = "(max-width: 899px)"`, and `RAIL = "(max-width: 1199px)"`.

- [ ] **Step 1: Add the four packages at their pinned versions**

Run: `pnpm --dir desktop add --save-exact @radix-ui/react-dialog@1.1.15 @radix-ui/react-popover@1.1.15 @radix-ui/react-select@2.2.6 cmdk@1.1.1`
Then check the lockfile diff for new package versions: `git diff pnpm-lock.yaml | grep -E '^\+  (/|@|[a-z])[^ ]*@[0-9]' | head -40`
Expected: only importer entries for `desktop`, and no newly resolved package versions beyond what the root lockfile already had. If new transitive versions appear, list them in the commit message and confirm they are Radix/cmdk-internal packages.

- [ ] **Step 2: Write `media-query.ts`**

```ts
import { useSyncExternalStore } from "react";
export const PHONE = "(max-width: 639px)";
export const TABLET = "(max-width: 899px)";
export const RAIL = "(max-width: 1199px)";
export const COARSE = "(pointer: coarse)";
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
```

- [ ] **Step 3: Write the Button, Chip, PageHeader, Empty, and Kbd primitives**

`desktop/src/ui/Button.tsx`:
```tsx
import type { ComponentPropsWithRef, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../lib/cx.ts";

type Base = Omit<ComponentPropsWithRef<"button">, "children">;
export type ButtonProps = Base & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: LucideIcon;
  children?: ReactNode;
};
export function Button({ variant = "secondary", size = "md", icon: Icon, children, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx("btn", `btn-${variant}`, `btn-${size}`, className)} {...rest}>
      {Icon && <Icon size={size === "sm" ? 14 : 16} aria-hidden />}
      {children}
    </button>
  );
}

export type IconButtonProps = Base & { label: string; icon: LucideIcon; size?: "sm" | "md"; active?: boolean };
export function IconButton({ label, icon: Icon, size = "md", active, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      data-tip={label}
      aria-pressed={active}
      className={cx("icon-btn", `icon-btn-${size}`, active && "is-active", className)}
      {...rest}
    >
      <Icon size={size === "sm" ? 15 : 17} aria-hidden />
    </button>
  );
}
```

`desktop/src/ui/Chip.tsx`:
```tsx
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../lib/cx.ts";
export function Chip({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warn" | "danger"; className?: string }) {
  return <span className={cx("chip", `chip-${tone}`, className)}>{children}</span>;
}
export function SpeakerChip({ name, color, onClick, size = "md", title }: { name: string; color: string; onClick?: () => void; size?: "sm" | "md"; title?: string }) {
  const style = { "--speaker": color } as CSSProperties;
  const body = (<><i aria-hidden className="speaker-dot" /><span className="speaker-chip-name">{name}</span></>);
  return onClick ? (
    <button type="button" className={cx("speaker-chip", `speaker-chip-${size}`, "is-button")} style={style} onClick={onClick} title={title}>{body}</button>
  ) : (
    <span className={cx("speaker-chip", `speaker-chip-${size}`)} style={style} title={title}>{body}</span>
  );
}
```

`PageHeader.tsx` renders `<header className="page-header"><div><h1>{title}</h1>{meta && <p className="page-meta num">{meta}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>`. `Empty.tsx` renders an icon at 28px, `h3`, `p`, and an optional action inside `.empty`. `Kbd.tsx` renders `<kbd className="kbd">`.

- [ ] **Step 4: Write Dialog, Sheet, and ConfirmDialog**

`desktop/src/ui/Dialog.tsx`:
```tsx
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { Button, IconButton } from "./Button.tsx";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: "center" | "side" | "sheet";
  children?: ReactNode;
};
export function Dialog({ open, onOpenChange, title, description, footer, size = "md", variant = "center", children }: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="overlay" />
        <D.Content className={cx("dialog", `dialog-${variant}`, `dialog-${size}`)} aria-describedby={description ? undefined : undefined}>
          <header className="dialog-head">
            <D.Title className="dialog-title">{title}</D.Title>
            <D.Close asChild><IconButton label="Close" icon={X} size="sm" /></D.Close>
          </header>
          {description && <D.Description className="dialog-desc">{description}</D.Description>}
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-foot">{footer}</footer>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
export const Sheet = (props: Omit<DialogProps, "variant">) => <Dialog {...props} variant="sheet" />;

export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, danger, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm" footer={
      <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => { onOpenChange(false); onConfirm(); }}>{confirmLabel}</Button>
      </>
    }>
      <div className="dialog-text">{body}</div>
    </Dialog>
  );
}
```
When there is no description, Radix wants `aria-describedby={undefined}` passed explicitly. The expression above always evaluates to `undefined`, which is intentional: it silences the warning without inventing text.

- [ ] **Step 5: Write Menu (a popover on desktop, a sheet on phones)**

`desktop/src/ui/Menu.tsx`:
```tsx
import * as Popover from "@radix-ui/react-popover";
import { Check, type LucideIcon } from "lucide-react";
import { cloneElement, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { PHONE, useMediaQuery } from "../lib/media-query.ts";
import { Sheet } from "./Dialog.tsx";

export type MenuEntry =
  | { kind?: "item"; label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string }
  | { kind: "separator" }
  | { kind: "label"; label: string };

export function Menu({ trigger, entries, label, align = "end" }: { trigger: ReactElement<{ onClick?: () => void }>; entries: MenuEntry[]; label: string; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const phone = useMediaQuery(PHONE);
  const content = useRef<HTMLDivElement>(null);
  const list = <MenuList entries={entries} onDone={() => setOpen(false)} />;
  if (phone)
    return (
      <>
        {cloneElement(trigger, { onClick: () => setOpen(true) })}
        <Sheet open={open} onOpenChange={setOpen} title={label}>{list}</Sheet>
      </>
    );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="menu"
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            content.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
          }}
        >
          {list}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MenuList({ entries, onDone }: { entries: MenuEntry[]; onDone: () => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div role="menu" className="menu-list" onKeyDown={onKeyDown}>
      {entries.map((entry, i) =>
        entry.kind === "separator" ? (
          <div key={i} role="separator" className="menu-sep" />
        ) : entry.kind === "label" ? (
          <div key={i} className="menu-label">{entry.label}</div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={cx("menu-item", entry.danger && "is-danger")}
            onClick={() => { onDone(); entry.onSelect(); }}
          >
            {entry.icon ? <entry.icon size={15} aria-hidden /> : <span className="menu-icon-space" />}
            <span className="menu-item-label">{entry.label}</span>
            {entry.checked && <Check size={14} className="menu-check" aria-hidden />}
            {entry.hint && <kbd className="kbd">{entry.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
```

- [ ] **Step 6: Write Select and Segmented**

`desktop/src/ui/Select.tsx`:
```tsx
import * as S from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "../lib/cx.ts";
const EMPTY = "__none__"; // Radix forbids empty-string item values.
export type Option<T extends string> = { value: T; label: string };
export function Select<T extends string>({ value, onChange, options, label, size = "md", className }: {
  value: T; onChange: (v: T) => void; options: Option<T>[]; label: string; size?: "sm" | "md"; className?: string;
}) {
  return (
    <S.Root value={value || EMPTY} onValueChange={(v) => onChange((v === EMPTY ? "" : v) as T)}>
      <S.Trigger className={cx("select", `select-${size}`, className)} aria-label={label}>
        <S.Value />
        <S.Icon className="select-icon"><ChevronDown size={14} /></S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content className="menu select-content" position="popper" sideOffset={6} collisionPadding={8}>
          <S.Viewport>
            {options.map((o) => (
              <S.Item key={o.value || EMPTY} value={o.value || EMPTY} className="menu-item">
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator className="menu-check"><Check size={14} /></S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
```

`desktop/src/ui/Segmented.tsx`:
```tsx
import type { LucideIcon } from "lucide-react";
import { cx } from "../lib/cx.ts";
export function Segmented<T extends string>({ value, onChange, options, label, size = "md" }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: LucideIcon; iconOnly?: boolean }[]; label: string; size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("segmented", `segmented-${size}`)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.iconOnly ? o.label : undefined}
          data-tip={o.iconOnly ? o.label : undefined}
          className={cx("segment", value === o.value && "is-on")}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <o.icon size={15} aria-hidden />}
          {!o.iconOnly && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Write Toasts**

`desktop/src/ui/Toasts.tsx`:
```tsx
import { Check, CircleAlert, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";

type Action = { label: string; run: () => void };
type Toast = { id: number; kind: "success" | "error" | "info"; message: string; action?: Action };
export type ToastApi = { success(message: string, action?: Action): void; info(message: string, action?: Action): void; error(err: unknown): void };
const Context = createContext<ToastApi | null>(null);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback((kind: Toast["kind"], message: string, action?: Action) => {
    const id = next.current++;
    setToasts((all) => [...all.slice(-2), { id, kind, message, action }]);
    if (kind !== "error") setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);
  const api = useMemo<ToastApi>(() => ({
    success: (m, a) => push("success", m, a),
    info: (m, a) => push("info", m, a),
    error: (e) => push("error", errorMessage(e)),
  }), [push]);
  const Icon = { success: Check, error: CircleAlert, info: Info };
  return (
    <Context.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => {
          const I = Icon[t.kind];
          return (
            <div key={t.id} className={cx("toast", `toast-${t.kind}`)} role={t.kind === "error" ? "alert" : "status"}>
              <I size={16} aria-hidden />
              <span className="toast-message">{t.message}</span>
              {t.action && (
                <button type="button" className="toast-action" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>
              )}
              <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={14} /></button>
            </div>
          );
        })}
      </div>
    </Context.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Context);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}
```

- [ ] **Step 8: Write `ui.css`**

Import it from `main.tsx` after `base.css`. All values come from tokens. Rules:
- **Buttons.** `.btn` is an inline-flex, 8px gap, with height `var(--control-h)`, padding `0 12px`, radius `var(--r-2)`, weight 500, size `--text-md`, and a transition on background and border (`var(--dur) var(--ease)`).
  - `btn-primary`: `--primary` background, `--primary-foreground` text; hover mixes 8% foreground.
  - `btn-secondary`: `--secondary` background with a 1px `--border` border.
  - `btn-ghost`: transparent, `--hover` on hover.
  - `btn-danger`: `--destructive` text on a transparent background with a `--destructive` 40% border.
  - `btn-sm` is 28px high with 10px padding. `:disabled` sets opacity 0.45.
- **Icon buttons.** `.icon-btn` is a square `var(--hit)` with radius `--r-2` and `--muted-foreground` color. Hover uses `--hover` and `--foreground`. `.is-active` uses the `--selected` background and `--primary` color. `icon-btn-sm` is 28px (44px under coarse pointers).
- **Tooltips.** `[data-tip]` has `position: relative`. `[data-tip]:hover::after` shows a tooltip on `--popover` with `--shadow-float`, `--text-xs`, padding 4px 8px, `--r-1` radius, above center, `white-space: nowrap`, and a 450ms appearance delay. The tooltip is hidden under `@media (pointer: coarse)`.
- **Menus.** `.menu` uses the `--popover` background, 1px `--border`, `--r-3` radius, `--shadow-float`, 4px padding, and min-width 200px, with a scale-and-fade entry from `data-state=open` over `--dur`.
  - `.menu-item`: full-width flex, 8px gap, height 32px (44 coarse), padding 0 10px, radius `--r-1`, text-align left. Hover and focus use `--hover`, and `[data-highlighted]` (Radix Select) does too. `.is-danger` uses `--destructive` text.
  - `.menu-sep`: 1px `--border`, 4px margin. `.menu-label`: `--text-xs`, uppercase, 0.06em letter-spacing, `--muted-foreground`, padding 6px 10px.
- **Selects.** `.select` matches `.btn-secondary`, with space-between content and min-width 140px.
- **Segmented controls.** `.segmented` is inline-flex with a `--muted` background, 2px padding, and `--r-2` radius. Each `.segment` is 28px high, padding 0 10px, radius `--r-1`, with `--muted-foreground` text. `.is-on` gets the `--card` background, `--foreground` text, and a `0 1px 2px rgb(0 0 0 / .15)` shadow.
- **Chips.** `.chip` is 22px high, padding 0 8px, fully rounded, `--text-xs`, weight 500, with a `--muted` background. Tones mix their color at 18%: accent uses `--primary`, success `--chart-3`, warn `--chart-1`, danger `--destructive`.
  - `.speaker-chip` is inline-flex with a 6px gap and a `color-mix(in oklab, var(--speaker) 16%, transparent)` background. `.speaker-dot` is 7px in `var(--speaker)`. `.is-button:hover` raises the mix to 26%.
- **Overlay.** `.overlay` is fixed full-screen with the `--overlay` background and a fade.
- **Dialogs.** `.dialog` is fixed with the `--popover` background, `--r-3` radius, `--shadow-float`, and 1px `--border`. `.dialog-center` is centered, with width `min(92vw, 440px)` for `sm`, 560 for `md`, and 760 for `lg`.
  - `.dialog-side` is anchored right, full height, `min(92vw, 420px)` wide.
  - `.dialog-sheet` is anchored bottom, full width, max-height 85vh, with a top radius only, `padding-bottom: env(safe-area-inset-bottom)`, and a grab handle drawn with `::before`.
  - Under `@media (max-width: 639px)`, `.dialog-center` gets the sheet styles.
  - The head, body, and foot have 16px padding. The foot is flex, right-aligned, with an 8px gap and a top border.
- **Toasts.** `.toasts` is fixed bottom-right (bottom-center with full width minus 32px on phones, above the tab bar and safe area) with a column-reverse stack and an 8px gap. Each `.toast` is flex with a `--popover` background, `--shadow-float`, a 1px `--border`, and `--r-2` radius. Its icon is colored by kind: success `--chart-3`, error `--destructive`, info `--chart-2`.
- **Headers and empty states.** `.page-header` is flex, space-between, align end, with 16px bottom margin; `h1` uses `--text-2xl`. `.empty` is a centered column with 48px padding and `--muted-foreground`, and its `h3` uses `--foreground`.
- **Kbd.** `.kbd` uses `--font-code`, `--text-xs`, padding 1px 5px, 1px `--border`, a 2px bottom border, and `--r-1` radius.

- [ ] **Step 9: Fill in the gallery**

`desktop/src/dev/Gallery.tsx` renders every primitive in every variant:
- Buttons, including icon buttons with tooltips.
- A Menu with an icon, separator, label, checked, disabled, and danger entry.
- An opened Dialog in each variant: controlled by buttons, with a `?gallery&dialog=center|side|sheet` query that opens one on load.
- ConfirmDialog, Select, Segmented, the chip tones, SpeakerChips, PageHeader, Empty, Kbd, and three toasts triggered on mount.

Wrap it in `ToastProvider`.

- [ ] **Step 10: Screenshot and review the gallery**

With the dev server running: `node desktop/scripts/screens.mjs "$SCRATCH/screens" gallery`, plus `EXTRA='[{"name":"gallery-dialog","query":"gallery&dialog=center","hash":""},{"name":"gallery-sheet","query":"gallery&dialog=sheet","hash":""}]'`.
Open the desktop, phone, dark, and light images. Check the acceptance criteria:
- Controls line up on a single 32px height.
- Focus rings are visible when tabbing. Also verify this manually in a browser.
- Light-mode contrast is legible.
- Dialogs become bottom sheets at phone width.
- No literal colors: `grep -nE "#[0-9a-fA-F]{3,8}" desktop/src/ui/ui.css` prints nothing.

Fix and repeat until the criteria are met.

- [ ] **Step 11: Build and commit**

Run: `pnpm --dir desktop build`
```bash
git add desktop/package.json pnpm-lock.yaml desktop/src/ui desktop/src/lib/media-query.ts desktop/src/dev/Gallery.tsx desktop/src/main.tsx
git commit -m "Add Concord Next interface primitives on Radix with a design gallery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: App shell (router, sidebar, tab bar, top bar, command palette, activity)

**Files:**
- Create: `desktop/src/lib/router.ts`, `desktop/src/lib/router.test.ts`, `desktop/src/shell/{AppContext.tsx,Sidebar.tsx,TabBar.tsx,Topbar.tsx,CommandPalette.tsx,ActivityPanel.tsx,Brand.tsx,shell.css}`, `desktop/src/notes/NoteEditor.tsx`
- Modify: `desktop/src/App.tsx` (rewritten), `desktop/src/views.tsx` (pages take `useApp()` instead of callbacks where needed), `desktop/src-tauri/src/db.rs` (`palette`, `like_pattern`), `desktop/src-tauri/src/lib.rs`
- Test: `desktop/src/lib/router.test.ts`, the Rust tests `palette_groups_matches` and `migration_adds_library_state_to_existing_v1_database`

**Interfaces:**
- Consumes: `api`, primitives, `useAppearance`.
- Produces:
  - `Route`, `parseRoute`, and `formatRoute`, plus `useRoute(): { route, navigate(route, { replace? }) , back() }`.
  - Rust `migrate()` and `MEDIA_COLUMNS_V2` (schema v2: `starred`, `review_state`, `position`, `opened_at`).
  - `useApp(): AppContextValue` with `{ route, navigate, overview, refresh, revision, jobs, activeJob, device, setDevice, transcribe(id), openNote(note), openPalette() }`.
  - `NoteEditor({ note, onClose })`.
  - Rust `db::palette(root, query) -> Result<Value>` and `db::like_pattern(q) -> String`.

- [ ] **Step 1: Write the failing router tests**

`desktop/src/lib/router.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, formatRoute, type Route } from "./router.ts";

test("recording ids with JSON, slashes, ? and # round-trip", () => {
  const route: Route = { page: "recording", id: '["UC-x","a/b?c#d"]', at: 12.5 };
  const hash = formatRoute(route);
  assert.ok(!hash.slice(2).includes("#"));
  assert.deepEqual(parseRoute(hash), route);
});

test("search keeps its query; documents keep their id", () => {
  assert.deepEqual(parseRoute(formatRoute({ page: "search", q: "harbour lights & more" })), { page: "search", q: "harbour lights & more" });
  assert.deepEqual(parseRoute("#/documents/doc%3A1"), { page: "documents", id: "doc:1" });
  assert.equal(formatRoute({ page: "documents" }), "#/documents");
});

test("unknown, empty and malformed routes fall back to the library", () => {
  assert.deepEqual(parseRoute(""), { page: "library" });
  assert.deepEqual(parseRoute("#/nope"), { page: "library" });
  assert.deepEqual(parseRoute("#/recording/"), { page: "library" });
  assert.deepEqual(parseRoute("#/recording/abc?t=-3"), { page: "recording", id: "abc" });
  assert.deepEqual(parseRoute("#/recording/abc?t=x"), { page: "recording", id: "abc" });
  assert.deepEqual(parseRoute("#/speakers"), { page: "speakers" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir desktop test:ts`
Expected: FAIL (`router.ts` missing).

- [ ] **Step 3: Implement `router.ts`**

```ts
import { useCallback, useEffect, useState } from "react";

export type Route =
  | { page: "library" }
  | { page: "recording"; id: string; at?: number }
  | { page: "search"; q: string }
  | { page: "documents"; id?: string }
  | { page: "speakers" }
  | { page: "notes" }
  | { page: "map" }
  | { page: "settings" };
export type Page = Route["page"];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q < 0 ? "" : raw.slice(q + 1));
  const slash = path.indexOf("/");
  const head = slash < 0 ? path : path.slice(0, slash);
  const tail = slash < 0 ? "" : path.slice(slash + 1);
  switch (head) {
    case "recording": {
      if (!tail) return { page: "library" };
      const id = decodeURIComponent(tail);
      const at = Number(params.get("t"));
      return params.has("t") && Number.isFinite(at) && at >= 0 ? { page: "recording", id, at } : { page: "recording", id };
    }
    case "search":
      return { page: "search", q: params.get("q") ?? "" };
    case "documents":
      return tail ? { page: "documents", id: decodeURIComponent(tail) } : { page: "documents" };
    case "speakers":
    case "notes":
    case "map":
    case "settings":
      return { page: head };
    default:
      return { page: "library" };
  }
}

export function formatRoute(route: Route): string {
  switch (route.page) {
    case "recording":
      return `#/recording/${encodeURIComponent(route.id)}${route.at != null ? `?t=${Math.round(route.at * 10) / 10}` : ""}`;
    case "search":
      return route.q ? `#/search?${new URLSearchParams({ q: route.q })}` : "#/search";
    case "documents":
      return route.id ? `#/documents/${encodeURIComponent(route.id)}` : "#/documents";
    default:
      return `#/${route.page}`;
  }
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const hash = formatRoute(next);
    if (options?.replace) {
      history.replaceState(null, "", hash);
      setRoute(next);
    } else if (location.hash !== hash) {
      location.hash = hash;
    }
  }, []);
  const back = useCallback(() => history.back(), []);
  return { route, navigate, back };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir desktop test:ts`
Expected: PASS.

- [ ] **Step 5: Add `like_pattern` and `palette` in Rust, with a test**

In `desktop/src-tauri/src/db.rs`, add the functions below. Then change `library()` to call `like_pattern(query)` instead of building the pattern inline.
```rust
/// LIKE pattern that treats the user's text literally.
pub fn like_pattern(query: &str) -> String {
    format!(
        "%{}%",
        query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    )
}

/// Quick-jump results for the command palette.
pub fn palette(root: &Path, query: &str) -> Result<Value> {
    let db = open(root)?;
    let q = query.trim();
    if q.is_empty() {
        let recent = rows(&db, "SELECT id,title,channel,date FROM media WHERE opened_at IS NOT NULL ORDER BY opened_at DESC LIMIT 6", [])?;
        return Ok(json!({"recordings": recent, "speakers": [], "notes": [], "documents": []}));
    }
    let p = like_pattern(q);
    Ok(json!({
        "recordings": rows(&db, "SELECT id,title,channel,date FROM media WHERE title LIKE ?1 ESCAPE '\\' OR channel LIKE ?1 ESCAPE '\\' ORDER BY opened_at IS NULL, opened_at DESC, date DESC LIMIT 6", [&p])?,
        "speakers": rows(&db, "SELECT id,name,color FROM speakers WHERE name LIKE ?1 ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT 6", [&p])?,
        "notes": rows(&db, "SELECT id,title,media_id,start FROM notes WHERE title LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\' OR quote LIKE ?1 ESCAPE '\\' ORDER BY created_at DESC LIMIT 6", [&p])?,
        "documents": rows(&db, "SELECT id,title FROM docs WHERE title LIKE ?1 ESCAPE '\\' ORDER BY title COLLATE NOCASE LIMIT 6", [&p])?,
    }))
}
```
The empty-query branch needs `opened_at`, so this task also adds the versioned migration that Task 6 builds on.

In `open()`, remove `PRAGMA user_version=1;` from the `CREATE TABLE` batch, which would otherwise reset the version on every open. Make the connection `mut` and call `migrate(&mut db)?` before returning:
```rust
/// Columns added in schema version 2 (library state). Applied idempotently.
const MEDIA_COLUMNS_V2: [(&str, &str); 4] = [
    ("starred", "starred INTEGER NOT NULL DEFAULT 0"),
    ("review_state", "review_state TEXT NOT NULL DEFAULT 'unreviewed'"),
    ("position", "position REAL NOT NULL DEFAULT 0"),
    ("opened_at", "opened_at TEXT"),
];

fn migrate(db: &mut Connection) -> Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= 2 {
        return Ok(());
    }
    // Immediate: two windows opening at once must not both add the columns.
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (name, ddl) in MEDIA_COLUMNS_V2 {
        let present: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('media') WHERE name = ?1)",
            [name],
            |r| r.get(0),
        )?;
        if !present {
            tx.execute_batch(&format!("ALTER TABLE media ADD COLUMN {ddl}"))?;
        }
    }
    tx.execute_batch("PRAGMA user_version = 2")?;
    tx.commit()?;
    Ok(())
}
```
Migration test (add to `db.rs` tests):
```rust
#[test]
fn migration_adds_library_state_to_existing_v1_database() {
    let tmp = tempfile::tempdir().unwrap();
    let v1 = Connection::open(tmp.path().join("library.db")).unwrap();
    v1.execute_batch(
        "CREATE TABLE media (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
           channel TEXT NOT NULL DEFAULT 'Imports', date TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,
           path TEXT, transcript TEXT, words INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ready');
         INSERT INTO media(id,title) VALUES ('a','Old');
         PRAGMA user_version=1;",
    ).unwrap();
    drop(v1);
    let db = open(tmp.path()).unwrap();
    let row = &rows(&db, "SELECT starred, review_state, position, opened_at FROM media WHERE id='a'", []).unwrap()[0];
    assert_eq!(row["starred"], 0);
    assert_eq!(row["review_state"], "unreviewed");
    assert_eq!(row["position"], 0.0);
    assert!(row["opened_at"].is_null());
    assert_eq!(db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    drop(db);
    open(tmp.path()).unwrap(); // reopening is a no-op, not a duplicate-column error
}
```
Palette test (add to `db.rs` tests):
```rust
#[test]
fn palette_groups_matches() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("next");
    open(&root).unwrap().execute_batch(
        "INSERT INTO media(id,title,channel) VALUES ('a','Alpha meeting','Meetings');
         INSERT INTO speakers(id,name) VALUES ('s','Sarah');
         INSERT INTO notes(id,title,body) VALUES ('n','Alpha thoughts','');
         INSERT INTO docs(id,title,body) VALUES ('d','Alpha paper','x');",
    ).unwrap();
    let r = palette(&root, "alpha").unwrap();
    assert_eq!(r["recordings"][0]["id"], "a");
    assert_eq!(r["notes"][0]["id"], "n");
    assert_eq!(r["documents"][0]["id"], "d");
    assert_eq!(palette(&root, "sar").unwrap()["speakers"][0]["name"], "Sarah");
    assert!(palette(&root, "  ").unwrap()["recordings"].as_array().unwrap().is_empty());
    open(&root).unwrap().execute("UPDATE media SET opened_at=datetime('now')", []).unwrap();
    assert_eq!(palette(&root, "").unwrap()["recordings"][0]["id"], "a");
}
```
Wire the command in `lib.rs`:
```rust
#[tauri::command]
async fn palette(state: State<'_, AppState>, query: String) -> Result<Value, String> {
    let root = state.root.clone();
    work(move || db::palette(&root, &query)).await
}
```
Then add `palette` to `generate_handler!`.

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml -- palette migration`
Expected: PASS, and the existing tests still pass.

- [ ] **Step 6: Build AppContext and the rewritten App**

`desktop/src/shell/AppContext.tsx` exports `AppContext`, `useApp()` (which throws outside the provider), and this type:
```ts
export type AppContextValue = {
  route: Route;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  overview?: Overview;
  revision: number;
  refresh: () => void;
  jobs: Job[];
  activeJob?: Job;
  device: string;
  setDevice: (device: string) => void;
  transcribe: (id: string) => Promise<void>;
  openNote: (note: Note) => void;
  openPalette: () => void;
  /** Title shown in the top bar; pages like the player set it and clear it (null) on unmount. */
  pageTitle: string | null;
  setPageTitle: (title: string | null) => void;
};
```

`desktop/src/App.tsx` responsibilities, each implemented here:
- Wrap everything in `ToastProvider`, then an inner `Shell`.
- **Data:** load `overview` on mount and on `revision`. If `!api.available()`, show a full-page Empty: "Open Concord Next as a desktop app".
- **Job polling:** `api.jobs()` every 1500 ms while any job is `running`, otherwise every 5000 ms. When the joined `id+status` signature changes, call `refresh()`.
- **Device:** `useStoredState("speech-device", "auto")`.
- **transcribe(id):** `await api.transcribe(id, device)`, then toast "Transcription started" with an "Activity" action that opens the panel. Errors raise an error toast.
- **openNote(note):** mounts `NoteEditor`.
- **Layout:** `<div className="shell" data-rail={collapsed}>`, containing:
  - `<Sidebar/>`, hidden on phones.
  - `<main className="main">` with `<Topbar/>` and `<div className="page" key={pageKey}>{page}</div>`.
  - `<TabBar/>`, phones only.
  - `<CommandPalette/>` and `<ActivityPanel/>`.
- **Page switch** on `route.page`. Until Tasks 7/10/12/13 replace them, wrap the existing `views.tsx` components with their current props. For example, `LibraryView` gets `onOpen={(id) => navigate({ page: "recording", id })}`, and `Player` gets `id`/`at` from the route and `onBack={() => back()}`.
- **Global shortcut:** Ctrl/⌘+K toggles the palette via `useShortcuts`, a small subset defined inline until Task 8 adds `lib/shortcuts.ts`. Use a `keydown` listener that checks `(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k"`.
- **Sidebar collapse:** stored in `useStoredState("sidebar-collapsed-v1", false)`, and forced to the rail by `RAIL` width.

`NoteEditor.tsx` is a `Dialog` titled "Research note":
- It has a title input (autofocus), a blockquote showing the quote when present, and a body textarea at least 8 rows high, set in the reading font.
- The footer has "Open source" (when `media_id` is set; it navigates to `{page:"recording", id, at: start}` and closes) and "Save note" (primary, disabled while the title is empty).
- On save it calls `api.saveNote`, closes, toasts "Note saved", and calls `refresh()`.

- [ ] **Step 7: Build Sidebar, TabBar, Topbar, and Brand**

**`Brand`:** the `concord-icon.svg` image at 26px beside the word "Concord" in `--font-serif` at 19px, weight 600, with -0.01em letter-spacing. In the rail it shows the icon only. No cream plate.

**`Sidebar`:**
- Groups:
  - **Archive:** Library, Search, Documents, Notes.
  - **Analysis:** Speakers, Map.
- Icons: lucide `Library, Search, FileText, NotebookPen, Users, Network`.
- The library count shows as a trailing `.num` badge.
- Bottom:
  - The activity button. It shows `LoaderCircle` spinning with `activeJob.title` and `message` on two lines, truncated; otherwise `Check` with "No activity".
  - Settings.
  - The collapse toggle (`PanelLeftClose`/`PanelLeftOpen`).
- The active item has a `--sidebar-accent` background, a `--sidebar-primary` icon, and a 2px `--sidebar-primary` inset left bar.
- In the rail (56px), labels are hidden and shown as tooltips via `data-tip`.

**`TabBar`** (phones):
- Fixed to the bottom, `height: calc(var(--tabbar-h) + env(safe-area-inset-bottom))`.
- Five equal buttons: Library, Search, Notes, Speakers, More. Each has a 20px icon over an 11px label, and the active one uses the `--primary` color.
- More opens a `Sheet` listing Documents, Map, Activity, and Settings.

**`Topbar`:**
- Holds the page title: `useApp().pageTitle` when set (the player sets the recording title), and otherwise the page name.
- Also on the bar:
  - A palette trigger button styled as a field: "Search or jump to…" plus `<Kbd>Ctrl K</Kbd>`. On phones it becomes an icon button.
  - "Add recordings" (primary): `api.pickMedia()`, then `api.importMedia(paths)`, then toast `count(n, "recording") + " added"`, then refresh.
- On phones the title is truncated and "Add recordings" shows only on the library page, as an icon button.

- [ ] **Step 8: Build CommandPalette and ActivityPanel**

**`CommandPalette`:**
- Uses `Command.Dialog` from `cmdk` with `shouldFilter={false}`, and is styled with `.palette`: 640px wide, 14vh from the top, and full-screen on phones.
- The input is debounced by 120 ms and calls `api.palette(q)`.
- Groups:
  - **Recordings:** title, collection · date; opens the recording.
  - **Speakers:** a color dot; navigates to `{page:"speakers"}`.
  - **Notes:** opens the note via `openNote`, fetching from `api.research()` by id.
  - **Documents:** opens `{page:"documents", id}`.
  - **Actions:**
    - "Search transcripts for “q”" (when q is set) → `{page:"search", q}`.
    - "Add recordings", "Go to Library/Search/Documents/Notes/Speakers/Map/Settings".
    - "Switch to light/dark mode" (uses `useAppearance`).
- With an empty query it shows "Recent" (the palette's recent recordings) and Actions.
- Enter selects. Esc closes. Arrow keys are handled by cmdk.

**`ActivityPanel`:**
- A `Dialog variant="side"` titled "Activity".
- Lists jobs: title, status chip (running → accent with a spinner; complete → success; failed/interrupted → danger; cancelled → neutral), and message.
- A running job gets a "Cancel processing" ghost button that calls `api.cancelTranscription()`.
- Empty state: "Transcription jobs appear here."

- [ ] **Step 9: Write `shell.css`**

- **Desktop grid.** `.shell` is a grid with `grid-template-columns: var(--sidebar-w) 1fr`; `[data-rail=true]` and `@media (max-width:1199px)` switch it to `var(--rail-w) 1fr`.
- **Sidebar.** Sticky, full height, `--sidebar` background, 1px `--sidebar-border` right border, 12px padding.
- **Nav rows.** 34px high (44 coarse), `--r-2` radius, 10px gap, `--text-md`.
- **Group labels.** `--text-xs`, uppercase, 0.08em letter-spacing, `--muted-foreground`, margin 18px 10px 6px.
- **Main area.** `.main` has min-width 0. `.topbar` is sticky at the top with `--topbar-h` height and a background of `color-mix(in oklab, var(--background) 86%, transparent)` with `backdrop-filter: blur(10px)`. It has a bottom border and padding 0 24px.
- **Page.** `.page` has padding 20px 24px 40px and max-width 1680px.
- **Phones** (`@media (max-width:639px)`):
  - The shell becomes a single column. The sidebar is `display:none`.
  - `.page` has padding 12px 12px `calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 16px)`.
  - `.topbar` has padding 0 12px, height 48px, and `padding-top: env(safe-area-inset-top)`.
- **Tab bar.** `.tabbar` is fixed at the bottom, a 5-column grid, with the `--sidebar` background and a top border.
- **Palette.** `.palette [cmdk-input]` is 48px high, `--text-lg`, with no border and a bottom border. `[cmdk-item][data-selected=true]` uses the `--hover` background. `[cmdk-group-heading]` uses the `.menu-label` styles.

- [ ] **Step 10: Verify**

1. Run: `pnpm --dir desktop test:ts && pnpm --dir desktop build && cargo test --manifest-path desktop/src-tauri/Cargo.toml`
2. Take screenshots: `node desktop/scripts/screens.mjs "$SCRATCH/screens" library` plus `EXTRA='[{"name":"palette","hash":"#/library","after":"document.dispatchEvent(new KeyboardEvent(\"keydown\",{key:\"k\",ctrlKey:true}))"}]'`.
3. Check the acceptance criteria:
   - The sidebar looks right at desktop width, as a rail at 960, and as the tab bar on phones.
   - The palette opens with Recent and Actions.
   - The brand renders with the serif wordmark.
   - The old library content renders inside the new shell.
4. Manual check in a browser at `http://127.0.0.1:1420/?mock#/search?q=harbour`: the page loads with the query filled in, and Back returns to the previous page.

- [ ] **Step 11: Commit**

```bash
git add desktop/src desktop/src-tauri/src/db.rs desktop/src-tauri/src/lib.rs
git commit -m "Build the Concord Next shell with hash routes, grouped navigation, phone tab bar, and command palette

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Library backend (filters, sorts, speaker chips, star/review/position)

**Files:**
- Modify: `desktop/src-tauri/src/db.rs`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/thumbnail.rs` (reuse `AUDIO_EXTENSIONS`), `desktop/src/lib/ipc.ts` (remove `libraryLegacy`), `desktop/src/views.tsx` (LibraryView passes a `LibraryFilter`)
- Test: `db.rs` tests

**Interfaces:**
- Consumes: `migrate()` and `MEDIA_COLUMNS_V2` (Task 5), and `like_pattern`.
- Produces:
  - `db::AUDIO_EXTENSIONS: [&str; 8]` and `db::LibraryFilter`.
  - `db::library(root, &LibraryFilter) -> Result<Value>`, returning `{items, total, transcribed, channels}`.
  - Each item carries `kind`, `speakers` (top 3 `{name,color,airtime}`), `speaker_total`, and `speaker_count`.
  - `db::set_starred(root, id, bool)`, `db::set_review(root, id, &str)`, `db::save_position(root, id, f64)`, and `db::REVIEW_STATES`.
  - `db::media` and `db::transcript` now include `kind`, and `transcript` includes `notes: [{id,title,start,end}]`.
  - Tauri commands `library(filter)`, `set_starred(id, starred)`, `set_review(id, state)`, `save_position(id, seconds)`.

- [ ] **Step 1: Write the failing library test**

Add to `db.rs` tests:
```rust
fn library_fixture() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("next");
    open(&root).unwrap().execute_batch(
        "INSERT INTO media(id,title,channel,date,duration,path,transcript,words) VALUES
           ('a','Alpha meeting','Meetings','20251007',8100,'/m/alpha.ogg','/t/alpha.md',9000),
           ('b','Beta interview','Interviews','20250102',1200,'/m/beta.mp4',NULL,0),
           ('c','Gamma talk','Meetings','20240505',600,'/m/gamma.webm','/t/gamma.md',500);
         INSERT INTO speakers(id,name,color) VALUES ('s1','Sarah','#ff0000'),('s2','Tom',NULL);
         INSERT INTO assignments(media_id,local_id,speaker_id,airtime) VALUES
           ('a','S0','s1',300),('a','S1','s2',900),('a','S2',NULL,50),('a','S3','s1',100);
         INSERT INTO notes(id,title,media_id,start,end) VALUES ('n1','Key moment','a',10,20),('n2','No time','a',NULL,NULL);",
    ).unwrap();
    (tmp, root)
}

fn ids(v: &Value) -> Vec<String> {
    v["items"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn library_filters_sorts_and_summarises_speakers() {
    let (_tmp, root) = library_fixture();
    let all = library(&root, &LibraryFilter::default()).unwrap();
    assert_eq!(all["total"], 3);
    assert_eq!(all["transcribed"], 2);
    assert_eq!(ids(&all), ["a", "b", "c"]);
    let alpha = &all["items"][0];
    assert_eq!(alpha["kind"], "audio");
    assert_eq!(all["items"][1]["kind"], "video");
    assert_eq!(alpha["speaker_count"], 4);
    assert_eq!(alpha["speaker_total"], 2);
    assert_eq!(alpha["speakers"][0]["name"], "Tom");
    assert_eq!(alpha["speakers"][1]["name"], "Sarah");
    assert_eq!(alpha["speakers"][1]["airtime"], 400.0);
    assert_eq!(alpha["speakers"][1]["color"], "#ff0000");
    let only = |edit: fn(&mut LibraryFilter)| {
        let mut filter = LibraryFilter::default();
        edit(&mut filter);
        ids(&library(&root, &filter).unwrap())
    };
    assert_eq!(only(|f| f.kind = "video".into()), ["b", "c"]);
    assert_eq!(only(|f| f.kind = "audio".into()), ["a"]);
    assert_eq!(only(|f| f.transcribed = "no".into()), ["b"]);
    assert_eq!(only(|f| f.channel = "Meetings".into()), ["a", "c"]);
    assert_eq!(only(|f| f.query = "interv".into()), ["b"]);
    assert_eq!(only(|f| f.query = "meetings".into()), ["a", "c"]);
    assert_eq!(only(|f| f.query = "gamma.webm".into()), ["c"]);
    assert_eq!(only(|f| f.query = "%".into()), Vec::<String>::new());
    assert_eq!(only(|f| f.sort = "oldest".into()), ["c", "b", "a"]);
    assert_eq!(only(|f| f.sort = "longest".into()), ["a", "b", "c"]);
    assert_eq!(only(|f| f.sort = "words".into()), ["a", "c", "b"]);
    assert_eq!(only(|f| f.sort = "title".into()), ["a", "b", "c"]);
    assert_eq!(only(|f| f.sort = "anything-else".into()), ["a", "b", "c"]);
    let mut paged = LibraryFilter { limit: 60, offset: 2, ..Default::default() };
    assert_eq!(ids(&library(&root, &paged).unwrap()), ["c"]);
    paged.limit = 7; // not an allowed page size, falls back to 60
    assert_eq!(ids(&library(&root, &paged).unwrap()), ["c"]);
}

#[test]
fn star_review_and_position_update_one_recording() {
    let (_tmp, root) = library_fixture();
    set_starred(&root, "c", true).unwrap();
    set_review(&root, "b", "reviewed").unwrap();
    save_position(&root, "b", 42.5).unwrap();
    save_position(&root, "a", -3.0).unwrap();
    let filtered = |f: LibraryFilter| ids(&library(&root, &f).unwrap());
    assert_eq!(filtered(LibraryFilter { starred: true, ..Default::default() }), ["c"]);
    assert_eq!(filtered(LibraryFilter { review: "reviewed".into(), ..Default::default() }), ["b"]);
    assert_eq!(filtered(LibraryFilter { sort: "opened".into(), ..Default::default() })[2], "c");
    assert_eq!(media(&root, "b").unwrap()["position"], 42.5);
    assert_eq!(media(&root, "a").unwrap()["position"], 0.0);
    assert!(set_review(&root, "b", "archived").is_err());
    assert!(set_starred(&root, "missing", true).is_err());
    assert!(save_position(&root, "b", f64::NAN).is_err());
}

#[test]
fn recording_includes_kind_and_timed_notes() {
    let (_tmp, root) = library_fixture();
    let rec = transcript(&root, "a").unwrap();
    assert_eq!(rec["media"]["kind"], "audio");
    let notes = rec["notes"].as_array().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0]["title"], "Key moment");
    assert_eq!(notes[0]["start"], 10.0);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml library_ star_ recording_includes`
Expected: compile errors (`LibraryFilter`, `set_starred`, … not found).

- [ ] **Step 3: Implement the filter, kinds, speaker chips, and state commands**

In `db.rs` (add `use serde::Deserialize; use std::collections::HashMap;`):
```rust
pub const AUDIO_EXTENSIONS: [&str; 8] = ["ogg", "oga", "opus", "mp3", "m4a", "wav", "flac", "aac"];
pub const REVIEW_STATES: [&str; 3] = ["unreviewed", "in_review", "reviewed"];

/// SQL expression classifying `m` as audio or video by file extension.
fn kind_sql() -> String {
    let tests: Vec<String> = AUDIO_EXTENSIONS
        .iter()
        .map(|e| format!("lower(coalesce(m.path,'')) LIKE '%.{e}'"))
        .collect();
    format!("CASE WHEN {} THEN 'audio' ELSE 'video' END", tests.join(" OR "))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryFilter {
    pub query: String,
    pub channel: String,
    pub kind: String,
    pub transcribed: String,
    pub starred: bool,
    pub review: String,
    pub sort: String,
    pub offset: u32,
    pub limit: u32,
}

fn order_by(sort: &str) -> &'static str {
    match sort {
        "oldest" => "m.date ASC, m.title COLLATE NOCASE",
        "opened" => "m.opened_at IS NULL, m.opened_at DESC, m.date DESC",
        "words" => "m.words DESC, m.date DESC",
        "title" => "m.title COLLATE NOCASE, m.date DESC",
        "longest" => "m.duration DESC, m.date DESC",
        _ => "m.date DESC, m.title COLLATE NOCASE",
    }
}

pub fn library(root: &Path, f: &LibraryFilter) -> Result<Value> {
    let db = open(root)?;
    let kind = kind_sql();
    let query = f.query.trim();
    let pattern = like_pattern(query);
    let filter = format!(
        "(?1 = '' OR m.title LIKE ?2 ESCAPE '\\' OR m.channel LIKE ?2 ESCAPE '\\' OR coalesce(m.path,'') LIKE ?2 ESCAPE '\\')
         AND (?3 = '' OR m.channel = ?3)
         AND (?4 = '' OR {kind} = ?4)
         AND (?5 = '' OR (?5 = 'yes') = (m.transcript IS NOT NULL))
         AND (?6 = 0 OR m.starred = 1)
         AND (?7 = '' OR m.review_state = ?7)"
    );
    let args: [&dyn rusqlite::ToSql; 7] = [&query, &pattern, &f.channel, &f.kind, &f.transcribed, &f.starred, &f.review];
    let (total, transcribed): (i64, i64) = db.query_row(
        &format!("SELECT count(*), coalesce(sum(m.transcript IS NOT NULL), 0) FROM media m WHERE {filter}"),
        &args[..],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let limit = if [60, 120, 240].contains(&f.limit) { f.limit } else { 60 };
    let paged: [&dyn rusqlite::ToSql; 8] = [&query, &pattern, &f.channel, &f.kind, &f.transcribed, &f.starred, &f.review, &f.offset];
    let mut items = rows(
        &db,
        &format!(
            "SELECT m.*, {kind} AS kind, (SELECT count(*) FROM assignments a WHERE a.media_id = m.id) AS speaker_count
             FROM media m WHERE {filter} ORDER BY {} LIMIT {limit} OFFSET ?8",
            order_by(&f.sort)
        ),
        &paged[..],
    )?;
    attach_speakers(&db, &mut items)?;
    Ok(json!({
        "items": items,
        "total": total,
        "transcribed": transcribed,
        "channels": rows(&db, "SELECT DISTINCT channel FROM media ORDER BY channel COLLATE NOCASE", [])?,
    }))
}

/// Named voices per recording, loudest first; the Library shows the top three.
fn attach_speakers(db: &Connection, items: &mut [Value]) -> Result<()> {
    let ids: Vec<&str> = items.iter().filter_map(|m| m["id"].as_str()).collect();
    let found = rows(
        db,
        "SELECT a.media_id, s.name, s.color, sum(a.airtime) AS airtime
         FROM assignments a JOIN speakers s ON s.id = a.speaker_id
         WHERE a.media_id IN (SELECT value FROM json_each(?1))
         GROUP BY a.media_id, s.id ORDER BY a.media_id, airtime DESC",
        [serde_json::to_string(&ids)?],
    )?;
    let mut by_media: HashMap<String, Vec<Value>> = HashMap::new();
    for row in found {
        let id = row["media_id"].as_str().unwrap_or_default().to_owned();
        by_media
            .entry(id)
            .or_default()
            .push(json!({"name": row["name"], "color": row["color"], "airtime": row["airtime"]}));
    }
    for item in items {
        let list = by_media.remove(item["id"].as_str().unwrap_or_default()).unwrap_or_default();
        item["speaker_total"] = json!(list.len());
        item["speakers"] = json!(list.into_iter().take(3).collect::<Vec<_>>());
    }
    Ok(())
}

fn update_media(root: &Path, sql: &str, args: impl rusqlite::Params) -> Result<()> {
    let changed = open(root)?.execute(sql, args)?;
    anyhow::ensure!(changed == 1, "Recording not found");
    Ok(())
}

pub fn set_starred(root: &Path, id: &str, starred: bool) -> Result<()> {
    update_media(root, "UPDATE media SET starred = ?1 WHERE id = ?2", params![starred, id])
}

pub fn set_review(root: &Path, id: &str, state: &str) -> Result<()> {
    anyhow::ensure!(REVIEW_STATES.contains(&state), "Unknown review state: {state}");
    update_media(root, "UPDATE media SET review_state = ?1 WHERE id = ?2", params![state, id])
}

pub fn save_position(root: &Path, id: &str, seconds: f64) -> Result<()> {
    anyhow::ensure!(seconds.is_finite(), "Invalid playback position");
    update_media(
        root,
        "UPDATE media SET position = max(0, ?1), opened_at = datetime('now') WHERE id = ?2",
        params![seconds, id],
    )
}
```
Change `media()` to `SELECT m.*, {kind} AS kind FROM media m WHERE m.id = ?1`, using `kind_sql()`. In `transcript()`, add:
```rust
let notes = rows(&db, "SELECT id, title, start, end FROM notes WHERE media_id = ?1 AND start IS NOT NULL ORDER BY start", [id])?;
```
and include `"notes": notes` in the returned JSON. Delete the old `library(root, query, channel, offset)`. In `thumbnail.rs`, replace the inline audio extension list with `db::AUDIO_EXTENSIONS.contains(&ext.as_str())`.

- [ ] **Step 4: Wire the commands**

In `lib.rs`:
```rust
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
```
Tauri derives argument names from parameter names, so `state_name` means the JS side must send `stateName`. Update `api.setReview` to `call("set_review", { id, stateName: state })`. Add the four commands to `generate_handler!`. Remove `api.libraryLegacy`. Change the temporary `LibraryView` to call `api.library({ query, channel, kind: "", transcribed: "", starred: false, review: "", sort: "newest", offset, limit: 60 })`.

- [ ] **Step 5: Run the tests, clippy, and build**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings && pnpm --dir desktop build`
Expected: all pass (the existing 8 tests plus the new ones; the real-speech test stays ignored).

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src desktop/src/lib/ipc.ts desktop/src/views.tsx
git commit -m "Give the library filters, sorts, speaker chips, stars, review states, and resume positions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Library page

**Files:**
- Create: `desktop/src/lib/session.ts`, `desktop/src/lib/speakers.ts`, `desktop/src/lib/speakers.test.ts`, `desktop/src/lib/clipboard.ts`, `desktop/src/library/{LibraryPage.tsx,Toolbar.tsx,RecordingCard.tsx,RecordingRow.tsx,Cover.tsx,recordingMenu.ts,Welcome.tsx,library.css}`
- Modify: `desktop/src/App.tsx` (use `LibraryPage`), `desktop/src/views.tsx` (delete `LibraryView`, `RecordingCover`)

**Interfaces:**
- Consumes:
  - `api.library`, `api.setStarred`, `api.setReview`, `api.reveal`, `api.thumbnail`, `api.importLegacy`, `api.pickDatabase`.
  - `useApp()`, the primitives, and `format.ts`.
- Produces:
  - `setLibraryOrder(items: {id,title}[])` and `neighbors(id): { previous?: {id,title}; next?: {id,title} }`.
  - `SPEAKER_COLORS`, `speakerColor(color, key)`, and `voiceLabel(local)`.
  - `copyText(text): Promise<void>`.
  - `recordingMenu(media, actions): MenuEntry[]`.

- [ ] **Step 1: Write the failing speaker tests**

`desktop/src/lib/speakers.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEAKER_COLORS, speakerColor, voiceLabel } from "./speakers.ts";

test("stored colors win; missing or invalid colors get a stable palette color", () => {
  assert.equal(speakerColor("#ff0000", "S0"), "#ff0000");
  const a = speakerColor(null, "S2");
  assert.ok((SPEAKER_COLORS as readonly string[]).includes(a));
  assert.equal(speakerColor(undefined, "S2"), a);
  assert.ok((SPEAKER_COLORS as readonly string[]).includes(speakerColor("red", "S2")));
});

test("unnamed local voices read as numbered speakers", () => {
  assert.equal(voiceLabel("S0"), "Speaker 1");
  assert.equal(voiceLabel("S11"), "Speaker 12");
  assert.equal(voiceLabel("guest"), "guest");
  assert.equal(voiceLabel(""), "Unknown speaker");
});
```

- [ ] **Step 2: Run the tests to verify they fail, then implement `speakers.ts`, `session.ts`, `clipboard.ts`**

Run: `pnpm --dir desktop test:ts` and expect a FAIL. Then:

`desktop/src/lib/speakers.ts`:
```ts
export const SPEAKER_COLORS = [
  "#e0a24b", "#6fb3d2", "#9ccf8a", "#d68ab4", "#a79bdc",
  "#e57f6a", "#5fc4b8", "#c9b458", "#8fa3c8", "#d99a6c",
] as const;

function hashIndex(key: string, size: number): number {
  let h = 2166136261;
  for (const ch of key) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % size;
}

export function speakerColor(color: string | null | undefined, key: string): string {
  return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : SPEAKER_COLORS[hashIndex(key, SPEAKER_COLORS.length)];
}

export function voiceLabel(local: string): string {
  const match = /^S(\d+)$/.exec(local);
  return match ? `Speaker ${Number(match[1]) + 1}` : local || "Unknown speaker";
}
```

`desktop/src/lib/session.ts`:
```ts
export type Neighbor = { id: string; title: string };
let order: Neighbor[] = [];
export function setLibraryOrder(items: Neighbor[]): void {
  order = items.map(({ id, title }) => ({ id, title }));
}
export function neighbors(id: string): { previous?: Neighbor; next?: Neighbor } {
  const i = order.findIndex((n) => n.id === id);
  return i < 0 ? {} : { previous: order[i - 1], next: order[i + 1] };
}
```

`desktop/src/lib/clipboard.ts`:
```ts
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* WebKitGTK may refuse the async clipboard; fall back to a selection copy. */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Copying to the clipboard is not available here");
}
```
Run `pnpm --dir desktop test:ts` and expect a PASS.

- [ ] **Step 3: Write `recordingMenu.ts`**

```ts
import { Play, History, Sparkles, Star, StarOff, FolderOpen, Copy, Circle, CircleDot, CircleCheck } from "lucide-react";
import type { MenuEntry } from "../ui/Menu.tsx";
import type { Media, ReviewState } from "../lib/types.ts";
import { clock } from "../lib/format.ts";

export type RecordingActions = {
  open(at?: number): void;
  transcribe(): void;
  setStarred(starred: boolean): void;
  setReview(state: ReviewState): void;
  reveal(): void;
  copyPath(): void;
  transcribeDisabled: boolean;
};

export const REVIEW_LABELS: Record<ReviewState, string> = { unreviewed: "Unreviewed", in_review: "In review", reviewed: "Reviewed" };
const REVIEW_ICONS = { unreviewed: Circle, in_review: CircleDot, reviewed: CircleCheck };

export function recordingMenu(m: Media, a: RecordingActions): MenuEntry[] {
  return [
    { label: "Open", icon: Play, onSelect: () => a.open() },
    ...(m.position > 5 ? [{ label: `Resume at ${clock(m.position)}`, icon: History, onSelect: () => a.open(m.position) }] : []),
    { label: m.transcript ? "Re-transcribe" : "Transcribe", icon: Sparkles, onSelect: a.transcribe, disabled: a.transcribeDisabled || !m.path },
    { kind: "separator" },
    { kind: "label", label: "Review" },
    ...(Object.keys(REVIEW_LABELS) as ReviewState[]).map((s) => ({
      label: REVIEW_LABELS[s], icon: REVIEW_ICONS[s], checked: m.review_state === s, onSelect: () => a.setReview(s),
    })),
    { kind: "separator" },
    m.starred
      ? { label: "Remove star", icon: StarOff, onSelect: () => a.setStarred(false) }
      : { label: "Star", icon: Star, onSelect: () => a.setStarred(true) },
    { label: "Show file in folder", icon: FolderOpen, onSelect: a.reveal, disabled: !m.path },
    { label: "Copy file path", icon: Copy, onSelect: a.copyPath, disabled: !m.path },
  ];
}
```
`api.reveal` lands in Task 9. Until then, the action calls `api.reveal(path)`; the rejection surfaces as an error toast in the real app, and the mock resolves it.

- [ ] **Step 4: Build the Library components**

**`LibraryPage`:**
- **State:**
  - `filter`: `useStoredState<LibraryFilter>("library-filter-v1", DEFAULT_FILTER, isFilter)`, where `DEFAULT_FILTER = { query: "", channel: "", kind: "", transcribed: "", starred: false, review: "", sort: "newest", offset: 0, limit: 60 }` and `isFilter` checks the value is an object with a string `sort`.
  - `view`: `useStoredState<"grid"|"list">("library-view-v1", "grid")`.
  - `data?: LibraryPage` and `loading: boolean`.
- **Loading:** debounce 150 ms after a `filter` change and on `revision`, then call `api.library(filter)`. Stale responses are ignored with an `alive` flag. On success, call `setLibraryOrder(items)`.
- **Changing any field other than `offset` resets `offset` to 0.**
- **Optimistic updates:**
  - Star: flip `starred` in `data.items` first, call `api.setStarred`, and on error revert and toast.
  - Review: the same pattern.
- **Welcome:** if `overview?.media === 0`, render `<Welcome/>` (restyled from the old welcome) instead.
- **Scroll restoration:** keep a module-level `let lastScroll = 0`. Save `document.scrollingElement.scrollTop` on unmount, and restore it after the first data load when the route came back from a recording.

**`Toolbar`**, one row on desktop (wrapping at the icon-rail width):
- A search field with a `Search` icon, placeholder "Filter by title, collection, or file…", `Esc` to clear, and width 280px.
- The collection `Select` (label "Collection"; the first option "All collections"; options from `data.channels`).
- A **Filters** button with a count badge of active filters among kind, transcribed, starred, and review. On desktop it opens a Popover; on phones, a `Sheet`. The content:
  - Segmented Type (All/Audio/Video).
  - Segmented Transcript (Any/Transcribed/Not yet).
  - Segmented Review (Any/Unreviewed/In review/Reviewed).
  - A "Starred only" switch styled as a toggle button.
  - A Reset ghost button.
- The sort `Select`: Newest, Oldest, Recently opened, Most words, Title, Longest.
- The view `Segmented`: icon-only `LayoutGrid`/`List`. Hidden on phones, where the list is forced.
- Below it, the summary line in `.num`: `count(total, "recording") · count(transcribed, "transcribed", "transcribed")`, plus "· filtered" when any filter is active. The right side reads "Loading…" while loading.

**`Cover`:**
- The IntersectionObserver lazy thumbnail from the old `RecordingCover`, using `api.thumbnail(id)`.
- Audio shows a tokenized gradient (`--secondary`→`--muted`) with a 34px `AudioLines` icon in `--muted-foreground`.
- A duration pill at the bottom-right (`humanDuration`, `.num`).
- A resume bar along the bottom edge, 3px in `--primary`, `width: position/duration`, shown when `position > 5`.

**`RecordingCard` (grid):**
- The whole card is a `button` that opens the recording (at the saved position if it's more than 5 s in).
- Contents:
  - The `Cover` at 16:9.
  - A star `IconButton`, top-left over the cover. Shown when starred, on card hover, and always on coarse pointers. It stops propagation.
  - The title, 2 lines clamped, `--text-md` weight 600.
  - `channel · prettyDate(date)` in `--muted-foreground` `--text-sm`.
  - A footer with up to 3 `SpeakerChip size="sm"` (colored with `speakerColor(color, name)`) plus a "+N" chip when `speaker_total > 3`.
  - On the right: a transcript state dot (none, or a muted "Not transcribed" chip) and a review chip only when it isn't "unreviewed" (in review = warn tone, reviewed = success tone).
  - A ⋮ `Menu` (`recordingMenu`) at the top-right of the body.
- Hover raises the border to `color-mix(--foreground 18%)`, with no transform.

**`RecordingRow` (list; also the phone layout):**
- A grid row at `--row-h`, with columns: star (32px) · date (96px, `.num`) · title and chips (1fr) · collection (160px) · duration (72px, `.num`, right) · words (80px, `.num`, right) · status (110px) · ⋮ (32px).
- A sticky header row labels the columns; the date, title, duration, and words headers are clickable to set the sort.
- On phones the row becomes a two-line compact card: a 64×36 cover on the left; title, then `collection · date · duration` on the right; star and ⋮ trailing.

**Pagination footer:** "Previous" / "N–M of total" / "Next", plus "Show" and a `Select` of 60/120/240.

`library.css`:
- `.recording-grid` is `grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))` with a 16px gap (12 on phones).
- Cards use the `--card` background, a 1px `--border`, and `--r-3` radius, with the cover clipped to the top radius.
- All colors come from tokens.

- [ ] **Step 5: Screenshot review**

With the dev server: `node desktop/scripts/screens.mjs "$SCRATCH/screens" library`, plus `EXTRA` shots:
- `library-filters`: runs `document.querySelector('[data-filters-trigger]').click()` after load.
- `library-menu`: runs `document.querySelector('.recording-card [aria-label="More actions"]').click()`.

Acceptance criteria:
- At 1440 there are 4–5 dense columns.
- Speaker chips are colored.
- Resume bars show on 4 cards.
- Starred stars are visible.
- The filters popover is aligned, and on phones it is a sheet.
- The list view has aligned numeric columns.
- The phone shows compact rows above the tab bar.
- Light mode is legible.

Fix and repeat until the criteria are met.

- [ ] **Step 6: Run the tests, build, and commit**

Run: `pnpm --dir desktop test:ts && pnpm --dir desktop build`
```bash
git add desktop/src
git commit -m "Rebuild the Library with dense grid and list views, filters, stars, review states, and resume

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Player logic (ranges, time store, shortcuts)

**Files:**
- Create: `desktop/src/lib/range.ts`, `desktop/src/lib/range.test.ts`, `desktop/src/lib/timeStore.ts`, `desktop/src/lib/timeStore.test.ts`, `desktop/src/lib/shortcuts.ts`, `desktop/src/lib/shortcuts.test.ts`
- Modify: `desktop/src/App.tsx` (the Ctrl+K listener switches to `useShortcuts`)

**Interfaces:**
- Produces:
  - `Range`, `Timed`, `Line`, `Turn`, `Part`, and `MIN_RANGE = 0.5`.
  - `indexAt`, `spanRange`, `overlaps`, `linesIn`, `clampRange`, `setIn`, `setOut`, `speakerTurns`, `findMatches`, and `markParts`.
  - `TimeStore`, `createTimeStore`, and `useTime`.
  - `Shortcut`, `isTypingTarget`, `isInteractiveTarget`, `matches`, and `useShortcuts(shortcuts, enabled?)`.

- [ ] **Step 1: Write the failing tests**

`desktop/src/lib/range.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexAt, spanRange, linesIn, clampRange, setIn, setOut, speakerTurns, findMatches, markParts } from "./range.ts";

const lines = [
  { start: 0, end: 4, text: "Hello there", speaker: "S0" },
  { start: 5, end: 9, text: "hello again", speaker: "S0" },
  { start: 9, end: 15, text: "Different voice", speaker: "S1" },
  { start: 18, end: 20, text: "Back again", speaker: "S0" },
];

test("indexAt finds the line playing at a time", () => {
  assert.equal(indexAt(lines, -1), -1);
  assert.equal(indexAt(lines, 0), 0);
  assert.equal(indexAt(lines, 4.5), 0);
  assert.equal(indexAt(lines, 9), 2);
  assert.equal(indexAt(lines, 100), 3);
  assert.equal(indexAt([], 3), -1);
});

test("spanRange covers lines in either order", () => {
  assert.deepEqual(spanRange(lines, 2, 0), { start: 0, end: 15 });
  assert.deepEqual(spanRange(lines, 1, 1), { start: 5, end: 9 });
});

test("linesIn returns overlapping line bounds or null", () => {
  assert.deepEqual(linesIn(lines, { start: 3, end: 10 }), [0, 2]);
  assert.deepEqual(linesIn(lines, { start: 5, end: 9 }), [1, 1]);
  assert.equal(linesIn(lines, { start: 15.5, end: 17 }), null);
  assert.equal(linesIn([], { start: 0, end: 1 }), null);
});

test("clampRange orders, bounds, and enforces a minimum length", () => {
  assert.deepEqual(clampRange({ start: 10, end: 5 }, 100), { start: 5, end: 10 });
  assert.deepEqual(clampRange({ start: -3, end: 2 }, 100), { start: 0, end: 2 });
  assert.deepEqual(clampRange({ start: 99.8, end: 140 }, 100), { start: 99.5, end: 100 });
  assert.deepEqual(clampRange({ start: 4, end: 4 }, 100), { start: 4, end: 4.5 });
  assert.deepEqual(clampRange({ start: 4, end: 30 }, 0), { start: 4, end: 30 });
});

test("setIn keeps a later end or extends to the line end", () => {
  assert.deepEqual(setIn(null, 5.5, lines, 100), { start: 5.5, end: 9 });
  assert.deepEqual(setIn({ start: 2, end: 20 }, 5.5, lines, 100), { start: 5.5, end: 20 });
  assert.deepEqual(setIn({ start: 2, end: 5.8 }, 5.5, lines, 100), { start: 5.5, end: 9 });
  assert.deepEqual(setIn(null, 16, lines, 100), { start: 16, end: 26 });
  assert.deepEqual(setIn(null, 95, [], 100), { start: 95, end: 100 });
});

test("setOut keeps an earlier start or starts at the line start", () => {
  assert.deepEqual(setOut(null, 12, lines, 100), { start: 9, end: 12 });
  assert.deepEqual(setOut({ start: 3, end: 20 }, 12, lines, 100), { start: 3, end: 12 });
  assert.deepEqual(setOut(null, 3, [], 100), { start: 0, end: 3 });
});

test("speakerTurns merges short gaps and skips unlabelled lines", () => {
  assert.deepEqual(speakerTurns([...lines, { start: 21, end: 22, text: "x" }]), [
    { start: 0, end: 9, speaker: "S0" },
    { start: 9, end: 15, speaker: "S1" },
    { start: 18, end: 20, speaker: "S0" },
  ]);
  assert.deepEqual(speakerTurns([]), []);
});

test("find and mark are case-insensitive", () => {
  assert.deepEqual(findMatches(lines, "HELLO"), [0, 1]);
  assert.deepEqual(findMatches(lines, "  "), []);
  assert.deepEqual(markParts("Hello hello!", "hello"), [
    { text: "Hello", mark: true }, { text: " ", mark: false }, { text: "hello", mark: true }, { text: "!", mark: false },
  ]);
  assert.deepEqual(markParts("abc", ""), [{ text: "abc", mark: false }]);
});
```

`desktop/src/lib/timeStore.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimeStore } from "./timeStore.ts";

test("time store notifies on change only and stops after unsubscribe", () => {
  const store = createTimeStore(1);
  let calls = 0;
  const stop = store.subscribe(() => calls++);
  store.set(1);
  store.set(2);
  assert.equal(store.get(), 2);
  assert.equal(calls, 1);
  stop();
  store.set(3);
  assert.equal(calls, 1);
});
```

`desktop/src/lib/shortcuts.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTypingTarget, isInteractiveTarget, matches } from "./shortcuts.ts";

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test("typing targets block shortcuts", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("buttons and menu items own Space and Enter", () => {
  assert.equal(isInteractiveTarget({ tagName: "BUTTON" }), true);
  assert.equal(isInteractiveTarget({ tagName: "A" }), true);
  assert.equal(isInteractiveTarget({ tagName: "DIV", role: "slider" }), true);
  assert.equal(isInteractiveTarget({ tagName: "DIV" }), false);
});

test("matches respects modifiers", () => {
  assert.equal(matches(key("k", { ctrlKey: true }), { key: "k", mod: true, run() {} }), true);
  assert.equal(matches(key("k", { metaKey: true }), { key: "k", mod: true, run() {} }), true);
  assert.equal(matches(key("k"), { key: "k", mod: true, run() {} }), false);
  assert.equal(matches(key("ArrowLeft", { shiftKey: true }), { key: "ArrowLeft", shift: false, run() {} }), false);
  assert.equal(matches(key("ArrowLeft", { shiftKey: true }), { key: "ArrowLeft", shift: true, run() {} }), true);
  assert.equal(matches(key("I", { shiftKey: true }), { key: "i", run() {} }), true);
  assert.equal(matches(key("<", { shiftKey: true }), { key: "<", run() {} }), true);
  assert.equal(matches(key("i", { altKey: true }), { key: "i", run() {} }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir desktop test:ts`
Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement `range.ts`**

```ts
export type Range = { start: number; end: number };
export type Timed = { start: number; end: number };
export type Line = Timed & { text: string; speaker?: string | null };
export type Turn = { start: number; end: number; speaker: string };
export type Part = { text: string; mark: boolean };
export const MIN_RANGE = 0.5;

/** The line playing at time t: the last line that starts at or before t, or -1. */
export function indexAt(lines: Timed[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function spanRange(lines: Timed[], a: number, b: number): Range {
  const [i, j] = a <= b ? [a, b] : [b, a];
  return { start: lines[i].start, end: lines[j].end };
}

export function overlaps(line: Timed, r: Range): boolean {
  return line.end > r.start && line.start < r.end;
}

export function linesIn(lines: Timed[], r: Range): [number, number] | null {
  let first = -1;
  let last = -1;
  for (let i = Math.max(0, indexAt(lines, r.start) - 1); i < lines.length && lines[i].start < r.end; i++) {
    if (overlaps(lines[i], r)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : [first, last];
}

export function clampRange(r: Range, duration: number, min = MIN_RANGE): Range {
  const lo = Math.min(r.start, r.end);
  const hi = Math.max(r.start, r.end);
  const max = duration > 0 ? duration : hi;
  let start = Math.min(Math.max(0, lo), max);
  let end = Math.min(Math.max(0, hi), max);
  if (end - start < min) {
    end = Math.min(max, start + min);
    start = Math.max(0, end - min);
  }
  return { start, end };
}

export function setIn(r: Range | null, t: number, lines: Timed[], duration: number): Range {
  let end: number;
  if (r && r.end > t + MIN_RANGE) end = r.end;
  else {
    const i = indexAt(lines, t);
    end = i >= 0 && lines[i].end > t + MIN_RANGE ? lines[i].end : t + 10;
  }
  return clampRange({ start: t, end }, duration);
}

export function setOut(r: Range | null, t: number, lines: Timed[], duration: number): Range {
  let start: number;
  if (r && r.start < t - MIN_RANGE) start = r.start;
  else {
    const i = indexAt(lines, t);
    start = i >= 0 && lines[i].start < t - MIN_RANGE ? lines[i].start : Math.max(0, t - 10);
  }
  return clampRange({ start, end: t }, duration);
}

export function speakerTurns(lines: Line[], gap = 2): Turn[] {
  const turns: Turn[] = [];
  for (const line of lines) {
    if (!line.speaker) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === line.speaker && line.start - last.end <= gap) last.end = Math.max(last.end, line.end);
    else turns.push({ start: line.start, end: line.end, speaker: line.speaker });
  }
  return turns;
}

export function findMatches(lines: { text: string }[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return lines.flatMap((l, i) => (l.text.toLowerCase().includes(q) ? [i] : []));
}

export function markParts(text: string, query: string): Part[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, mark: false }];
  const lower = text.toLowerCase();
  const parts: Part[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
    if (i > at) parts.push({ text: text.slice(at, i), mark: false });
    parts.push({ text: text.slice(i, i + needle.length), mark: true });
    at = i + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}
```
Check two cases against the implementation:
- `setIn(null, 16, lines, 100)`: `indexAt` returns 2 (line 9–15). Its end, 15, is not greater than 16.5, so `end = 26`, giving `{16, 26}`. ✓
- `setIn(null, 95, [], 100)`: `end = 105`, which `clampRange` bounds to `{95, 100}`. ✓

- [ ] **Step 4: Implement `timeStore.ts`**

```ts
import { useSyncExternalStore } from "react";
export type TimeStore = { get(): number; set(t: number): void; subscribe(listener: () => void): () => void };
export function createTimeStore(initial = 0): TimeStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(t) {
      if (t === value) return;
      value = t;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
/** Subscribe to a derived value so a component re-renders only when that value changes. */
export function useTime<T>(store: TimeStore, select: (t: number) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()));
}
```

- [ ] **Step 5: Implement `shortcuts.ts`**

```ts
import { useEffect, useRef } from "react";

export type KeyInput = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean };
export type Shortcut = {
  key: string;
  shift?: boolean;
  mod?: boolean;
  /** Fire even when focus is in a text field (used only for global mod shortcuts). */
  global?: boolean;
  run: (e: KeyboardEvent) => void;
};
type ElementLike = { tagName?: string; type?: string; isContentEditable?: boolean; role?: string | null; getAttribute?: (n: string) => string | null };

export function isTypingTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["checkbox", "radio", "button", "range", "submit", "reset"].includes((el.type ?? "text").toLowerCase());
}

export function isInteractiveTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el !== "object") return false;
  const tag = (el.tagName ?? "").toUpperCase();
  const role = el.role ?? el.getAttribute?.("role") ?? "";
  return ["BUTTON", "A", "SUMMARY"].includes(tag) || ["button", "menuitem", "slider", "radio", "tab", "option"].includes(role);
}

export function matches(e: KeyInput, s: Shortcut): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (!!s.mod !== mod || e.altKey) return false;
  if (s.shift !== undefined && s.shift !== e.shiftKey) return false;
  return e.key.toLowerCase() === s.key.toLowerCase();
}

export function useShortcuts(shortcuts: Shortcut[], enabled = true): void {
  const current = useRef(shortcuts);
  current.current = shortcuts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing = isTypingTarget(e.target);
      const dialogOpen = !!document.querySelector('[role="dialog"][data-state="open"]');
      const ownsKey = (e.key === " " || e.key === "Enter") && isInteractiveTarget(e.target);
      for (const s of current.current) {
        if (!s.global && (typing || dialogOpen || ownsKey)) continue;
        if (matches(e, s)) {
          e.preventDefault();
          s.run(e);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
```
Switch App's Ctrl+K handler to `useShortcuts([{ key: "k", mod: true, global: true, run: openPalette }])`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --dir desktop test:ts && pnpm --dir desktop build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/lib desktop/src/App.tsx
git commit -m "Add tested range, playback-time, and keyboard shortcut logic for the player

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Export, waveform, and show-in-folder backend

**Files:**
- Create: `desktop/src-tauri/src/export.rs`, `desktop/src-tauri/src/waveform.rs`, `desktop/src-tauri/src/system.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (modules, state, commands), `desktop/src-tauri/capabilities/main.json` (`"dialog:allow-save"`)

**Interfaces:**
- Consumes: `db::transcript`, `db::media`.
- Produces:
  - `export::{MediaFormat, TextFormat, Line, Excerpt, ExportControl}`, plus `export::clock` (a Rust version of TS `clock`).
  - `export::validate_range(start, end, duration) -> Result<()>` and `export::excerpt(root, id, start, end) -> Result<Excerpt>`.
  - `export::render(&Excerpt, TextFormat) -> String`, `export::export_transcript(root, id, start, end, format, dest) -> Result<PathBuf>`, and `export::ffmpeg_args(source, start, end, format, output) -> Vec<OsString>`.
  - `export::export_media(root, id, start, end, format, dest, cancel: &AtomicBool, progress: impl FnMut(f64)) -> Result<PathBuf>`.
  - `waveform::{BUCKETS, reduce, peaks}` and `system::reveal(path)`.
  - Tauri commands `transcript_text`, `export_transcript`, `export_media`, `cancel_export`, `waveform`, `reveal_path`, and the event `export-progress` (an f64 from 0 to 1).

- [ ] **Step 1: Write the failing text and argument tests**

In `export.rs` (the module file starts with only the test module and `use` lines so the tests compile against missing items):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Excerpt {
        Excerpt {
            title: "Oct 7".into(),
            channel: "Meetings".into(),
            date: "2025-10-07".into(),
            start: 723.,
            end: 735.,
            lines: vec![
                Line { start: 720., end: 726., speaker: "Sarah".into(), text: "First thought.".into() },
                Line { start: 726., end: 730., speaker: "Sarah".into(), text: "Second thought.".into() },
                Line { start: 730., end: 740., speaker: String::new(), text: "Unnamed reply.".into() },
            ],
        }
    }

    #[test]
    fn renders_plain_text() {
        assert_eq!(
            render(&sample(), TextFormat::Txt),
            "Oct 7\nMeetings · 2025-10-07 · 12:03–12:15\n\n[12:00] Sarah: First thought.\n[12:06] Sarah: Second thought.\n[12:10] Unnamed reply.\n"
        );
    }

    #[test]
    fn renders_markdown_grouped_by_speaker() {
        assert_eq!(
            render(&sample(), TextFormat::Md),
            "# Oct 7\n\nMeetings · 2025-10-07 · 12:03–12:15\n\n**Sarah** · 12:00\n\n> First thought. Second thought.\n\n12:10\n\n> Unnamed reply.\n"
        );
    }

    #[test]
    fn renders_srt_relative_to_the_range() {
        assert_eq!(
            render(&sample(), TextFormat::Srt),
            "1\n00:00:00,000 --> 00:00:03,000\nSarah: First thought.\n\n2\n00:00:03,000 --> 00:00:07,000\nSarah: Second thought.\n\n3\n00:00:07,000 --> 00:00:12,000\nUnnamed reply.\n\n"
        );
    }

    #[test]
    fn empty_excerpt_renders_header_only() {
        let mut e = sample();
        e.lines.clear();
        assert_eq!(render(&e, TextFormat::Txt), "Oct 7\nMeetings · 2025-10-07 · 12:03–12:15\n");
        assert_eq!(render(&e, TextFormat::Srt), "");
    }

    #[test]
    fn rejects_bad_ranges() {
        assert!(validate_range(5., 5., 100.).is_err());
        assert!(validate_range(-1., 5., 100.).is_err());
        assert!(validate_range(10., 200., 100.).is_err());
        assert!(validate_range(f64::NAN, 20., 0.).is_err());
        assert!(validate_range(10., 20., 0.).is_ok());
        assert!(validate_range(10., 100.3, 100.).is_ok());
    }

    #[test]
    fn parses_formats() {
        assert_eq!(MediaFormat::parse("mp4-accurate").unwrap(), MediaFormat::Mp4Accurate);
        assert!(MediaFormat::parse("gif").is_err());
        assert_eq!(TextFormat::parse("srt").unwrap(), TextFormat::Srt);
    }

    #[test]
    fn builds_ffmpeg_arguments() {
        let args: Vec<String> = ffmpeg_args(Path::new("/in.ogg"), 1.5, 4., MediaFormat::M4a, Path::new("/out.part"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|w| w == ["-ss", "1.500"]));
        assert!(args.windows(2).any(|w| w == ["-t", "2.500"]));
        assert!(args.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert_eq!(&args[args.len() - 3..], ["-f", "mp4", "/out.part"]);
        let video: Vec<String> = ffmpeg_args(Path::new("/in.mkv"), 0., 1., MediaFormat::Mp4Fast, Path::new("/o"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(video.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(video.windows(2).any(|w| w == ["-map", "0:V:0"]));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml export`
Expected: compile errors for missing items. First add `pub mod export;` to `lib.rs`.

- [ ] **Step 3: Implement `export.rs`**

```rust
use crate::db;
use anyhow::{bail, ensure, Context, Result};
use std::{
    collections::HashMap,
    ffi::OsString,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaFormat {
    M4a,
    Mp3,
    Mp4Fast,
    Mp4Accurate,
}
impl MediaFormat {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "m4a" => Self::M4a,
            "mp3" => Self::Mp3,
            "mp4-fast" => Self::Mp4Fast,
            "mp4-accurate" => Self::Mp4Accurate,
            _ => bail!("Unknown export format: {s}"),
        })
    }
    pub fn needs_video(self) -> bool {
        matches!(self, Self::Mp4Fast | Self::Mp4Accurate)
    }
    fn muxer(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            _ => "mp4",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextFormat {
    Txt,
    Md,
    Srt,
}
impl TextFormat {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "txt" => Self::Txt,
            "md" => Self::Md,
            "srt" => Self::Srt,
            _ => bail!("Unknown transcript format: {s}"),
        })
    }
}

pub struct Line {
    pub start: f64,
    pub end: f64,
    pub speaker: String,
    pub text: String,
}
pub struct Excerpt {
    pub title: String,
    pub channel: String,
    pub date: String,
    pub start: f64,
    pub end: f64,
    pub lines: Vec<Line>,
}

/// One export at a time; the flag lets the UI stop a long accurate encode.
#[derive(Default)]
pub struct ExportControl {
    pub busy: Mutex<()>,
    pub cancel: AtomicBool,
}

pub fn clock(seconds: f64) -> String {
    let v = seconds.max(0.).floor() as u64;
    if v >= 3600 {
        format!("{}:{:02}:{:02}", v / 3600, v / 60 % 60, v % 60)
    } else {
        format!("{}:{:02}", v / 60, v % 60)
    }
}

fn srt_time(seconds: f64) -> String {
    let ms = (seconds.max(0.) * 1000.).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

fn pretty_date(s: &str) -> String {
    if s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
        format!("{}-{}-{}", &s[..4], &s[4..6], &s[6..])
    } else {
        s.to_owned()
    }
}

pub fn validate_range(start: f64, end: f64, duration: f64) -> Result<()> {
    ensure!(
        start.is_finite() && end.is_finite() && start >= 0. && end > start,
        "Choose a range whose end is after its start"
    );
    ensure!(duration <= 0. || end <= duration + 0.5, "The range ends after the recording");
    Ok(())
}

pub fn excerpt(root: &Path, id: &str, start: f64, end: f64) -> Result<Excerpt> {
    let data = db::transcript(root, id)?;
    let media = &data["media"];
    validate_range(start, end, media["duration"].as_f64().unwrap_or(0.))?;
    let names: HashMap<String, String> = data["assignments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["local_id"].as_str()?.to_owned(), a["name"].as_str()?.to_owned())))
        .collect();
    let lines = data["segments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let (a, b) = (s["start"].as_f64()?, s["end"].as_f64()?);
            if !(b > start && a < end) {
                return None;
            }
            let local = s["speaker"].as_str().unwrap_or("");
            Some(Line {
                start: a,
                end: b,
                speaker: names.get(local).cloned().unwrap_or_else(|| local.to_owned()),
                text: s["text"].as_str().unwrap_or("").trim().to_owned(),
            })
        })
        .collect();
    Ok(Excerpt {
        title: media["title"].as_str().unwrap_or("Recording").to_owned(),
        channel: media["channel"].as_str().unwrap_or("").to_owned(),
        date: pretty_date(media["date"].as_str().unwrap_or("")),
        start,
        end,
        lines,
    })
}

pub fn render(e: &Excerpt, format: TextFormat) -> String {
    let range = format!("{}–{}", clock(e.start), clock(e.end));
    let source = [e.channel.as_str(), e.date.as_str(), range.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    match format {
        TextFormat::Txt => {
            let header = format!("{}\n{}\n", e.title, source);
            let body: Vec<String> = e
                .lines
                .iter()
                .map(|l| {
                    if l.speaker.is_empty() {
                        format!("[{}] {}", clock(l.start), l.text)
                    } else {
                        format!("[{}] {}: {}", clock(l.start), l.speaker, l.text)
                    }
                })
                .collect();
            if body.is_empty() {
                header
            } else {
                format!("{header}\n{}\n", body.join("\n"))
            }
        }
        TextFormat::Md => {
            let mut out = format!("# {}\n\n{}\n", e.title, source);
            let mut i = 0;
            while i < e.lines.len() {
                let speaker = &e.lines[i].speaker;
                let mut j = i;
                while j < e.lines.len() && &e.lines[j].speaker == speaker {
                    j += 1;
                }
                let text = e.lines[i..j].iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" ");
                let who = if speaker.is_empty() { String::new() } else { format!("**{speaker}** · ") };
                out += &format!("\n{who}{}\n\n> {text}\n", clock(e.lines[i].start));
                i = j;
            }
            out
        }
        TextFormat::Srt => e
            .lines
            .iter()
            .enumerate()
            .map(|(n, l)| {
                let a = (l.start - e.start).max(0.);
                let b = (l.end.min(e.end) - e.start).max(a);
                let text = if l.speaker.is_empty() { l.text.clone() } else { format!("{}: {}", l.speaker, l.text) };
                format!("{}\n{} --> {}\n{}\n\n", n + 1, srt_time(a), srt_time(b), text)
            })
            .collect(),
    }
}

fn partial_path(dest: &Path) -> Result<PathBuf> {
    let name = dest.file_name().context("Choose a file name for the export")?;
    let folder = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    ensure!(folder.is_dir(), "The export folder does not exist");
    Ok(folder.join(format!(".{}.partial", name.to_string_lossy())))
}

pub fn export_transcript(root: &Path, id: &str, start: f64, end: f64, format: TextFormat, dest: &Path) -> Result<PathBuf> {
    let text = render(&excerpt(root, id, start, end)?, format);
    let partial = partial_path(dest)?;
    std::fs::write(&partial, text)?;
    std::fs::rename(&partial, dest)?;
    Ok(dest.to_path_buf())
}

pub fn ffmpeg_args(source: &Path, start: f64, end: f64, format: MediaFormat, output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-nostdin", "-hide_banner", "-v", "error", "-progress", "pipe:1", "-nostats", "-y", "-ss"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(format!("{start:.3}").into());
    args.push("-i".into());
    args.push(source.into());
    args.push("-t".into());
    args.push(format!("{:.3}", end - start).into());
    let tail: &[&str] = match format {
        MediaFormat::M4a => &["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"],
        MediaFormat::Mp3 => &["-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "2"],
        MediaFormat::Mp4Fast => &[
            "-map", "0:V:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
            "-avoid_negative_ts", "make_zero", "-movflags", "+faststart",
        ],
        MediaFormat::Mp4Accurate => &[
            "-map", "0:V:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        ],
    };
    args.extend(tail.iter().map(OsString::from));
    args.push("-f".into());
    args.push(format.muxer().into());
    args.push(output.into());
    args
}

fn has_video(source: &Path) -> Result<bool> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "V:0", "-show_entries", "stream=index", "-of", "csv=p=0"])
        .arg(source)
        .output()
        .context("FFprobe is required to export media")?;
    Ok(out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

fn stderr_tail(s: &str) -> String {
    let t = s.trim();
    let start = t.char_indices().rev().nth(399).map(|(i, _)| i).unwrap_or(0);
    t[start..].to_owned()
}

pub fn export_media(
    root: &Path,
    id: &str,
    start: f64,
    end: f64,
    format: MediaFormat,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<PathBuf> {
    let media = db::media(root, id)?;
    validate_range(start, end, media["duration"].as_f64().unwrap_or(0.))?;
    let source = Path::new(media["path"].as_str().context("This recording has no local media file")?)
        .canonicalize()
        .context("Media unavailable. Reconnect its drive or import a copy.")?;
    if format.needs_video() {
        ensure!(has_video(&source)?, "This recording has no video. Export audio instead.");
    }
    let partial = partial_path(dest)?;
    let mut child = Command::new("ffmpeg")
        .args(ffmpeg_args(&source, start, end, format, &partial))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("FFmpeg is required to export media")?;
    let mut stderr = child.stderr.take().context("FFmpeg error stream unavailable")?;
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let total = (end - start).max(0.001);
    let stdout = child.stdout.take().context("FFmpeg progress stream unavailable")?;
    for line in BufReader::new(stdout).lines() {
        let line = line?;
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            break;
        }
        if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
            if let Ok(us) = v.trim().parse::<f64>() {
                progress((us / 1_000_000. / total).clamp(0., 1.));
            }
        }
    }
    let status = child.wait()?;
    let stderr = errors.join().unwrap_or_default();
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&partial);
        bail!("Export cancelled");
    }
    if !status.success() {
        let _ = std::fs::remove_file(&partial);
        bail!("FFmpeg could not export this range: {}", stderr_tail(&stderr));
    }
    std::fs::rename(&partial, dest)?;
    progress(1.);
    Ok(dest.to_path_buf())
}
```
Because ffmpeg prints progress blocks roughly twice a second, cancellation is observed within about 0.5 s.

- [ ] **Step 4: Run the text and argument tests to verify they pass**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml export::`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the real-media export tests**

Add to the `export.rs` tests:
```rust
fn ffmpeg_available() -> bool {
    Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
}
fn probe_duration(path: &Path) -> f64 {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}
fn media_fixture(dir: &Path) -> PathBuf {
    let root = dir.join("next");
    let audio = dir.join("tone.ogg");
    let video = dir.join("bars.mp4");
    assert!(Command::new("ffmpeg").args(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:a", "libvorbis"]).arg(&audio).status().unwrap().success());
    assert!(Command::new("ffmpeg").args(["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=20:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]).arg(&video).status().unwrap().success());
    db::open(&root).unwrap().execute(
        "INSERT INTO media(id,title,path,duration) VALUES ('audio','Tone',?1,20),('video','Bars',?2,20),('gone','Gone','/nowhere/x.ogg',20)",
        rusqlite::params![audio.to_string_lossy(), video.to_string_lossy()],
    ).unwrap();
    root
}

#[test]
fn exports_real_media_ranges() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not installed");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = media_fixture(tmp.path());
    let cancel = AtomicBool::new(false);
    for (id, format, ext) in [
        ("audio", MediaFormat::M4a, "m4a"),
        ("audio", MediaFormat::Mp3, "mp3"),
        ("video", MediaFormat::Mp4Accurate, "mp4"),
        ("video", MediaFormat::M4a, "m4a"),
    ] {
        let dest = tmp.path().join(format!("{id}-{ext}.{ext}"));
        let mut last = 0.;
        export_media(&root, id, 5., 9.5, format, &dest, &cancel, |p| last = p).unwrap();
        assert!((probe_duration(&dest) - 4.5).abs() < 0.2, "{id} {ext}: {}", probe_duration(&dest));
        assert_eq!(last, 1.);
    }
    let fast = tmp.path().join("fast.mp4");
    export_media(&root, "video", 5., 9.5, MediaFormat::Mp4Fast, &fast, &cancel, |_| {}).unwrap();
    assert!(fast.metadata().unwrap().len() > 0);
    let err = export_media(&root, "audio", 1., 2., MediaFormat::Mp4Accurate, &tmp.path().join("x.mp4"), &cancel, |_| {}).unwrap_err();
    assert!(format!("{err:#}").contains("no video"));
    let err = export_media(&root, "gone", 1., 2., MediaFormat::M4a, &tmp.path().join("g.m4a"), &cancel, |_| {}).unwrap_err();
    assert!(format!("{err:#}").contains("Media unavailable"));
    let leftovers: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".partial")).collect();
    assert!(leftovers.is_empty());
}

#[test]
fn cancelled_export_leaves_no_file() {
    if !ffmpeg_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = media_fixture(tmp.path());
    let cancel = AtomicBool::new(true);
    let dest = tmp.path().join("c.mp4");
    let err = export_media(&root, "video", 0., 20., MediaFormat::Mp4Accurate, &dest, &cancel, |_| {}).unwrap_err();
    assert!(format!("{err:#}").contains("cancelled"));
    assert!(!dest.exists());
    assert!(!tmp.path().join(".c.mp4.partial").exists());
}

#[test]
fn transcript_export_writes_the_rendered_text() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("next");
    let db = db::open(&root).unwrap();
    db.execute_batch("INSERT INTO media(id,title,channel,date,duration) VALUES ('m','Talk','Meetings','20251007',100);
      INSERT INTO segments(media_id,start,end,speaker,text) VALUES ('m',1,4,'S0','Hello there.'),('m',50,52,'S1','Much later.');
      INSERT INTO speakers(id,name) VALUES ('s','Ada');
      INSERT INTO assignments(media_id,local_id,speaker_id) VALUES ('m','S0','s');").unwrap();
    let dest = tmp.path().join("talk.txt");
    export_transcript(&root, "m", 0., 10., TextFormat::Txt, &dest).unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "Talk\nMeetings · 2025-10-07 · 0:00–0:10\n\n[0:01] Ada: Hello there.\n");
}
```
With the cancel flag already set, the loop kills ffmpeg on the first progress line. If ffmpeg never prints a progress line, `child.wait()` still returns, the flag check bails, and the partial file is removed.

- [ ] **Step 6: Run the real-media tests**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml export::`
Expected: PASS (10 tests). If the mp3 duration differs by more than 0.2 because of encoder padding, check with `ffprobe -show_entries stream=duration` before changing the tolerance, and document why in a comment.

- [ ] **Step 7: Write the waveform test and implementation**

`desktop/src-tauri/src/waveform.rs`:
```rust
use crate::db;
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufReader, Read},
    path::Path,
    process::{Command, Stdio},
};

pub const BUCKETS: usize = 2000;

/// Collapse fine peaks into at most `buckets` maxima.
pub fn reduce(fine: &[f32], buckets: usize) -> Vec<f32> {
    let n = buckets.min(fine.len());
    (0..n)
        .map(|i| {
            let a = i * fine.len() / n;
            let b = ((i + 1) * fine.len() / n).max(a + 1);
            fine[a..b].iter().copied().fold(0., f32::max)
        })
        .collect()
}

/// Audio peaks for the timeline, cached under the data root.
pub fn peaks(root: &Path, id: &str) -> Result<Vec<f32>> {
    let folder = root.join("waveforms");
    let cache = folder.join(format!("{:x}.json", Sha256::digest(id.as_bytes())));
    if let Ok(file) = File::open(&cache) {
        if let Ok(values) = serde_json::from_reader::<_, Vec<f32>>(BufReader::new(file)) {
            return Ok(values);
        }
    }
    let media = db::media(root, id)?;
    let source = Path::new(media["path"].as_str().context("This recording has no local media file")?)
        .canonicalize()
        .context("Media unavailable. Reconnect its drive or import a copy.")?;
    let mut child = Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(&source)
        .args(["-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("FFmpeg is required for waveforms")?;
    let mut reader = BufReader::new(child.stdout.take().context("FFmpeg output unavailable")?);
    let mut fine = Vec::new();
    let mut chunk = [0u8; 160]; // 80 samples = 10 ms at 8 kHz
    loop {
        let mut filled = 0;
        while filled < chunk.len() {
            let n = reader.read(&mut chunk[filled..])?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled < 2 {
            break;
        }
        let peak = chunk[..filled - filled % 2]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]).unsigned_abs())
            .max()
            .unwrap_or(0);
        fine.push(f32::from(peak) / 32768.);
        if filled < chunk.len() {
            break;
        }
    }
    ensure!(child.wait()?.success() && !fine.is_empty(), "Could not read audio for the waveform");
    let values = reduce(&fine, BUCKETS);
    std::fs::create_dir_all(&folder)?;
    let partial = folder.join(format!("{}.partial", uuid::Uuid::new_v4()));
    std::fs::write(&partial, serde_json::to_vec(&values)?)?;
    std::fs::rename(&partial, &cache)?;
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduce_takes_bucket_maxima() {
        assert_eq!(reduce(&[0.1, 0.5, 0.2, 0.9, 0.3], 2), vec![0.5, 0.9]);
        assert_eq!(reduce(&[0.3], 10), vec![0.3]);
        assert!(reduce(&[], 10).is_empty());
    }

    #[test]
    fn waveform_errors_for_missing_media() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        db::open(&root).unwrap().execute("INSERT INTO media(id,title,path) VALUES ('x','X','/nowhere/x.ogg')", []).unwrap();
        assert!(peaks(&root, "x").is_err());
    }

    #[test]
    fn waveform_reads_audio_and_caches() {
        if !Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success()) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        let audio = tmp.path().join("tone.ogg");
        assert!(Command::new("ffmpeg").args(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:a", "libvorbis"]).arg(&audio).status().unwrap().success());
        db::open(&root).unwrap().execute("INSERT INTO media(id,title,path) VALUES ('t','Tone',?1)", [audio.to_string_lossy()]).unwrap();
        let first = peaks(&root, "t").unwrap();
        assert_eq!(first.len(), BUCKETS);
        assert!(first.iter().all(|&p| p > 0.05));
        assert!(std::fs::read_dir(root.join("waveforms")).unwrap().count() == 1);
        assert_eq!(peaks(&root, "t").unwrap(), first);
    }
}
```

- [ ] **Step 8: Implement `system.rs`**

```rust
use anyhow::{Context, Result};
use std::path::Path;

/// Select the file in the user's file manager, or open its folder when selection isn't supported.
pub fn reveal(path: &Path) -> Result<()> {
    let path = path.canonicalize().context("That file is no longer available")?;
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};
        let uri = url::Url::from_file_path(&path).map_err(|_| anyhow::anyhow!("Invalid file path"))?;
        let selected = Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
            ])
            .arg(format!("array:string:{uri}"))
            .arg("string:")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !selected {
            Command::new("xdg-open")
                .arg(path.parent().unwrap_or(&path))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .context("No file manager is available")?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        anyhow::bail!("Show in folder is not available on this platform yet: {}", path.display())
    }
}
```

- [ ] **Step 9: Wire the state, commands, and capability**

In `lib.rs`:
- Add `pub mod export; pub mod waveform; pub mod system;`.
- Add `export: Arc<export::ExportControl>` to `AppState`, initialised with `Arc::new(export::ExportControl::default())`.
- Add the commands below, and add them to `generate_handler!`.

```rust
use std::sync::atomic::Ordering;
use tauri::Emitter;

#[tauri::command]
async fn transcript_text(state: State<'_, AppState>, id: String, start: f64, end: f64, format: String) -> Result<String, String> {
    let root = state.root.clone();
    work(move || Ok(export::render(&export::excerpt(&root, &id, start, end)?, export::TextFormat::parse(&format)?))).await
}
#[tauri::command]
async fn export_transcript(state: State<'_, AppState>, id: String, start: f64, end: f64, format: String, dest: String) -> Result<String, String> {
    let root = state.root.clone();
    work(move || {
        let path = export::export_transcript(&root, &id, start, end, export::TextFormat::parse(&format)?, Path::new(&dest))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}
#[tauri::command]
async fn export_media(app: tauri::AppHandle, state: State<'_, AppState>, id: String, start: f64, end: f64, format: String, dest: String) -> Result<String, String> {
    let (root, control) = (state.root.clone(), state.export.clone());
    work(move || {
        let _busy = control.busy.try_lock().map_err(|_| anyhow::anyhow!("Another export is still running"))?;
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
async fn reveal_path(path: String) -> Result<(), String> {
    work(move || system::reveal(Path::new(&path))).await
}
```
In `capabilities/main.json`, add `"dialog:allow-save"` to `permissions`. Also add `"core:event:allow-listen"` and `"core:event:allow-unlisten"` if `core:default` does not already include them. Check `desktop/src-tauri/gen/schemas/desktop-schema.json` after a build.

- [ ] **Step 10: Run all Rust tests and clippy**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: PASS. Clippy may flag `export_media` for too many arguments. If so, add `#[allow(clippy::too_many_arguments)]` on that function with the comment `// Mirrors the IPC command's arguments one-to-one.`

- [ ] **Step 11: Commit**

```bash
git add desktop/src-tauri
git commit -m "Export transcript ranges as audio, video, text, Markdown, or subtitles, and add waveforms and show in folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Player — playback, timeline, speakers, resume, previous/next

**Files:**
- Create: `desktop/src/player/{PlayerPage.tsx,useMedia.ts,SplitLayout.tsx,PlayerHeader.tsx,MediaStage.tsx,Transport.tsx,Timeline.tsx,Transcript.tsx,SpeakerPanel.tsx,NameVoiceDialog.tsx,ShortcutSheet.tsx,voices.ts,player.css}`
- Modify: `desktop/src/App.tsx` (use `PlayerPage` for the `recording` route), `desktop/src/views.tsx` (delete `Player`, `PlayerLayout`)

**Interfaces:**
- Consumes:
  - `api.recording`, `api.mediaUrl`, `api.waveform`, `api.savePosition`, `api.assignSpeaker`, `api.speakers`, `api.reveal`, `api.setStarred`, `api.setReview`.
  - `createTimeStore`, `useTime`, `indexAt`, `speakerTurns`, `useShortcuts`, `speakerColor`, `voiceLabel`, `neighbors`, `recordingMenu`.
- Produces:
  - `useMedia(ref, time, fallbackDuration, src): MediaControls`, and `RATES`.
  - `Voice = { local; name; color; named; airtime }`, and `buildVoices(assignments, segments): Map<string, Voice>`.
  - `Timeline` props `{ duration, time, turns, peaks, range, notes, onSeek, onRangeChange, onNote }`.
  - `Transcript` props `{ lines, voices, time, follow, setFollow, onLine(index, event), onVoice(local), renderExtras? }`. Task 11 extends it.
  - `SplitLayout({ children: [left, right] })`.

- [ ] **Step 1: Write `voices.ts` with a test**

`desktop/src/player/voices.ts`:
```ts
import type { Assignment, Segment } from "../lib/types.ts";
import { speakerColor, voiceLabel } from "../lib/speakers.ts";
export type Voice = { local: string; name: string; color: string; named: boolean; airtime: number };
/** Every local voice in the transcript, named where an assignment has a name, loudest first. */
export function buildVoices(assignments: Assignment[], segments: Segment[]): Map<string, Voice> {
  const voices = new Map<string, Voice>();
  for (const a of assignments) {
    voices.set(a.local_id, {
      local: a.local_id,
      name: a.name ?? voiceLabel(a.local_id),
      color: speakerColor(a.color, a.name ?? a.local_id),
      named: !!a.name,
      airtime: a.airtime,
    });
  }
  for (const s of segments) {
    if (!s.speaker) continue;
    const v = voices.get(s.speaker);
    if (v) {
      if (!assignments.some((a) => a.local_id === s.speaker && a.airtime > 0)) v.airtime += s.end - s.start;
    } else {
      voices.set(s.speaker, { local: s.speaker, name: voiceLabel(s.speaker), color: speakerColor(null, s.speaker), named: false, airtime: s.end - s.start });
    }
  }
  return new Map([...voices].sort((a, b) => b[1].airtime - a[1].airtime));
}
```
`desktop/src/player/voices.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoices } from "./voices.ts";

test("voices merge assignments with speakers found only in the transcript", () => {
  const voices = buildVoices(
    [{ local_id: "S0", speaker_id: "s", name: "Ada", color: "#112233", airtime: 30 }],
    [
      { start: 0, end: 5, text: "a", speaker: "S0" },
      { start: 5, end: 65, text: "b", speaker: "S4" },
      { start: 65, end: 66, text: "c" },
    ],
  );
  assert.deepEqual([...voices.keys()], ["S4", "S0"]);
  assert.equal(voices.get("S0")!.name, "Ada");
  assert.equal(voices.get("S0")!.color, "#112233");
  assert.equal(voices.get("S0")!.airtime, 30);
  assert.equal(voices.get("S4")!.name, "Speaker 5");
  assert.equal(voices.get("S4")!.named, false);
  assert.equal(voices.get("S4")!.airtime, 60);
});
```
Run `pnpm --dir desktop test:ts`: it fails first because the module is missing, then passes after `voices.ts` is written.

- [ ] **Step 2: Write `useMedia.ts`**

```ts
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TimeStore } from "../lib/timeStore.ts";
import { useStoredState } from "../lib/storage.ts";

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
export type MediaControls = {
  playing: boolean; duration: number; rate: number; volume: number; muted: boolean; ready: boolean; error: string;
  play(): void; pause(): void; toggle(): void; seek(t: number, andPlay?: boolean): void; skip(delta: number): void;
  setRate(rate: number): void; setVolume(volume: number): void; toggleMute(): void;
};

export function useMedia(ref: RefObject<HTMLMediaElement | null>, time: TimeStore, fallbackDuration: number, src: string): MediaControls {
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(fallbackDuration);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [rate, setRateStored] = useStoredState("player-rate-v1", 1, (v) => RATES.includes(v as number));
  const [volume, setVolumeStored] = useStoredState("player-volume-v1", 1, (v) => typeof v === "number" && v >= 0 && v <= 1);
  const prefs = useRef({ rate, volume });
  prefs.current = { rate, volume };

  useEffect(() => setDuration((d) => d || fallbackDuration), [fallbackDuration]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    setReady(false);
    setError("");
    let frame = 0;
    const tick = () => {
      time.set(el.currentTime);
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      time.set(el.currentTime);
    };
    const onSeeked = () => time.set(el.currentTime);
    const onMeta = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
      el.playbackRate = prefs.current.rate;
      el.volume = prefs.current.volume;
      setReady(true);
    };
    const onError = () => setError("This media could not be played on this system. The transcript is still available.");
    const events: [string, () => void][] = [
      ["play", onPlay], ["pause", onPause], ["ended", onPause], ["seeked", onSeeked],
      ["loadedmetadata", onMeta], ["error", onError],
    ];
    events.forEach(([name, fn]) => el.addEventListener(name, fn));
    return () => {
      cancelAnimationFrame(frame);
      events.forEach(([name, fn]) => el.removeEventListener(name, fn));
    };
  }, [ref, time, src]);

  const play = useCallback(() => {
    ref.current?.play().catch((e: unknown) => {
      // A newer seek or pause interrupting play() is expected, not an error.
      if ((e as DOMException)?.name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    });
  }, [ref]);
  const pause = useCallback(() => ref.current?.pause(), [ref]);
  const seek = useCallback((t: number, andPlay = false) => {
    const el = ref.current;
    if (!el) return;
    const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration || t;
    el.currentTime = Math.min(Math.max(0, t), max);
    time.set(el.currentTime);
    if (andPlay) play();
  }, [ref, time, duration, play]);
  return {
    playing, duration, rate, volume, muted, ready, error,
    play, pause, seek,
    toggle: () => (ref.current?.paused ? play() : pause()),
    skip: (delta) => seek(time.get() + delta),
    setRate: (r) => { setRateStored(r); if (ref.current) ref.current.playbackRate = r; },
    setVolume: (v) => { setVolumeStored(v); if (ref.current) ref.current.volume = v; },
    toggleMute: () => { const el = ref.current; if (!el) return; el.muted = !el.muted; setMuted(el.muted); },
  };
}
```

- [ ] **Step 3: Write `Timeline.tsx` (full behavior)**

```tsx
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { NoteMarker } from "../lib/types.ts";
import type { Range } from "../lib/range.ts";
import { clampRange } from "../lib/range.ts";
import { useTime, type TimeStore } from "../lib/timeStore.ts";
import { clock } from "../lib/format.ts";
import { cx } from "../lib/cx.ts";

export type LaneTurn = { start: number; end: number; color: string; label: string };
type Drag = "seek" | "start" | "end" | null;

export function Timeline({ duration, time, turns, peaks, range, notes, onSeek, onRangeChange, onNote }: {
  duration: number; time: TimeStore; turns: LaneTurn[]; peaks: number[] | null; range: Range | null; notes: NoteMarker[];
  onSeek: (t: number) => void; onRangeChange: (r: Range) => void; onNote: (n: NoteMarker) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const pct = (t: number) => `${duration > 0 ? (Math.min(Math.max(t, 0), duration) / duration) * 100 : 0}%`;
  const toTime = (clientX: number) => {
    const b = track.current!.getBoundingClientRect();
    return Math.min(Math.max((clientX - b.left) / b.width, 0), 1) * duration;
  };
  const begin = (kind: Exclude<Drag, null>) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !duration) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(kind);
    if (kind === "seek") onSeek(toTime(e.clientX));
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const t = toTime(e.clientX);
    setHover(t);
    if (drag === "seek") onSeek(t);
    else if (drag === "start" && range) onRangeChange(clampRange({ start: Math.min(t, range.end - 0.5), end: range.end }, duration));
    else if (drag === "end" && range) onRangeChange(clampRange({ start: range.start, end: Math.max(t, range.start + 0.5) }, duration));
  };
  const end = () => setDrag(null);
  return (
    <div className={cx("timeline", peaks && "has-waveform", drag && "is-dragging")}>
      <div
        ref={track}
        className="timeline-track"
        role="slider"
        tabIndex={0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time.get())}
        onPointerDown={begin("seek")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={() => !drag && setHover(null)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 60 : 5;
          const next = { ArrowLeft: time.get() - step, ArrowRight: time.get() + step, Home: 0, End: duration }[e.key];
          if (next === undefined) return;
          e.preventDefault();
          onSeek(next);
        }}
      >
        {peaks && <Waveform peaks={peaks} />}
        <div className="speaker-lane" aria-hidden>
          {turns.map((t, i) => (
            <span key={i} style={{ left: pct(t.start), width: `calc(${pct(t.end)} - ${pct(t.start)})`, background: t.color }} title={`${t.label} · ${clock(t.start)}–${clock(t.end)}`} />
          ))}
        </div>
        {range && (
          <div className="range-band" style={{ left: pct(range.start), width: `calc(${pct(range.end)} - ${pct(range.start)})` }}>
            <span className="range-handle is-start" role="slider" tabIndex={0} aria-label="Range start" aria-valuenow={Math.round(range.start)}
              onPointerDown={begin("start")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
              onKeyDown={(e) => { const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key]; if (d) { e.preventDefault(); e.stopPropagation(); onRangeChange(clampRange({ start: range.start + d * (e.shiftKey ? 0.1 : 1), end: range.end }, duration)); } }} />
            <span className="range-handle is-end" role="slider" tabIndex={0} aria-label="Range end" aria-valuenow={Math.round(range.end)}
              onPointerDown={begin("end")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
              onKeyDown={(e) => { const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key]; if (d) { e.preventDefault(); e.stopPropagation(); onRangeChange(clampRange({ start: range.start, end: range.end + d * (e.shiftKey ? 0.1 : 1) }, duration)); } }} />
          </div>
        )}
        {notes.map((n) => (
          <button key={n.id} type="button" className="note-marker" style={{ left: pct(n.start) }} title={n.title}
            onPointerDown={(e) => e.stopPropagation()} onClick={() => onNote(n)} aria-label={`Note: ${n.title} at ${clock(n.start)}`} />
        ))}
        <Playhead time={time} duration={duration} />
        {hover != null && <span className="hover-time num" style={{ left: pct(hover) }}>{clock(hover)}</span>}
      </div>
    </div>
  );
}

function Playhead({ time, duration }: { time: TimeStore; duration: number }) {
  const t = useTime(time, (v) => Math.round(v * 20) / 20);
  return <span className="playhead" style={{ left: `${duration > 0 ? (Math.min(t, duration) / duration) * 100 : 0}%` }} aria-hidden />;
}

/** Mirrored peak bars, redrawn on resize and theme change. */
function Waveform({ peaks }: { peaks: number[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const draw = () => {
      const { width, height } = el.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      el.width = Math.round(width * scale);
      el.height = Math.round(height * scale);
      const ctx = el.getContext("2d")!;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.fillStyle = getComputedStyle(el).color;
      const max = Math.max(0.05, ...peaks);
      const bars = Math.min(peaks.length, Math.floor(el.width / (2 * scale)));
      const mid = el.height / 2;
      for (let i = 0; i < bars; i++) {
        const from = Math.floor((i * peaks.length) / bars);
        const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bars));
        let peak = 0;
        for (let j = from; j < to; j++) peak = Math.max(peak, peaks[j]);
        const h = Math.max(scale, (Math.sqrt(peak / max) * el.height * 0.92) / 2);
        ctx.fillRect(i * 2 * scale, mid - h, scale, h * 2);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    const themeObserver = new MutationObserver(draw);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { observer.disconnect(); themeObserver.disconnect(); };
  }, [peaks]);
  return <canvas ref={canvas} className="waveform" aria-hidden />;
}
```

- [ ] **Step 4: Build the remaining player components**

**`SplitLayout`:**
- Move `PlayerLayout` from `views.tsx` unchanged: drag, keyboard, double-click reset, the `player-video-width` key, and the default of 64.
- Use `readStored`/`writeStored`.
- Under `TABLET`, render the two children stacked with no divider.
- Restyle the divider: a 1px `--border` line with a 20px hit area, and a grip pill that appears on hover or focus.

**`PlayerHeader`:**
- Left: a back `Button` ("Library", `ArrowLeft`, ghost, sm), which calls `history.back()` when there is history, and otherwise navigates to the library.
- Next to it, ‹ › `IconButton`s from `neighbors(id)`. They are disabled when missing, and their tooltip is the neighbor's title.
- The title is an `h1` in `--font-serif`, `--text-2xl`, weight 600, clamped to 2 lines.
- The meta line uses `.num` and `--muted-foreground`: `channel · prettyDate · clock(duration) · count(words,"word") · model`, where the model reads "Nemotron 3.5 · multilingual" when the model contains "nemotron", and is otherwise the raw model name.
- The right side has:
  - The Transcribe/Re-transcribe `Button`. It is primary when there is no transcript, and disabled while `activeJob` exists or there is no path. It calls `transcribe(id)` from `useApp`.
  - A star `IconButton`.
  - A ⋮ `Menu` built from `recordingMenu`.
- It calls `setPageTitle(media.title)` on load and `setPageTitle(null)` on unmount.

**`MediaStage`:**
- For `kind === "video"`: `<video ref playsInline preload="metadata" src>` with no controls. A click toggles play, and a double-click toggles fullscreen. Listen for `fullscreenchange` and set `controls` while fullscreen. The box is 16:9 on a black letterbox with radius `--r-3`.
- For `kind === "audio"`: a hidden `<audio ref preload="metadata" src>` plus a compact cover. The cover uses the `--secondary` background, an `AudioLines` icon in `--primary` at 28px, the collection name, and "Audio recording"; it is 96px tall.
- Missing media (`api.mediaUrl` rejects, or `controls.error`) shows an inline state in the same box: a `CircleAlert` icon, the message, and "The transcript is still available." No toast.

**`Transport`:**
- One row, 44px tall:
  - Play/Pause `IconButton` (primary-filled round, 40px).
  - Back 10 and forward 10 (`RotateCcw`/`RotateCw` with a small "10" label).
  - The time `current / total` in `.num .mono`, which subscribes through `useTime(time, Math.floor)`.
  - A spacer.
  - A speed `Menu` whose trigger is a ghost button like "1×", with entries for `RATES` and the current one checked.
  - Mute `IconButton` (`Volume2`/`VolumeX`) with a volume slider (`input type=range`, 80px, desktop only).
  - The shortcuts `IconButton` (`Keyboard`), which opens `ShortcutSheet`.

**`SpeakerPanel`:**
- The heading "In this recording" and `count(n, "voice")`.
- One row per `Voice`:
  - A color dot, and the name (or "Speaker N" in `--muted-foreground` italic with a small "Name" link).
  - Airtime (`humanDuration`, `.num`).
  - A "First line" `IconButton` (`CornerDownRight`) that seeks to the voice's first segment.
- Clicking a row opens `NameVoiceDialog`.
- Empty state: "Transcribe this recording to see who speaks."

**`NameVoiceDialog`:**
- A `Dialog sm` titled "Name this voice" with the description "Use an existing name to connect this voice across recordings."
- An input with a `<datalist>` filled from `api.speakers()` names.
- A "Play a sample" ghost button that seeks to the voice's longest line and plays.
- The footer has Cancel and "Save" (primary). Save calls `api.assignSpeaker(id, local, name)`, then refresh and toast "Voice named".

**`ShortcutSheet`:**
- A `Dialog md` titled "Keyboard shortcuts", holding a two-column table of `<Kbd>` keys and descriptions for every shortcut in Task 10 Step 5 and Task 11 Step 4.

**`Transcript` (base version; Task 11 adds find, selection, and ranges):**
- The scroller renders `lines.map((line, i) => <TranscriptLine key={i} .../>)`, with `TranscriptLine = memo(...)`.
- Each row is a `div` with `data-line={i}`:
  - A timestamp button (`.mono`, `--muted-foreground`, `clock`).
  - The speaker name as a button in the voice color, weight 600, `--text-sm`, which calls `onVoice(local)`. It shows only when the speaker changes from the previous line, which keeps the list calm.
  - The text in `--font-reading` at `--reading-size`, line-height 1.6.
- The current line index comes from `useTime(time, (t) => indexAt(lines, t))` in a small `CurrentLine` subscriber. It sets `data-current` on the row element directly via a ref map, so rows do not re-render.
- **Follow-along:** when the current index changes and `follow` is true, call `row.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" })`. A user `wheel`, `touchmove`, `keydown` (PageUp/PageDown/arrows) inside the scroller, or `pointerdown` on the scrollbar sets `follow = false`.
- When `follow` is false while playing, show a floating pill "Back to playback" (`ArrowDownToLine`) that sets `follow = true`.
- Clicking a row calls `onLine(i, event)`.
- Rows use `content-visibility: auto; contain-intrinsic-size: auto 64px` for long transcripts.
- Empty state: "No transcript yet. Choose Transcribe to create one with speakers."

**`PlayerPage`:**
- **Loading data:**
  - Load `api.recording(id)` on `id` and `revision`.
  - Load `api.mediaUrl(id)` on `id`. Its failure message feeds `MediaStage`.
  - Load `api.waveform(id)` only when `media.kind === "audio"`. A failure sets `peaks = null` with no toast.
- **Time store:** `time = useMemo(() => createTimeStore(at ?? 0), [id])`.
- **Starting position:** once metadata is ready, seek to `at ?? (media.position > 5 ? media.position : 0)`.
- **Saving the position:**
  - Subscribe to `time`. Every time playback has moved 10 s or more since the last save, call `api.savePosition`. Also save on pause and on unmount.
  - The first failure raises one toast, "Couldn't save your place in this recording"; later failures are ignored for that recording.
- **Derived data:** `voices = buildVoices(assignments, segments)`, and `turns = speakerTurns(segments).map((t) => ({ ...t, color: voices.get(t.speaker)?.color, label: voices.get(t.speaker)?.name }))`.
- **Layout:** `PlayerHeader`, then `SplitLayout` with:
  - Left: `MediaStage`, `Transport`, `Timeline`, `SpeakerPanel`.
  - Right: `Transcript`.
- **Phones:** the media, transport, and timeline sit in a `.player-sticky` block. Below it, a `Segmented` control switches between "Transcript" and "Speakers" panes.

- [ ] **Step 5: Playback shortcuts**

In `PlayerPage`:
```ts
useShortcuts([
  { key: " ", run: () => controls.toggle() },
  { key: "k", run: () => controls.toggle() },
  { key: "ArrowLeft", shift: false, run: () => controls.skip(-10) },
  { key: "ArrowRight", shift: false, run: () => controls.skip(10) },
  { key: "ArrowLeft", shift: true, run: () => controls.skip(-60) },
  { key: "ArrowRight", shift: true, run: () => controls.skip(60) },
  { key: "ArrowUp", run: () => stepLine(-1) },
  { key: "ArrowDown", run: () => stepLine(1) },
  { key: "<", run: () => controls.setRate(RATES[Math.max(0, RATES.indexOf(controls.rate) - 1)]) },
  { key: ">", run: () => controls.setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(controls.rate) + 1)]) },
  { key: "m", run: () => controls.toggleMute() },
  { key: "f", run: () => toggleFullscreen() },
  { key: "?", run: () => setShortcutsOpen(true) },
]);
```
Here `stepLine(d)` seeks to `lines[clamp(indexAt(lines, time.get()) + d)].start` without autoplay, and `toggleFullscreen` requests fullscreen on the video element (for audio it does nothing).

- [ ] **Step 6: Write `player.css`**

- **Layout.**
  - `.player` is a grid with `grid-template-rows: auto 1fr` and height `calc(100vh - var(--topbar-h) - 40px)`.
  - The left column scrolls independently, and so does the right column's transcript.
  - The transcript panel is a `--card` panel with a border and `--r-3` radius, with a sticky header holding the find field in Task 11.
- **Transcript rows.**
  - `.transcript-line` is a grid `64px 1fr` with a 12px gap, padding 8px 12px, and radius `--r-2`.
  - `:hover` uses the `--hover` background. `[data-current]` uses the `--current-line` background with a 2px inset left bar in `--primary`.
  - The timestamp button is `.mono` `--text-xs`, and `:hover` turns it `--primary`.
- **Timeline.**
  - `.timeline-track` is `position: relative`, 36px tall (64px with the waveform), with the `--muted` background, `--r-2` radius, and `touch-action: none`.
  - `.waveform` is absolutely positioned with inset 4px 0 10px, and its color is `color-mix(in oklab, var(--muted-foreground) 55%, transparent)`.
  - `.speaker-lane` sits at the bottom, 6px high; its `span`s are absolutely positioned, full height, radius 1px, opacity 0.9.
  - `.playhead` is 2px wide, full height, `--primary`, with a small circle cap drawn by `::before` at the top.
  - `.range-band` is absolute and full height with the `--range-fill` background and 1px `--primary` borders on its left and right.
  - `.range-handle` is 12px wide (28 coarse), full height, `cursor: ew-resize`, and has a 3×16px `--primary` grip drawn by `::after`.
  - `.note-marker` is a 7px diamond at the top, in `--chart-2`.
  - `.hover-time` is a small popover tag above the track.
- **Transport.** `.transport` is flex, center-aligned, with an 8px gap.
- **Phones.**
  - `.player-sticky` is `position: sticky; top: 0` with the `--background` background, `z-index: 5`, and a bottom border.
  - The video's max height is 32vh.

- [ ] **Step 7: Screenshots and manual check**

1. `node desktop/scripts/screens.mjs "$SCRATCH/screens" player` covers the `player` (video) and `player-audio` shots.
2. Acceptance criteria:
   - The waveform and speaker lane show on audio recordings.
   - The playhead sits at 1:05 in the `?t=65` shot.
   - The current line is highlighted and centered.
   - Speaker names are colored and show only on speaker changes.
   - The phone shows a sticky player with the Transcript/Speakers switch.
   - In light mode, the waveform is visible.
3. Manual check in a browser on the mock: Space plays the silent WAV and the playhead moves; ←/→ skip; scrolling shows the "Back to playback" pill; ‹ › go to neighbors after visiting the library first.

- [ ] **Step 8: Run the tests, build, and commit**

Run: `pnpm --dir desktop test:ts && pnpm --dir desktop build`
```bash
git add desktop/src
git commit -m "Rebuild the player with custom transport, waveform and speaker timeline, resume, and keyboard control

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Transcript find, range selection, range bar, and export dialog

**Files:**
- Create: `desktop/src/player/{FindBar.tsx,RangeBar.tsx,ExportDialog.tsx,useLineSelection.ts}`
- Modify: `desktop/src/player/{Transcript.tsx,PlayerPage.tsx,player.css}`, `desktop/src/notes/NoteEditor.tsx` (accept a range quote)

**Interfaces:**
- Consumes:
  - `spanRange`, `linesIn`, `setIn`, `setOut`, `clampRange`, `findMatches`, `markParts`, `useShortcuts`.
  - `api.transcriptText`, `api.exportMedia`, `api.exportTranscript`, `api.cancelExport`, `api.onExportProgress`, `api.pickSavePath`, `api.reveal`.
  - `copyText`, `exportName`, `parseClock`, and `openNote` from `useApp`.
- Produces:
  - `useLineSelection({ lines, scroller, onRange, onSeekLine }): { anchor, setAnchor, selecting, setSelecting, handleLine(i, e), pressHandlers(i) }`.
  - `RangeBar` props `{ range, playingRange, loop, onPlay, onStop, onLoop, onCopy, onExport, onSaveNote, onClear }`.
  - `ExportDialog` props `{ open, onOpenChange, recording, range, onRange, mediaAvailable }`.

- [ ] **Step 1: Selection hook**

`desktop/src/player/useLineSelection.ts`:
```ts
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { spanRange, type Range, type Timed } from "../lib/range.ts";

const lineIndexOf = (node: Node | null, root: HTMLElement): number | null => {
  const el = node instanceof Element ? node : node?.parentElement;
  const row = el?.closest<HTMLElement>("[data-line]");
  return row && root.contains(row) ? Number(row.dataset.line) : null;
};

export function useLineSelection({ lines, scroller, onRange, onSeekLine }: {
  lines: Timed[];
  scroller: RefObject<HTMLElement | null>;
  onRange: (r: Range) => void;
  onSeekLine: (index: number) => void;
}) {
  const [anchor, setAnchor] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  // Text selected across transcript lines selects those whole lines.
  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = scroller.current;
        const sel = document.getSelection();
        if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const a = lineIndexOf(sel.anchorNode, root);
        const b = lineIndexOf(sel.focusNode, root);
        if (a == null || b == null) return;
        setAnchor(a);
        onRange(spanRange(lines, a, b));
      }, 120);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [lines, scroller, onRange]);

  const handleLine = useCallback((i: number, e: MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (!document.getSelection()?.isCollapsed) return; // a drag-selection, handled above
    if (selecting || e.shiftKey) {
      onRange(spanRange(lines, anchor ?? i, i));
      if (anchor == null) setAnchor(i);
      return;
    }
    setAnchor(i);
    onSeekLine(i);
  }, [anchor, selecting, lines, onRange, onSeekLine]);

  const pressHandlers = (i: number) => ({
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const timer = window.setTimeout(() => {
        press.current = null;
        suppressClick.current = true;
        setSelecting(true);
        setAnchor(i);
        onRange(spanRange(lines, i, i));
        navigator.vibrate?.(10);
      }, 450);
      press.current = { timer, x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
        clearTimeout(p.timer);
        press.current = null;
      }
    },
    onPointerUp: () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
    },
  });

  return { anchor, setAnchor, selecting, setSelecting, handleLine, pressHandlers };
}
```

- [ ] **Step 2: Transcript additions (find, range tint, selecting mode)**

**`FindBar`**, in the transcript header:
- A search field with the placeholder "Find in transcript" (`Ctrl F` hint) and a `.num` counter "3 of 12" or "No matches".
- ▲▼ `IconButton`s; Enter goes to the next match and Shift+Enter to the previous; Esc clears.
- State lives in `Transcript`: `query`, `matches = useMemo(() => findMatches(lines, query), …)`, and `matchIndex`.
- Stepping to a match calls `onFind(lineIndex)`. `PlayerPage` then seeks without autoplay, sets `follow = false`, and scrolls the row to center.
- Rows in `matches` render text through `markParts(text, query)` with `<mark className="find-mark">`. The active match row gets `data-active-match`.

**Range tint:** `Transcript` receives `range` and computes `bounds = range ? linesIn(lines, range) : null`. Rows within the bounds get `data-in-range` (the `--selected` background). The first and last in-range rows get `data-range-start` and `data-range-end` for rounded corners. `TranscriptLine` memo props include `inRange`, `rangeEdge`, and `marks` so only affected rows re-render.

**Selecting mode (touch):** when `selecting` is true, the transcript shows a top banner "Tap lines to extend the selection" with a "Done" button that calls `setSelecting(false)`.

- [ ] **Step 3: RangeBar and range playback in `PlayerPage`**

`PlayerPage` state:
- `range: Range | null`
- `loop: boolean`
- `playingRange: boolean`
- `exportOpen: boolean`

Range playback:
```ts
useEffect(() => {
  if (!range || !playingRange) return;
  return time.subscribe(() => {
    const t = time.get();
    if (t >= range.end - 0.04) {
      if (loop) controls.seek(range.start, true);
      else {
        controls.pause();
        setPlayingRange(false);
      }
    } else if (t < range.start - 0.5) setPlayingRange(false);
  });
}, [range, playingRange, loop, time, controls]);
const playRange = () => {
  if (!range) return;
  controls.seek(range.start, true);
  setPlayingRange(true);
};
```
When the user seeks outside the range through the timeline or a line click, call `setPlayingRange(false)`.

**`RangeBar`:**
- A floating bar inside the transcript panel, sticky to its bottom: `--popover` background, `--shadow-float`, `--r-3` radius, 8px padding.
- On phones it is fixed above the tab bar and safe area, full width minus 16px.
- Left side: `clock(start) – clock(end)` in `.num .mono`, then `humanDuration(end - start)` in muted text.
- Buttons, with labels on desktop and icons only (with tooltips and aria-labels) on phones:
  - Play range, or Stop (`Play`/`Square`).
  - Loop (`Repeat`, toggles `active`).
  - Copy (`Copy`): calls `api.transcriptText(id, start, end, "txt")`, then `copyText`, then toast "Passage copied".
  - Export (`Download`): opens the dialog.
  - Save note (`NotebookPen`): calls `openNote({ title: `${title} · ${clock(start)}`, body: "", quote, media_id: id, start, end })`, where `quote` is the in-range lines' text joined with a space.
  - Clear (`X`): clears the range, anchor, selecting mode, and range playback.
- It appears with a 150 ms rise and fade.

- [ ] **Step 4: Range shortcuts**

Add to the `PlayerPage` shortcuts:
```ts
{ key: "i", run: () => setRange((r) => setIn(r, time.get(), lines, controls.duration)) },
{ key: "o", run: () => setRange((r) => setOut(r, time.get(), lines, controls.duration)) },
{ key: "p", run: () => playRange() },
{ key: "l", run: () => setLoop((v) => !v) },
{ key: "Escape", run: () => clearRange() },
{ key: "f", mod: true, global: true, run: () => findInput.current?.focus() },
```
Also add these to `ShortcutSheet`: I "Set range start", O "Set range end", P "Play range", L "Loop range", Esc "Clear range", Ctrl F "Find in transcript", and Shift+click "Extend selection".

- [ ] **Step 5: ExportDialog**

`ExportDialog` (`Dialog md`, titled "Export range"). **Sections:**

1. **Range.**
   - Two text inputs, "Start" and "End", holding `clock`-precise values. Each is validated with `parseClock` on blur or Enter, and invalid input shows an inline error: "Use h:mm:ss, m:ss, or seconds".
   - Each has a "Use playhead" ghost button.
   - The duration reads "Length 2m 07s".
   - Edits call `onRange(clampRange(...))`.
2. **Media**, as radio cards in a 2×2 grid:
   - "M4A audio" ("AAC · small and widely supported").
   - "MP3 audio" ("Plays anywhere").
   - "MP4 video · accurate" ("Exact cut · re-encodes").
   - "MP4 video · fast" ("Quick · may start a few seconds early").
   - Video cards are disabled with "This recording has no video" when `kind === "audio"`.
   - All media cards are disabled with "Media unavailable" when `!mediaAvailable`.
3. **Transcript**, as radio cards:
   - "Text" (".txt with times and speakers").
   - "Markdown" (".md grouped by speaker").
   - "Subtitles" (".srt timed to this range").

**Default format:** `useStoredState("export-format-video-v1", "mp4-accurate")` for video and `useStoredState("export-format-audio-v1", "m4a")` for audio. It falls back to `txt` when media is unavailable.

**Footer:** Cancel, and "Export…" (primary).

**Export flow:**
```ts
const ext = { m4a: "m4a", mp3: "mp3", "mp4-fast": "mp4", "mp4-accurate": "mp4", txt: "txt", md: "md", srt: "srt" }[format];
const dest = await api.pickSavePath({ title: "Export range", name: label, extensions: [ext], defaultPath: exportName(media.title, range.start, range.end, ext) });
if (!dest) return;
setBusy(true);
setProgress(0);
const stop = isMedia ? await api.onExportProgress(setProgress) : () => {};
try {
  const path = isMedia
    ? await api.exportMedia(media.id, range.start, range.end, format, dest)
    : await api.exportTranscript(media.id, range.start, range.end, format, dest);
  toast.success(`Exported ${path.split("/").pop()}`, { label: "Show in folder", run: () => void api.reveal(path).catch(toast.error) });
  onOpenChange(false);
} catch (e) {
  if (!String(e).includes("cancelled")) toast.error(e);
} finally {
  stop();
  setBusy(false);
}
```
While busy, the body shows a progress bar (`--primary` fill, `width: progress * 100%`) and the percentage. The footer's primary button becomes "Cancel export", which calls `api.cancelExport()`. Closing the dialog while busy also cancels.

- [ ] **Step 6: NoteEditor range display**

When `note.start != null`, the note editor shows a chip `clock(start) – clock(end)` and "Play" (`Play` icon). Play navigates to `{ page: "recording", id: media_id, at: start }` and closes the editor.

- [ ] **Step 7: Screenshots and manual check**

1. Screenshots via `EXTRA`, using a small eval hook:
   - `player-range`: runs `window.__concordTest?.selectRange(3, 7)`. The hook `window.__concordTest = { selectRange(a, b) }` is exposed in `PlayerPage` only when `import.meta.env.DEV`.
   - `player-export`: runs `__concordTest.selectRange(3,7); __concordTest.openExport()`.
   - `player-find`: runs `__concordTest.find('archive')`.
2. Acceptance criteria:
   - The range tint and rounded ends show in the transcript.
   - The amber band shows on the timeline with its handles.
   - The range bar floats and doesn't cover the last line: the scroller gets bottom padding equal to the bar height.
   - The export dialog uses radio cards; its video options are disabled for audio.
   - On phones, the range bar docks above the tab bar and the export dialog is a sheet.
   - Find marks are visible in both themes.
3. Manual check on the mock in a browser:
   - Shift-click extends a selection.
   - Dragging text across three lines selects them.
   - Pressing I/O with the cursor in the find field does nothing.
   - Loop repeats the range.
   - Export shows progress to 100% and a toast with "Show in folder".

- [ ] **Step 8: Run the tests, build, and commit**

Run: `pnpm --dir desktop test:ts && pnpm --dir desktop build`
```bash
git add desktop/src
git commit -m "Select transcript ranges to loop, copy, save as notes, and export as audio, video, text, or subtitles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Search with highlighted, grouped results

**Files:**
- Create: `desktop/src/lib/search.ts`, `desktop/src/lib/search.test.ts`, `desktop/src/search/{SearchPage.tsx,search.css}`
- Modify: `desktop/src-tauri/src/db.rs` (`search`), `desktop/src/App.tsx`, `desktop/src/views.tsx` (delete `SearchView`)

**Interfaces:**
- Consumes: `api.search`, `SpeakerChip`, `speakerColor`, and `voiceLabel`.
- Produces:
  - `groupHits(hits): HitGroup[]` and `highlightParts(marked): Part[]`.
  - Rust `search` rows with `date`, `marked`, `speaker_name`, and `speaker_color`, limited to 200.

- [ ] **Step 1: Write the failing Rust search test**

In the `db.rs` tests, using `library_fixture` from Task 6:
```rust
#[test]
fn search_marks_matches_and_names_speakers() {
    let (_tmp, root) = library_fixture();
    open(&root).unwrap().execute_batch(
        "INSERT INTO segments(media_id,start,end,speaker,text) VALUES
           ('a',12.5,15,'S0','We met at the harbour'),('c',3,4,'S9','harbour lights');",
    ).unwrap();
    let hits = search(&root, "harbour").unwrap();
    let alpha = hits.iter().find(|h| h["id"] == "a").unwrap();
    assert_eq!(alpha["marked"], "We met at the \u{2}harbour\u{3}");
    assert_eq!(alpha["text"], "We met at the harbour");
    assert_eq!(alpha["speaker_name"], "Sarah");
    assert_eq!(alpha["speaker_color"], "#ff0000");
    assert_eq!(alpha["date"], "20251007");
    assert_eq!(alpha["start"], 12.5);
    let gamma = hits.iter().find(|h| h["id"] == "c").unwrap();
    assert!(gamma["speaker_name"].is_null());
    assert!(search(&root, "\" OR *").unwrap().is_empty());
}
```
Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml search_marks`. Expected: FAIL (`marked` is null).

- [ ] **Step 2: Implement the search query**

Replace the SQL in `db::search`:
```rust
rows(
    &open(root)?,
    "SELECT m.id, m.title, m.channel, m.date, segments.text AS text,
            highlight(segments, 4, char(2), char(3)) AS marked,
            CAST(segments.start AS REAL) AS start, segments.speaker AS speaker,
            sp.name AS speaker_name, sp.color AS speaker_color
     FROM segments
     JOIN media m ON m.id = segments.media_id
     LEFT JOIN assignments a ON a.media_id = segments.media_id AND a.local_id = segments.speaker
     LEFT JOIN speakers sp ON sp.id = a.speaker_id
     WHERE segments MATCH ?1
     ORDER BY rank LIMIT 200",
    [fts],
)
```
Run the test and expect a PASS. Then run the full `cargo test` suite, since the migration test also exercises `search`.

- [ ] **Step 3: Write the TS helpers with tests**

`desktop/src/lib/search.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupHits, highlightParts } from "./search.ts";
import type { SearchHit } from "./types.ts";

const hit = (id: string, start: number): SearchHit => ({
  id, title: `T${id}`, channel: "C", date: "20250101", text: "x", marked: "x", start, speaker: null, speaker_name: null, speaker_color: null,
});

test("groups keep first-seen order and collect every hit", () => {
  const groups = groupHits([hit("b", 1), hit("a", 2), hit("b", 3)]);
  assert.deepEqual(groups.map((g) => g.id), ["b", "a"]);
  assert.deepEqual(groups[0].hits.map((h) => h.start), [1, 3]);
});

test("highlight markers become parts; stray markers are tolerated", () => {
  assert.deepEqual(highlightParts("We met at the \u0002harbour\u0003 today"), [
    { text: "We met at the ", mark: false }, { text: "harbour", mark: true }, { text: " today", mark: false },
  ]);
  assert.deepEqual(highlightParts("\u0002x"), [{ text: "x", mark: true }]);
  assert.deepEqual(highlightParts("plain"), [{ text: "plain", mark: false }]);
});
```
`desktop/src/lib/search.ts`:
```ts
import type { SearchHit } from "./types.ts";
import type { Part } from "./range.ts";
export type HitGroup = { id: string; title: string; channel: string; date: string; hits: SearchHit[] };
export function groupHits(hits: SearchHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const hit of hits) {
    let g = groups.get(hit.id);
    if (!g) {
      g = { id: hit.id, title: hit.title, channel: hit.channel, date: hit.date, hits: [] };
      groups.set(hit.id, g);
    }
    g.hits.push(hit);
  }
  return [...groups.values()];
}
/** SQLite highlight() wraps matches in \u0002…\u0003. */
export function highlightParts(marked: string): Part[] {
  const parts: Part[] = [];
  let mark = false;
  let text = "";
  for (const ch of marked) {
    if (ch === "\u0002" || ch === "\u0003") {
      if (text) parts.push({ text, mark });
      text = "";
      mark = ch === "\u0002";
    } else text += ch;
  }
  if (text) parts.push({ text, mark });
  return parts;
}
```
Run `pnpm --dir desktop test:ts` and expect a PASS.

- [ ] **Step 4: Build SearchPage**

- **Input:**
  - `PageHeader` "Search", then a large search field (48px, `--text-lg`, `Search` icon) that is autofocused and holds `route.q`.
  - Typing is debounced by 250 ms and then calls `navigate({ page: "search", q }, { replace: true })`.
  - A spinner shows while loading.
- **Meta line:** `count(hits.length, "match", "matches")` across `count(groups.length, "recording")`, plus "· showing the first 200" when there are 200. The right side reads "Word search · on this computer".
- **Results:** each group is a `.search-group` panel.
  - A header button showing the title (weight 600), `channel · prettyDate(date)`, and a `count(hits, "match", "matches")` chip. Clicking it opens the first hit.
  - Hit rows are buttons, each holding:
    - A time chip (`clock(start)`, `.mono`, with a `Play` icon).
    - A `SpeakerChip` with `name = speaker_name ?? voiceLabel(speaker ?? "")` and `color = speakerColor(speaker_color, speaker_name ?? speaker ?? "")`. It is omitted when there is no speaker.
    - The text rendered from `highlightParts(marked)` with `<mark className="find-mark">`.
  - Clicking a hit calls `navigate({ page: "recording", id, at: start })`.
- **Empty states:**
  - No query: "Search every transcript" / "Find a name, a phrase, or a word you remember."
  - No results: "No matching passages" / "Try fewer words or a different spelling."
- Replace `SearchView` in App.

- [ ] **Step 5: Screenshots, build, commit**

1. Run `node desktop/scripts/screens.mjs "$SCRATCH/screens" search`. Acceptance: groups are readable, marks are visible, the speaker chips are colored, and the phone layout stacks cleanly.
2. Run: `pnpm --dir desktop test:ts && pnpm --dir desktop build && cargo test --manifest-path desktop/src-tauri/Cargo.toml`
3. Commit:
```bash
git add desktop/src desktop/src-tauri/src/db.rs
git commit -m "Group search results by recording with highlighted words and named speakers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Documents, Notes, Speakers, Map, and Settings on the new system; remove the old views

**Files:**
- Create: `desktop/src/documents/{DocumentsPage.tsx,Markdown.tsx,documents.css}`, `desktop/src/notes/{NotesPage.tsx,notes.css}`, `desktop/src/speakers/{SpeakersPage.tsx,speakers.css}`, `desktop/src/map/{MapPage.tsx,map.css}`, `desktop/src/settings/{SettingsPage.tsx,settings.css}`
- Modify: `desktop/src-tauri/src/db.rs` (`speakers` order), `desktop/src/App.tsx`, `desktop/src/main.tsx` (remove the `style.css` import)
- Delete: `desktop/src/views.tsx`, `desktop/src/style.css`

**Interfaces:**
- Consumes: `api.research`, `api.document`, `api.importDocuments`, `api.pickDocuments`, `api.speakers`, `api.linkNotes`, `api.speechStatus`, `api.importLegacy`, `api.pickDatabase`, `api.version`, `useAppearance`, `THEMES`, and `openNote`.
- Produces: `Markdown({ source })`.

- [ ] **Step 1: Test and implement the speakers order**

Add to the `db.rs` tests:
```rust
#[test]
fn speakers_are_listed_by_speaking_time() {
    let (_tmp, root) = library_fixture();
    let list = speakers(&root).unwrap();
    assert_eq!(list[0]["name"], "Tom");
    assert_eq!(list[1]["name"], "Sarah");
    assert_eq!(list[1]["airtime"], 400.0);
    assert_eq!(list[1]["recordings"], 1);
}
```
Run it and expect a FAIL (the current order is by name). Then change the `ORDER BY` in `db::speakers` to `airtime DESC, s.name COLLATE NOCASE`. Run it again and expect a PASS.

- [ ] **Step 2: Port Markdown**

1. Copy the parsing functions from `client/src/components/Markdown.tsx` into `desktop/src/documents/Markdown.tsx`: `stripExcalidrawScene`, `parseBlocks`, `isBlockStart`, `renderBlock`, `renderInline`, and the `Block` type.
2. Remove the image-resolver context. Images render as a `.md-image-missing` chip showing "Image: {alt}", because document bodies are stored text without their folders.
3. Replace every Tailwind class with a semantic class: `md`, `md-h1`…`md-h6`, `md-ul`, `md-ol`, `md-quote`, `md-pre`, `md-code`, `md-hr`, `md-link`.
4. Links open only `http(s)` URLs, with `target="_blank" rel="noreferrer"`; everything else renders as text.
5. `documents.css` styles `.md` in `--font-reading` at `--reading-size`, line-height 1.7, max-width 72ch, with heading sizes on a 1.25 ratio in `--font-serif`, `--primary` links, code in `--font-code` on `--muted`, and the quote as a 3px `--border` left rule in muted text.

- [ ] **Step 3: Build DocumentsPage, NotesPage, SpeakersPage, MapPage, SettingsPage**

**DocumentsPage** (route `documents`):
- **List view:**
  - `PageHeader` "Documents", meta `count(n, "document")`, and action "Add documents": `api.pickDocuments()`, then `api.importDocuments`, then a toast and refresh.
  - A filter field.
  - Dense rows at `--row-h`: a `FileText` icon, the title, and `humanLength(length)` on the right, where `humanLength` gives `"12k characters"` for 1000 and above, and otherwise `"n characters"`.
  - Clicking a row opens `{ page: "documents", id }`.
- **Reader view** (`route.id`):
  - A back ghost button, and the title as a serif `h1`.
  - `<Markdown source={body} />` in a `--card` panel with 32px padding (16 on phones).
  - Empty body: "No text was indexed for this document. Import the original Markdown file to read it here."

**NotesPage:**
- `PageHeader` "Notes", meta `count(n, "note")`, and action "New note", which calls `openNote({ title: "", body: "" })`.
- Rows show:
  - The title (weight 600).
  - A one-line snippet of the body, falling back to the quote.
  - When linked, a chip with the recording and `clock(start)`. The recording title is resolved via `api.recording`; alternatively extend `research` to join the title. Choose the join: in `lib.rs` `research`, change the notes query to `SELECT n.*, m.title AS media_title FROM notes n LEFT JOIN media m ON m.id = n.media_id ORDER BY n.created_at DESC`.
  - The created date, muted.
- Clicking a row calls `openNote(note)`.
- Empty state: "A place to think" / "Save a passage from a transcript, or start a note here."

**SpeakersPage:**
- `PageHeader` "Speakers", meta `count(n, "voice") · humanDuration(total) + " of speech"`, and a filter field.
- Dense rows: a color dot (`speakerColor`), the name, `humanDuration(airtime)` (`.num`), `count(recordings, "recording")` (`.num`), and a notes snippet (muted, one line).
- The rows are sorted by the backend.
- Empty state: "No saved voices yet" / "Open a recording and name a voice to start your speaker library."

**MapPage:**
- Port `MapView` with the same circle layout, the same link controls using the `Select` primitive, and the same `api.linkNotes`.
- SVG colors come from tokens through CSS classes: the node `rect` uses the `--card` fill and a `--border` stroke; `:hover`/`:focus` uses a `--primary` stroke; lines use `--muted-foreground` at 50% alpha; text uses `--foreground` in `--font-ui`.
- On phones the link controls stack, and the SVG keeps `viewBox` scaling.

**SettingsPage:** a single column with max-width 760px and four sections in `--card` panels.
1. **Appearance:**
   - Theme `Select` over `THEMES`. The label is "Concord (default)" for `concord`; otherwise the name is prettified, e.g. `lifeOS` stays as-is and `altar-invert` becomes "Altar invert".
   - Mode `Segmented`: System, Dark, Light.
   - Transcript text `Segmented`: Serif, Sans.
   - A live preview line in `--font-reading`: "“The words that matter, right where you left them.”"
2. **Speech:** port the existing card: the readiness badge, the device `Select` (Automatic · GPU when available / CPU / GPU · Vulkan; Vulkan is disabled unless the runtime device is `vulkan:0`), the runtime facts, the not-ready explanation, and "Check again".
3. **Library:**
   - The data folder in `.mono`, and the counts.
   - "Import Concord library": disabled when `overview.media > 0`, with the caption "Import is available for an empty library so existing edits stay safe." It calls `api.pickDatabase()`, then `api.importLegacy(path)`, then a toast and refresh.
4. **About:** "Concord Next {version}" via `api.version()`, and "Everything stays on this computer. Search runs locally; nothing is sent to an AI provider."

- [ ] **Step 4: Remove the old views and stylesheet**

1. Delete `desktop/src/views.tsx` and `desktop/src/style.css`, and remove the `style.css` import from `main.tsx`.
2. Check for leftovers: `grep -rn "views\"\|views'\|style.css" desktop/src` should print nothing.
3. Check that no literal colors remain outside the allowed files: `grep -rnE "#[0-9a-fA-F]{3,8}\b" desktop/src --include=*.css | grep -v "theme/"` should print nothing.
4. `lib/speakers.ts` holds the speaker palette by design.

- [ ] **Step 5: Screenshots, tests, build, commit**

1. Run `node desktop/scripts/screens.mjs "$SCRATCH/screens"` (the full matrix).
2. Review every page in dark and light at all four sizes. Acceptance:
   - Consistent spacing and control heights.
   - No clipped text at 390px.
   - Documents read comfortably.
   - Settings previews update.
3. Run: `pnpm --dir desktop test:ts && pnpm --dir desktop build && cargo test --manifest-path desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
4. Commit:
```bash
git add -A desktop/src desktop/src-tauri/src
git commit -m "Move Documents, Notes, Speakers, Map, and Settings onto the new design system

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`git add -A desktop/src` records the deletions. `.aws` is outside `desktop/`, so it is never staged.)

---

### Task 14: Full verification, packaging, installed-app smoke test, handoff

**Files:**
- Modify: `desktop/package.json`, `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/tauri.conf.json` (version `0.2.0`), `docs/HANDOFF.md`

- [ ] **Step 1: Run the whole automated suite**

Run:
```bash
pnpm --dir desktop test:ts
pnpm --dir desktop build
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```
Expected: everything passes. Record the test counts for the handoff.

- [ ] **Step 2: Run the design review pass over the full screenshot matrix**

1. Run `node desktop/scripts/screens.mjs "$SCRATCH/final"` with the `EXTRA` interaction shots from Tasks 7, 11, and 5 (menu, filters, range, export, find, palette).
2. Review every image against the spec's design direction:
   - Density.
   - Amber reserved for primary, playhead, and selection.
   - Hairline borders.
   - Serif titles and transcripts.
   - No hover-only controls on phones.
   - Focus rings.
   - Light-mode contrast.
3. Also switch to three tweakcn themes (`&theme=lifeOS`, `&theme=mono`, `&theme=claude`) for the library and player shots, and confirm nothing depends on brand literals.
4. Fix issues and re-shoot until clean. Commit the fixes as "Polish …" commits.

- [ ] **Step 3: Bump the version and package**

1. Set `"version": "0.2.0"` in `desktop/package.json` and `desktop/src-tauri/tauri.conf.json`, and `version = "0.2.0"` in `desktop/src-tauri/Cargo.toml`.
2. Run: `PATH="$HOME/.cache/concord-build-tools:$PATH" pnpm --dir desktop package`
3. Expected: the AppImage and deb are under `desktop/src-tauri/target/release/bundle/`. Record their sizes.

- [ ] **Step 4: Smoke-test the build against a copy of the library before installing**

1. Make an isolated copy:
   ```bash
   mkdir -p "$SCRATCH/next-data"
   sqlite3 ~/.local/share/concord-next/library.db ".backup '$SCRATCH/next-data/library.db'"
   ```
2. **Ask the user before launching**, because a visible window will open on their desktop.
3. Launch with a separate identity so the single-instance plugin doesn't hand off to their running copy:
   ```bash
   CONCORD_NEXT_DATA="$SCRATCH/next-data" pnpm --dir desktop tauri dev --config '{"identifier":"app.concord.next.review"}'
   ```
   If the dev config override is rejected, run the built binary `desktop/src-tauri/target/release/concord-next` with `CONCORD_NEXT_DATA` set, after temporarily changing the identifier in a scratch copy of `tauri.conf.json`.
4. With `grim` (window geometry from `hyprctl clients -j`) and the user's go-ahead, verify:
   - The library migrated to v2 (`sqlite3 "$SCRATCH/next-data/library.db" "PRAGMA user_version"` prints 2), and filters, sort, star, and review persist after reopening.
   - A long recording (the 179-minute meeting) opens. It resumes at its saved position, and follow-along stays smooth.
   - Space, ←/→, I/O, and L behave as specified, and Space on a focused button doesn't double-toggle.
   - A range exports to M4A, MP3, and MP4 accurate. Each duration matches within 0.2 s (`ffprobe`), and "Show in folder" opens the file manager with the file selected.
   - Copy puts the formatted passage on the clipboard (`wl-paste`).
   - Save note creates a note that shows as a timeline marker.
   - Switching the theme and mode works live.
   - An AV1/Opus video still plays, via the loopback streaming path.
5. Fix any issues and repeat.

- [ ] **Step 5: Install**

1. Run: `bash scripts/install-next-local.sh "desktop/src-tauri/target/release/bundle/appimage/Concord Next_0.2.0_amd64.AppImage"`
2. The running copy keeps its old inode. Tell the user to close and reopen Concord Next to get 0.2.0, after checking for an active transcription job.

- [ ] **Step 6: Update the handoff**

Update `docs/HANDOFF.md` with:
- The Delivery 1 state and what changed: design system, themes, shell, Library parity, player rebuild, ranges and export, search grouping, and restyled pages.
- The new commands and schema v2.
- The dev mock and screenshot workflow.
- The test counts, the verification performed and what was not verified.
- Package sizes.
- The next deliveries, in the agreed order: Speakers, Notes, Search and AI, Map, Channels/pipeline and batch re-transcription.

Keep the existing facts that remain true, and correct the ones this delivery changed: navigation, the Settings layout, and the "Remaining work" list.

- [ ] **Step 7: Commit**

```bash
git add desktop/package.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/tauri.conf.json docs/HANDOFF.md
git commit -m "Release Concord Next 0.2.0 with the rebuilt interface and document the handoff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
