# Concord — Mac handoff briefing for Claude

You're picking up this project on macOS. The user already has a long
working history with Claude on a Linux dev box; you're a fresh session.
Read the *whole* file before doing anything.

---

## Who you're working with

The user is a non-AI engineer who knows what they want, treats Claude as a
real collaborator, and prefers:

- **Concise, technical responses.** No filler, no checklists for trivial work.
  When you're uncertain, say so plainly.
- **Show package changes before installing.** Edit `package.json`, surface
  the diff, and let the user run `npm install` themselves. They've been burned
  by malicious npm packages and want to review additions.
- **Type check after every meaningful change.** `npm run check` (which is
  `tsc`). Don't claim work is done until it passes.
- **Verify before claiming.** Always run `npm run check`/`npm run build`/
  `npm run dev` and *read* the output before saying it's working.
- **No premature abstractions.** Bug fixes don't need surrounding cleanup.
  Three similar lines is better than a premature abstraction.
- **Don't disable security features** (`--no-verify`, `--force`, etc.) unless
  explicitly asked.

If you have memory files from the Linux box, they'll be at
`~/.claude/projects/<path-encoded>/memory/`. Read `MEMORY.md` first and
follow its index. Those will save you from re-learning the user's
preferences.

---

## What Concord is

Personal research-archive web app for spoken-word media (originally a
YouTube transcript pipeline; now also accepts local files). Cross-platform.
Currently runs on Linux + CUDA. Goal of *this* session: get it running on
macOS, then later package it as a signed `.dmg` for a friend (a
non-technical YouTuber who wants to search transcripts of his own uploads).

### Architecture (already shipped, do not rewrite)

- **Backend:** Node 24, Express 5, TypeScript, `better-sqlite3`. Entry point
  `server/index.ts`. Pipeline at `server/pipeline.ts` — orchestrates download
  → audio extract → transcribe → FTS index. Routes at `server/routes.ts`.
- **Frontend:** React 19, Vite 8, Tailwind 4 (CSS-first), `wouter` router,
  shadcn/ui primitives in `client/src/components/ui/`. Entry point
  `client/src/main.tsx`. Pages at `client/src/pages/`.
- **Transcription routing** (`server/transcribe.ts`): model name decides the
  engine. Today: `parakeet*` → `transcribe-parakeet.py` in `venv-parakeet/`;
  everything else → `transcribe.py` (faster-whisper) in `venv/`. Both Python.
- **Database:** SQLite at `./pipeline.db` (yes, in the repo root — that's
  going to change soon, see Step 2 below). Schema includes channels,
  video_queue, transcript_clips, clip_tags, clip_links, FTS over transcript
  segments.
- **Channels:** YouTube channels (URL `https://...`) and local-folder
  channels (URL `file://...`) coexist in the same `channels` table. The
  pipeline scanner branches on `channel.url.startsWith("file://")`. The
  worker also branches on `video.url.startsWith("file://")` to skip
  yt-dlp and feed the existing file straight into audio extraction.

### What works today on the Linux box

Everything: YouTube channel monitoring, local folder channels, downloads,
audio extract via ffmpeg, transcription via faster-whisper or parakeet
(NVIDIA NeMo on a 2080 Ti), FTS search, clips with tags + manual typed
links, per-video notes, force-graph map, library browsing, theme picker,
dark mode.

### What does NOT work on Mac yet

- The two Python venvs (`venv/`, `venv-parakeet/`) are CUDA-specific. Don't
  try to set them up on Mac — they won't help.
- Transcription has no Mac engine yet. **That's job 1 in this session.**

---

## Goals for this session, in order

### Step 1 — Get the app running on Mac

Just clone, install, and `npm run dev`. Should mostly work as-is on
macOS (Node, Express, ffmpeg, yt-dlp, better-sqlite3 all have Mac builds).

```bash
brew install ffmpeg node
git clone <repo url> ~/Documents/GitHub/Concord  # or wherever
cd ~/Documents/GitHub/Concord
npm install
npm run check     # should be 0 errors
npm run dev
```

