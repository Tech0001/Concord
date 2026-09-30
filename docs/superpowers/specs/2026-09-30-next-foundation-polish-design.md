# Concord Next — Delivery 1: Foundation, polish pass, and player ranges

Date: 2026-09-30 · Branch: `rewrite/rust-tauri` · Status: approved in conversation, pending spec review

## Why

Concord Next (Tauri/Rust) is replacing the Electron app. The user liked the Electron
app and wants the same capabilities rebuilt in Tauri and **more polished** — not
reinvented. The current Next UI is a first preview: decorative, low density, several
placeholder pages, and it lacks the player tools the user relies on (selecting a range,
exporting it, saving it as a note).

This is the first of six deliveries. Each area reaches Electron parity, then gets polished:

1. **Foundation, polish pass, and player ranges** ← this spec
2. Speakers (Electron parity: edit, rescan/find matches, merge, noise, appearances, unidentified queue)
3. Notes (multi-anchor, tags, typed links, Notes page, range notes)
4. Search + AI (one search: words + meaning + chat; separate embedding/chat providers)
5. Map
6. Channels/pipeline (subscriptions, downloads, durable batch re-transcription queue; no Watchers)

Legacy-data top-up/sync is explicitly deferred. New columns are added fresh as features need them.

## Scope

**In:** visual system and theming; app shell; Library parity and polish; player rebuild
including line-level range selection, loop, copy, export, save-as-note (existing simple
note model); restyle of Search, Documents (with Markdown rendering), Settings; bug fixes
found during the pass; a browser preview harness for design verification.

**Out:** Speakers rebuild, Notes rebuild (tags, multi-anchor, links), semantic search/AI,
Map, channels/pipeline/batch queue, legacy data sync, file rename/trash, macOS/Windows.
The current simple Speakers and Notes pages get the new styling only.

## Design direction

A research tool for long spoken-word recordings. It should feel **calm, crisp, and
dense** — closer to a well-made editor than a media streaming app. Information-dense
lists and rows over decorative cards; generous only where reading happens (transcripts,
documents).

- **Palette (brand theme)** from the supplied icon: navy `#1B2230`, amber `#E0A24B`,
  cream `#EFEBE3`. Dark is the default; light is a warm paper variant with a deeper
  ochre primary for contrast. Amber is reserved for the primary action, the playhead,
  the active selection/range, and focus — not decoration.