Open `http://localhost:5000`. The UI should load fully; you can browse the
empty Library, view the Pipeline page, etc. **Don't** try to add a
YouTube channel yet — without a transcription engine, downloads will
queue but transcription will fail.

If anything breaks at the install/build/run step, fix it first. Common
gotchas on Mac:

- `better-sqlite3` may need rebuilding for the Mac architecture: `npm
  rebuild better-sqlite3` if you see binary-mismatch errors.
- yt-dlp inside `node_modules/youtube-dl-exec/` ships a Linux/macOS binary;
  on Apple Silicon it should work, but if not: `brew install yt-dlp` and
  symlink to the path the package expects.
- ffmpeg detection: the existing code uses `ffmpeg`/`ffprobe` from PATH. As
  long as `brew install ffmpeg` worked, no code change.

### Step 2 — Wire up FluidAudio for transcription

Real meat of this session. We've already decided on the engine (the
user has gone deep on the alternatives — don't re-debate it):

- **NOT** Python-based mlx-whisper or parakeet-mlx. The friend doesn't want
  Python on his Mac.
- **NOT** whisper.cpp. Slower than FluidAudio.
- **YES** FluidAudio: https://github.com/FluidInference/FluidAudio. Swift
  package that ships a CLI binary, runs Parakeet on the Apple Neural Engine
  via CoreML, ~155× realtime on Apple Silicon. The `macparakeet` app
  (https://github.com/moona3k/macparakeet) is built on it.

Build it once on the Mac:

```bash
xcode-select --install     # if not already done
git clone https://github.com/FluidInference/FluidAudio ~/code/FluidAudio
cd ~/code/FluidAudio
swift build -c release
```

The resulting binary is at `.build/release/fluidaudiocli`. Test it
manually first:

```bash
.build/release/fluidaudiocli transcribe /path/to/test.wav
```

**Verify the output schema** — the pipeline expects a JSON file alongside
the .md transcript with `text`, `segments` (start/end/text), `words`
(start/end/text), `language`, `duration_seconds`, `word_count`, etc. The
exact shape your wrapper emits should match what `transcribe-parakeet.py`
and `transcribe.py` produce. Look at those for the contract.

Then write the wrapper. **It can be pure TypeScript** — no Python needed
because FluidAudio is a binary spawn:

1. Create `server/transcribe-fluidaudio.ts` modelled on the pattern of how
   the existing transcribers are spawned. Inputs: audio path, output md
   path, model name. Spawn `fluidaudiocli`, capture stdout/JSON, write the
   .md and .json files in the same shape as the Python scripts.
2. Update `server/transcribe.ts` routing. Add a new branch: if model name
   starts with `fluid-` (e.g. `fluid-parakeet-tdt-v3`), route to the
   FluidAudio wrapper. Detect the binary via `FLUIDAUDIO_BIN` env var with
   a fallback to a default path; let the user configure where the binary
   is.
3. Update the model dropdown in `client/src/pages/Pipeline.tsx`. Add
   `fluid-parakeet-tdt-v3` as an option labelled something like
   "Parakeet (Apple Neural Engine, fastest on Mac)".

Do **not** delete the Python whisper/parakeet routes. The Linux box still
needs them. The routing should be: model name decides which engine spawns,
period. No platform detection at runtime.

Smoke test end-to-end after wiring:

1. Add a local-folder channel pointing at a directory with a 5-minute
   mp4 or mp3.
2. Set transcription model to `fluid-parakeet-tdt-v3` in Pipeline →
   Settings → Edit.
3. Run Check. Should: queue the file → audio extract → spawn
   fluidaudiocli → produce md + json → mark complete → become searchable
   in Library.

### Step 3 — Move SQLite to user-data dir (small, prep for Electron)

Today the DB is at `./pipeline.db`. For Electron-packaged apps, that path
disappears on each update because the bundle gets replaced. Move it to:

- macOS: `~/Library/Application Support/Concord/pipeline.db`
- Linux: `~/.local/share/concord/pipeline.db` (XDG)
- Windows: `%APPDATA%/Concord/pipeline.db`

Use the `app.getPath('userData')` pattern when in Electron later, but for
now just hardcode the OS-aware path in `server/db.ts`'s `getDb()`. The
existing dev DB at `./pipeline.db` should be migrated automatically:
on first launch with the new code, if `./pipeline.db` exists and the
user-data path doesn't, copy/move it. Add a one-line console log so the
user can see what happened.

This also helps the user's existing Linux setup — Time Machine equivalents
on Linux pick up `~/.local/share/` automatically.

### Step 4 — LLM features via local inference (oMLX on Mac / Ollama on Linux)

The user wants to add semantic search, auto-suggested tags, per-video
summaries, and eventually RAG ("Ask my library"). All driven by a local
LLM + embedding model — no API bills, no leaked private content.

**Don't pick the runtime per platform in code.** Both runtimes expose the
same **OpenAI-compatible HTTP API**. Concord just talks to whichever URL
is configured. One implementation, two runtimes.

| Platform | Runtime | Why | URL |
|---|---|---|---|
| Mac (this session, friend's machine) | **oMLX** (https://omlx.ai) | Native macOS app, signed/notarized DMG, paged SSD KV cache, multi-model (LLM + embedding + reranker simultaneously), runs MLX models on Apple Silicon. | `http://localhost:8000/v1` |
| Linux (user's dev box) | **Ollama** | brew/apt installable, works with the user's 2080 Ti via CUDA, same OpenAI shape. | `http://localhost:11434/v1` |

**Install oMLX on the Mac**:

1. Download the latest signed DMG from
   https://github.com/jundot/omlx/releases — drag to Applications.
2. First-run wizard walks through model directory, server start, first
   model download.
3. Pull two models from oMLX's built-in HuggingFace browser:
   - An LLM, e.g. `Qwen3-7B-Instruct-4bit-mlx` or similar small Qwen/Llama
     in MLX format. ~5 GB. Used for tag suggestions, summaries, RAG.
   - An embedding model, e.g. `bge-m3-mlx` or `nomic-embed-text-mlx`.
     ~250 MB. Used for semantic search and link suggestions.
   - Optionally a reranker (e.g. `bge-reranker-v2-m3-mlx`) — refines
     embedding-search results. Skip if not in oMLX's model catalog yet.
4. Verify with curl:
   ```
   curl http://localhost:8000/v1/models
   ```

**Wire it into Concord**:

1. Add three config knobs to the existing pipeline config (see
   `server/pipeline.ts` `loadConfig()` for the pattern):
   - `llmBaseUrl` (default `http://localhost:8000/v1` — the user can
     override to point at Ollama)
   - `llmModel` (the chat model, e.g. `qwen3-7b-instruct-4bit-mlx`)
   - `embeddingModel` (e.g. `bge-m3-mlx`)
2. Add matching fields to the Pipeline → Settings UI alongside the
   existing transcription model selector.
3. New file `server/llm.ts` — thin OpenAI-shaped client. Two functions:
   - `chat(messages, model)` → returns assistant text. Uses native fetch.
   - `embed(texts, model)` → returns array of Float32Array. Uses
     `/v1/embeddings` endpoint.
   Wrap both in a try/catch — if the LLM server isn't running, return
   a typed error so callers can degrade gracefully (hide the LLM-driven
   UI elements rather than throw).
4. New menu item or status indicator in the top bar: green dot when LLM
   is reachable, gray when not. Click → instructions on installing oMLX.

**Implement the use cases — START WITH SEMANTIC SEARCH** (highest leverage,
unblocks the others):

1. **Embedding store + semantic search.**
   - Schema: new table
     ```
     CREATE TABLE transcript_segment_embeddings (
       video_id TEXT NOT NULL,
       channel_id TEXT NOT NULL,
       segment_index INTEGER NOT NULL,
       embedding BLOB NOT NULL,  -- Float32Array bytes
       model TEXT NOT NULL,       -- which embedding model was used
       PRIMARY KEY (video_id, channel_id, segment_index, model)
     );
     CREATE INDEX idx_seg_emb_video ON transcript_segment_embeddings(video_id, channel_id);
     ```
   - Backfill job: for every existing transcript, batch-embed all segments
     (~50 at a time), store. Should run automatically after each new
     transcript completes (add to the pipeline worker after the FTS
     indexing step). Provide a "Reindex semantics" admin button.
   - At query time: embed the user's query, fetch ALL stored embeddings
     (it's small enough — 37k segments × 768 dims × 4 bytes ≈ 100 MB
     for a year of content, fits in RAM easily), compute cosine
     similarity in TS, return top-K. **Don't reach for sqlite-vec yet** —
     pure-JS cosine over 100k vectors takes ~50ms, no native deps needed.
     Switch to sqlite-vec only when the corpus exceeds 200k segments.
   - UI: Search page gets a "Mode" toggle next to the input — `Words`
     (current FTS) vs `Meaning` (semantic). Or merge: run both, fuse
     results. Start with the toggle; fusion can come later.

2. **Auto-suggested cross-video links.** Reuses the embedding store. In
   the VideoDrawer's Related Clips panel, add a third subsection
   "By topic" — for the currently-selected clip, find top-5 semantically
   nearest segments from *other* videos. Click → opens that clip.

3. **Auto-suggested tags.** When the user opens the TagPicker on a
   clip, call the LLM with the existing tag corpus + the clip quote:
   prompt asks for 3 most relevant tags, preferring existing ones,
   proposing new ones only if needed. Show as suggestions above the
   normal autocomplete list.

4. **Per-video AI summary in notes field.** Pipeline worker, after
   transcription completes: if the per-video `notes` field is empty,
   run a summarization pass on the transcript and write the result to
   notes. User can edit/replace freely. Only runs once per video (don't
   overwrite existing notes).

5. **RAG / Ask my library.** Defer until 1-4 are solid. New top-level
   "Ask" page: user types a question → embed → ANN search top-50
   segments → optionally rerank if reranker is available → feed top-10
   + the question to the LLM with a citation prompt → render answer
   with inline links to source clips/timestamps. Click a citation →
   VideoDrawer opens at that timestamp.

**Verification gates for this step**:

1. `curl http://localhost:8000/v1/embeddings -d '{"model":"bge-m3-mlx","input":["test"]}'`
   returns embeddings.
2. With LLM features wired, the Settings page shows the runtime status
   and lets the user choose models from a dropdown populated by
   `GET /v1/models`.
3. Embed all existing transcripts (the user has 73 — should take a few
   minutes on M-series).
4. Open Search page, switch to `Meaning` mode, search for a phrase that
   would NOT appear verbatim in any transcript but is conceptually
   present. Confirm matches surface.
5. Run `npm run check`/`build`/`dev`. Clean throughout.

When that's working, hand back to user. RAG and the other features (tag
suggestion, summary autofill) can be next-session work.

### Step 5 — Electron packaging (only after 1-4 are solid)

This is the heavy lift. Don't start it until the friend can use the
unpackaged app on the Mac via `npm run dev` and is happy with the
behavior.

Plan when you get here:

- `electron-builder` (not `electron-forge` — builder has better signing
  story).
- Main process spawns the existing Express server on a random local port,
  opens a `BrowserWindow` to it.
- Bundle binaries inside the app: `ffmpeg`, `ffprobe`, `yt-dlp`,
  `fluidaudiocli`. Update path resolution in `server/transcribe.ts`,
  `server/audio.ts`, `server/youtube-dl.ts` to look at bundled paths in
  production, fall back to `PATH` lookup in dev.
- Code signing: user has an Apple Developer account ($99/yr). Configure
  `electron-builder.yml` with the team identifier; `notarize: true`. They
  can sign locally with their developer ID Application cert.
- DMG output, drag-to-Applications template.

For now don't write any of this. Just keep the door open: don't add Linux-
specific assumptions to file paths or process spawning that would block
Electron later.

---

## Decisions already made — don't re-debate these

- App is called **Concord** (just renamed from "YouTube Ripper"). Top bar
  shows `C` mark + "Concord". package.json `name` is `concord`. localStorage
  keys are `concord-*` with legacy `yt-ripper-*` fallbacks for migration.
- The repo folder may still be `YouTube_Ripper` — rename to `Concord` is
  optional polish.
- Folder-as-channel is implemented via `file://` URLs in the channels
  table. Don't introduce a separate "kind" column or a separate table for
  local sources — it's the same row, branched at scan time.
- Manual clip-to-clip link kinds: `same_claim`, `contradicts`, `same_topic`,
  `follow_up`, `context`. Symmetric kinds (first three) auto-mirror. Don't
  rename `same_topic` (it was renamed from `same_scripture`; there's a
  migration in `runMigrations()`).
- Tag normalization: lowercase + trim + collapse whitespace. Hierarchy via
  dot-notation (`religion.end-times.rapture`). Filtering with `religion`
  matches descendants via `tag = ? OR tag LIKE ? || '.%'`.
- Transcript chunking for long-audio Parakeet on Linux is at 180-second
  audio chunks (the 0.6B conformer encoder OOMs on 1-hour files). FluidAudio
  handles long audio internally via cache-aware streaming, so the wrapper
  you write probably won't need to chunk — but verify with a 1-hour test
  file before assuming.
- yt-dlp uses `--js-runtimes node` (the JS runtime YouTube requires for
  AV1/VP9 visibility). On Mac, Node is available, so this just works.
- The pipeline has automatic codec fallback (AV1 → VP9 → H.264) for the
  YouTube path when CDN 5xx errors hit a specific codec mid-download.
  Don't touch that logic; it works.

---

## Files you'll spend time in (Step 2)

- `server/transcribe.ts` — add the FluidAudio routing branch.
- `server/transcribe-fluidaudio.ts` — **new file you'll create**. TypeScript
  binary-spawn wrapper. Look at how `runYtdlp` in `server/pipeline.ts`
  spawns child processes for the pattern.
- `server/transcribe-parakeet.py` — read this to understand the JSON+md
  output contract you need to match.
- `client/src/pages/Pipeline.tsx` — Settings card → "Transcription model"
  dropdown. Add the FluidAudio option.

## Files you'll touch lightly (Step 3)

- `server/db.ts` — `getDb()` path resolution.

## Files NOT to change

- `server/transcribe.py`, `server/transcribe-parakeet.py` — they're
  Linux/CUDA only and need to keep working there.
- `requirements-parakeet.txt` — Linux/CUDA only.
- All the UI work the user did on Map.tsx, VideoDrawer.tsx, Library.tsx,
  Search.tsx, Clips.tsx — feature-complete and tuned. Leave alone.

## Verification path for the whole session

After each substantive change:
1. `npm run check` — 0 errors.
2. `npm run build` — succeeds.
3. `npm run dev` — server boots; do the manual smoke test relevant to
   what you changed.

**Two natural checkpoints to pause and hand back to the user:**

**Checkpoint A — after Steps 1-3 (transcription works)**. The user should
be able to:
- Add a local folder containing a video
- Set the transcription model to `fluid-parakeet-tdt-v3`
- Hit Check, watch the file get transcribed via FluidAudio
- Open the file in the Library, see the transcript, click into segments,
  save clips, tag them, search across the library — same as on Linux.

This is the *minimum* useful Mac state. Hand back here if anything
upstream felt rough or the user wants to verify before more work.

**Checkpoint B — after Steps 1-4 (LLM features in)**. The user should be
able to:
- Run a `Meaning` search on the Search page that finds conceptually
  related transcript segments without exact word overlap
- See a top-bar status indicator showing oMLX is reachable
- Configure a different LLM/embedding model from the Settings page

When you hit Checkpoint B, hand back. **Electron packaging (Step 5) is
explicitly a separate session — do not start it here.**

---

## Working style reminders

- **Use the TaskCreate/TaskUpdate tools** to track multi-step work. Mark
  in_progress when starting, completed when actually done.
- **Plain, direct prose.** No emojis unless the user asks. No
  `🎉 Successfully completed!` celebration messages.
- **Reference files with `path:line`** so the user can navigate to source
  quickly.
- **Don't explain WHAT the code does** in comments — names should make that
  obvious. Only comment WHY (non-obvious constraints, hidden invariants,
  workarounds for specific bugs).
- **Don't write a summary doc unless asked.** This file you're reading is an
  exception because the user explicitly requested handoff instructions.

If anything in this file is unclear, ask the user before guessing.