- **Type:** Inter (UI), Source Serif 4 (page titles, transcript and document reading
  text; echoes the wordmark's serif), JetBrains Mono (timecodes, tabular numbers). All
  vendored as woff2 under OFL, no network fonts. Base UI size 13–14px. A Settings option
  switches transcript text between serif and sans.
- **Wordmark:** render the supplied icon SVG plus "Concord" as live text in the bundled
  serif (the supplied wordmark SVG names fonts that are not installed, so it renders in
  fallbacks today). Drop the cream box behind it.
- **Density:** 32–36px list rows, 8px spacing grid, restrained radii (6–10px), hairline
  borders, shadows only on floating layers (menus, dialogs, toasts, range bar).
- **Motion:** 120–180ms ease-out for popovers/toasts; no decorative animation;
  respects `prefers-reduced-motion`.
- **Remove:** eyebrow marketing copy ("A PLACE FOR EVERY CONVERSATION"), oversized page
  headings, the background texture, the "NEXT · PREVIEW" plaque. Page headers become a
  compact title row with counts and actions.

### Theme system

- Tokens use **tweakcn/shadcn variable names** (`--background`, `--foreground`, `--card`,
  `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`,
  `--border`, `--input`, `--ring`, `--sidebar-*`, `--chart-1..5`, `--font-sans|serif|mono`,
  `--radius`) plus a small set of app tokens derived with `color-mix()` (e.g. hover,
  selection, range fill). App CSS only reads tokens — no literal colors outside theme files.
- Themes: `concord` (brand, default) plus the 12 existing tweakcn files from
  `client/src/themes/` copied into `desktop/src/theme/themes/`. Only their `:root` and
  `.dark` blocks are used (same scoping approach as legacy `themes/index.ts`).
- Settings → Appearance: theme select, mode (System / Dark / Light), transcript font.
  Persisted in localStorage and applied before React mounts (no flash).
- Themes that name unbundled fonts fall back to the system stack; that's acceptable.

## Architecture

### Frontend structure

Split the 1,184-line `views.tsx` into feature folders. Each file has one purpose.

```
desktop/src/
  main.tsx, App.tsx            app root, page state, providers
  lib/        ipc.ts (typed invoke wrappers), format.ts (time/date/bytes),
              storage.ts (safe localStorage), shortcuts.ts (keyboard hook),
              range.ts (pure range math), *.test.ts
  theme/      tokens.css, concord.css, themes/*.css, theme.ts
  fonts/      vendored woff2 + LICENSE files, fonts.css
  ui/         Button, IconButton, Menu, Dialog, ConfirmDialog, Toasts, Select,
              Segmented, Chip, SpeakerChip, Kbd, Empty, PageHeader, Tooltip
  shell/      Sidebar, Topbar, CommandPalette, ActivityPanel
  library/    LibraryPage, LibraryGrid, LibraryList, LibraryToolbar, RecordingMenu
  player/     PlayerPage, Transport, Timeline, Waveform, Transcript, RangeBar,
              ExportDialog, ShortcutSheet, useMedia.ts, useRange.ts
  search/, documents/ (incl. Markdown.tsx), notes/, speakers/, map/, settings/
  dev/        mock-ipc.ts + fixtures (dev-only, excluded from production build)
```

CSS is co-located per folder and imported by its components; global CSS is limited to
fonts, tokens, reset, and base typography.

**Dependencies:** add `@radix-ui/react-dialog`, `@radix-ui/react-popover`,
`@radix-ui/react-select` and `cmdk` to `desktop/package.json` at **the exact versions
already pinned in the root lockfile** (1.1.15, 1.1.15, 2.2.6, 1.1.1). No other new npm
packages. Menus are built on Popover; tooltips are CSS-only.

### Backend additions (Rust)

- **Schema migration** keyed on `PRAGMA user_version` (1 → 2), idempotent:
  `media` gains `starred INTEGER NOT NULL DEFAULT 0`,
  `review_state TEXT NOT NULL DEFAULT 'unreviewed'` (`unreviewed|in_review|reviewed`),
  `position REAL NOT NULL DEFAULT 0`, `opened_at TEXT`.
- **`library`** takes a filter struct: `query` (title, channel, or path), `channel`,
  `kind` (`audio|video|''`, by file extension), `transcribed` (`yes|no|''`), `starred`,
  `review`, `sort` (`newest|oldest|opened|words|title|longest`), `offset`, `limit`
  (60/120/240). Returns items with `speakers: [{name,color,airtime}]` (named voices only,
  top 3 plus total count) and the existing counts.
- **New commands:** `set_starred(id, starred)`, `set_review(id, state)`,
  `save_position(id, seconds)` (also sets `opened_at`), `palette(query)` (grouped LIKE
  search over recordings, speakers, notes, documents; 6 per group),
  `export_media(id, start, end, format, dest)`,
  `export_transcript(id, start, end, format, dest)`, `reveal_path(path)`,
  `waveform(id)` (audio peaks, cached).
- **Media export** runs ffmpeg in a child process: formats `m4a` (AAC 160k), `mp3`
  (libmp3lame q2), `mp4-fast` (stream copy, keyframe-inexact, noted in the UI),
  `mp4-accurate` (libx264 veryfast crf 20 + AAC). Audio-only sources can't export video.
  Writes to a temp file next to `dest`, then renames; removes partial output on failure.
  Destination comes from the native save dialog (`dialog:allow-save` capability).
- **Transcript export** formats `txt` (`[mm:ss] Speaker: text` lines under a
  title/source header), `md` (title, source, range, speaker-attributed blockquotes),
  `srt`. Speaker names come from assignments; unnamed voices keep their local label.
  Also used for "Copy" (returns a string instead of writing a file).
- **Reveal:** D-Bus `org.freedesktop.FileManager1.ShowItems`, falling back to
  `xdg-open` on the parent folder.
- **Waveform:** ffmpeg decodes to 8 kHz mono s16 and reduces to ~2,000 peak buckets,
  cached as JSON under the data root keyed by media id. Audio-only recordings only.

## Screens

### Shell

- **Sidebar**, grouped and collapsible to a 56px icon rail (persisted):
  *Archive* — Library, Search, Documents, Notes; *Analysis* — Speakers, Map; bottom —
  Activity (live status: "Transcribing <title> · 42%" or idle), Settings. The library
  count stays; other counts appear where meaningful.
- **Top bar:** page title/breadcrumb, command-palette trigger ("Search or jump to…
  Ctrl K"), Add recordings.
- **Command palette (Ctrl/⌘K):** groups for Recordings, Speakers, Notes, Documents,
  and Actions (Add recordings, go to each page, switch theme mode, open Settings).
- **Toasts:** bottom-right stack (max 3), success/info/error, optional action button
  (e.g. "Show in folder"), auto-dismiss after 5s; errors persist until dismissed. They
  replace the full-width error banner. Destructive actions use `ConfirmDialog`.
- **Activity panel:** slide-over listing jobs with status, message, and cancel.

### Library

- **Toolbar:** filter field (title, collection, path), collection select, Filters
  popover (type, transcribed, starred, review) with active-count badge and Reset, sort
  select, grid/list toggle, page size. The summary line reads
  "2,020 recordings · 1,996 transcribed". All settings persist.
- **Grid card:** 16:9 thumbnail or audio cover, duration, resume progress bar, star
  (always visible when starred, on hover otherwise), 2-line title, collection · date,
  up to 3 colored speaker chips + "+N", transcription state, review badge, ⋮ menu.
- **List view:** star · date · title (+ speaker chips) · collection · duration · words ·
  status · review · ⋮. Rows are 36px.
- **⋮ menu:** Open, Resume at m:ss (if a position exists), Transcribe/Re-transcribe,
  Review state ▸, Star/Unstar, Show file in folder, Copy file path.
- The hardcoded "Meetings" tab is removed.

### Player

The layout keeps the resizable split (media left, transcript right, persisted width).

- **Header:** back to Library, ‹ › previous/next (the current Library list order),
  title, collection · date · duration · words · model, Transcribe/Re-transcribe, ⋮
  (Show in folder, Copy path).
- **Media:** video without native controls; audio-only shows the cover plus the
  waveform. Fullscreen enables native controls. Picture-in-picture is out of scope.
- **Transport bar:** play/pause, back/forward 10s, current/total time (mono), speed
  (0.75–2×, persisted), volume/mute.
- **Timeline** under the transport:
  - A speaker lane: turns colored by speaker, merged across gaps under 2s, with a
    tooltip.
  - The playhead, and a hover time readout.
  - Click to seek; drag to scrub.
  - The selected range is an amber band with draggable handles.
  - Markers for saved notes on this recording.
- **"In this recording"** panel: speakers with color, airtime, and naming. It keeps the
  current name dialog, restyled; the full label dialog comes in Delivery 2.
- **Transcript:**
  - Each line has a mono timestamp and the speaker name in its color, and is set in the
    reading font.
  - The current line is highlighted and auto-followed. Auto-follow pauses when the user
    scrolls, and a "Back to playback" pill resumes it.
  - Find: a field with an "n of m" count, ▲▼ and Enter/Shift+Enter to step, and matches
    highlighted in the text.
  - Clicking a line seeks and plays.
- **Ranges (line-level):**
  - Shift-click extends from the anchor line. Ordinary text selection that spans lines
    sets the range to the lines it touches; Ctrl+C still copies the raw selected text.
    `I` and `O` set start and end at the playhead. Dragging a timeline handle fine-tunes
    the times.
  - The range is `{start, end}` in seconds. Transcript lines that overlap it get a
    selected tint.
  - **Range bar** (floating, above the transcript bottom edge): time span and duration
    · Play range · Loop · Copy · Export ▸ · Save note · Clear.
    - Copy puts the text with times and speakers on the clipboard.
    - Save note opens the existing note editor prefilled with the quote and range.
  - **Export dialog:** a Media section (M4A, MP3, MP4 fast, MP4 accurate; video options
    are disabled for audio-only) and a Transcript section (TXT, Markdown, SRT). The
    dialog shows the range with editable start/end fields (`h:mm:ss`), then opens the
    save dialog with a suggested name `<title> — 12m03s–14m10s.<ext>`. Progress shows
    inline; completion raises a toast with "Show in folder".
- **Resume:** the position is saved on pause, on close, and every 10s of playback. The
  player opens at the saved position unless it was opened at an explicit time (search
  hit, note).
- **Keyboard** (ignored while typing in a field): Space play/pause, ←/→ ±10s,
  Shift+←/→ ±60s, ↑/↓ previous/next line, I/O range start/end, P play range, L loop,
  Esc clear range, `<`/`>` speed, M mute, F fullscreen, `?` shortcut sheet.
- **Bug fixes:**
  - An interrupted `play()` (`AbortError`) is ignored instead of shown as an error.
  - Media errors show once, in a quiet inline state.

### Search

Restyle only. Results are grouped by recording (header: title, collection, date, hit
count), with hits listed under it. Matched words are highlighted using FTS5
`highlight()`, and each hit shows its speaker name and color. Opening a hit starts the
player at that time.

### Documents

- **List:** dense rows with title, size, and a filter field.
- **Reader:** renders Markdown using a port of the legacy dependency-free renderer
  (`client/src/components/Markdown.tsx`), set in the reading font, with a comfortable
  measure (~72ch).

### Notes, Speakers, Map

These are restyled to the new system only. Notes becomes a dense list plus the restyled
editor; Speakers becomes a list sorted by airtime (the full rebuild is Delivery 2); Map
gets the new tokens. There are no functional changes.

### Settings

A single page with sections:
- **Appearance:** theme, mode, transcript font.
- **Speech:** the existing card, restyled.
- **Library:** data folder and legacy import.
- **About:** version and the local-only statement.

## Error handling

- Every IPC call goes through `lib/ipc.ts`. Failures raise an error toast carrying the
  backend message; components never swallow errors silently. The one exception is the
  `AbortError` from interrupted playback, which is expected.
- Export validates `0 ≤ start < end ≤ duration` in Rust. It reports ffmpeg's stderr tail
  on failure and never leaves partial files behind.
- Missing media (a drive is disconnected) shows a clear inline state in the player and
  disables media export. Transcript export still works.
- The migration is transactional; a failure leaves the database at the old version and
  shows the error.

## Testing and verification

- **Rust:**
  - Migration is idempotent and adds the columns to an existing v1 database.
  - Library filters and sorts: each filter and sort order, plus speaker chip
    aggregation.
  - Star, review, and position commands.
  - Transcript export formatting for txt, md, and srt (speaker names, ranges, edge
    lines).
  - Media export round-trip: generate short audio and video fixtures with ffmpeg
    `lavfi`, export each format, and check the duration with ffprobe (±0.2s accurate;
    fast copy only checks that the file is created).
  - Waveform peak count.
  - `cargo clippy -D warnings` passes.
- **TypeScript:**
  - `lib/range.ts` (line↔time mapping, overlap, shift-extend, clamping), `lib/format.ts`,
    and theme parsing are tested with `node --test`. Node 26 runs `.ts` directly, so no
    new dependencies are needed.
  - `pnpm --dir desktop build` (tsc + vite) passes.
- **Visual:**
  - A dev-only mock IPC (`?mock` in a browser on `vite dev`) serves synthetic fixtures;
    no private data is committed.
  - Headless Chromium screenshots of every page at 1440×940 and 960×640, in dark and
    light, are reviewed for polish.
- **Real app:**
  - Build and install the AppImage via `scripts/install-next-local.sh`.
  - Verify in the real WebKitGTK window:
    - library filters and sort, star, and review;
    - opening a recording, resuming it, and previous/next;
    - playback and keyboard shortcuts;
    - range select, loop, and each export format (checked with ffprobe);
    - Copy, Save note, and the theme switch.
  - Screenshots are taken with `grim`. The user's running instance and the original
    Concord install are left untouched until the user restarts Next.

## Risks

- **Clipboard:** `navigator.clipboard` in WebKitGTK over the Tauri protocol is
  unverified. The fallback is a small Rust clipboard command, which may need `wl-copy`
  or `xclip`, or the Tauri clipboard plugin.
- **Fast-copy video exports** start on a keyframe, so they can begin a few seconds early.
  The UI says so, and Accurate is the default for video.
- **Waveform** generation for 3-hour recordings takes a few seconds on first open. It is
  cached and loads asynchronously, so the player stays usable meanwhile.
- **Radix in WebKitGTK:** the libraries are standard, but menus must be verified in the
  real app window, not only in Chromium.
