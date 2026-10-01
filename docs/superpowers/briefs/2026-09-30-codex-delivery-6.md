# Brief for Codex: Delivery 6 (channels, downloads, batch re-transcription)

Written by Claude on September 30, 2026. You are working **in parallel** with Claude on
Concord Next. Claude is building Delivery 2 (Speakers), then Notes and the Map. You own
Delivery 6. Read this whole brief before touching anything.

## 1. Read first

- `docs/HANDOFF.md`: product context, decisions, the six-delivery plan, local paths, and
  speech stack facts. The section "Delivery plan" is authoritative.
- `docs/superpowers/specs/2026-09-30-next-foundation-polish-design.md`: the design
  direction, theme/tokens, responsive and touch rules, and IPC seam that every new screen
  must follow.
- `docs/superpowers/plans/2026-09-30-next-foundation-polish.md`, section "Global
  Constraints": they apply to you too.

## 2. Set up an isolated workspace (do not work in the main checkout)

Claude works in `/home/pc/Documents/GitHub/Concord` on `rewrite/rust-tauri`. Two agents in one
checkout will overwrite each other, so do this:

```sh
cd /home/pc/Documents/GitHub/Concord
git worktree add ../Concord-delivery6 -b delivery/6-channels-pipeline rewrite/rust-tauri
cd ../Concord-delivery6
ln -s ../Concord/node_modules node_modules   # root node_modules is hoisted; do NOT run pnpm install
```

- **Never run `pnpm install`/`pnpm add`.** The user has an npm supply-chain cooldown rule,
  and installs can reset Electron's setuid sandbox. If you need a new npm package or Rust
  crate, ask the user first.
- **Dev server.** Use a different port from Claude's (1420): `pnpm --dir desktop exec vite
  --host 127.0.0.1 --port 1421 --strictPort`. Screenshots:
  `BASE=http://127.0.0.1:1421/ CDP_PORT=9334 node desktop/scripts/screens.mjs <outdir> [filter]`.
- **Data.** Never use the user's real library for tests. Copy it:
  `sqlite3 ~/.local/share/concord-next/library.db ".backup '<scratch>/library.db'"`, then run
  with `CONCORD_NEXT_DATA=<scratch dir>`.
- **Real-window test builds.** Build with a separate identifier so the single-instance plugin
  doesn't hand off to the user's running app:
  `pnpm --dir desktop tauri build --no-bundle --config '{"identifier":"app.concord.next.d6"}'`.
- **Do not install or overwrite** `~/.local/opt/concord-next/` or the original Concord. The
  user, or Claude after merging, does installs.
- Never stage `.aws`. Never commit recordings, databases, transcripts, model weights, or
  credentials.

## 3. Scope: Electron parity, simplified, then polished

The user liked the Electron app. Rebuild its pipeline in Tauri, simpler to set up. Reference
code from the legacy app:

- `server/pipeline.ts` (scan, queue, `processVideo`), `server/channel-monitor.ts`
  (yt-dlp listing, Shorts detection), `server/routes-pipeline.ts`, and `server/db-queue.ts`.
- `client/src/pages/Pipeline.tsx`, `PipelineHub.tsx`, `components/PipelineControls.tsx`, and
  the `PipelineSettingsCard` in `pages/Settings.tsx`.

Must have:

1. **Channels and folders.**
   - Add a YouTube channel URL or a local folder.
   - Per source: enable, identify speakers (diarize), include Shorts, rename, remove.
   - "Full scan" (whole history) and "Check now".
   - A scheduled check interval that applies immediately when changed. The legacy app only
     read it on Start.
2. **Downloads.**
   - yt-dlp runs as a system binary; detect it, show its version and health, and offer an
     update.
   - Settings: quality and codec, audio language, cookies from a browser or file, speed
     preset, and daily cap.
   - The download directory comes from settings. Existing files on disk are matched, not
     re-downloaded.
3. **A durable job queue.** Download, then audio extraction, then transcription, with these
   statuses: `pending → downloading → transcribing → complete | failed`, plus `waiting_live`.
   - It survives restart, resuming or re-queueing interrupted work.
   - Retry with a delay, which the legacy app saved but never used.
   - Cancel and pause.
   - It runs one job at a time.
   - It must resume by itself after the daily cap resets; the legacy app needed a manual
     Start.
4. **Batch re-transcription.**
   - Queue a selection, a collection, or everything, with the device choice (auto / CPU /
     Vulkan).
   - The user will re-transcribe the **whole archive** (about 2,000 recordings) on the
     Nemotron engine. This is the most urgent piece.
   - **Preserve manual speaker labels across re-transcription.** For each old assignment with
     a `speaker_id`, find the new local voice that overlaps the old voice's turns most (by
     time), and carry the label over. Only fill voices the automatic matcher left unnamed.
   - Keep the previous transcript if a job fails. This is the existing behavior; keep it.
5. **Activity and status.**
   - Queue view with progress, the current step, failures with retry, and counts.
   - Extend the existing Activity panel (`desktop/src/shell/ActivityPanel.tsx`) and the
     sidebar activity item.
   - A dedicated Channels page is fine.

Do **not** port: Watchers or Discover, which the user removed; the voice recorder; Terminal;
the QMD vault copy; or LAN access. Ask the user before adding anything outside this list.

Legacy defects to fix rather than copy:
- Shorts could be queued but never processed.
- The daily cap never resumed by itself.
- The retry delay was never used.
- The check interval was read only at Start.
- `start()` replaced the timer without clearing the old one.

Open questions to ask the user early, not to guess:
- Keep the Personal/Work category toggle?
- Where should the channels UI live: its own page or a Settings section?
- Defaults for the download and transcript folders?

## 4. How to build it

- **Process.** Write a short spec at `docs/superpowers/specs/2026-10-xx-delivery-6-*.md`, get
  the user's approval, then write a plan with tasks. Use TDD: write the test, watch it fail,
  implement, and watch it pass.
- **Rust.** Put pipeline logic in new modules (`desktop/src-tauri/src/pipeline.rs`,
  `queue.rs`, `ytdlp.rs`, …). Run yt-dlp and ffmpeg as child processes in their own process
  groups, the way `speech.rs` does, so cancel kills the whole tree.
- **Schema.** Do not bump `PRAGMA user_version`; Claude's Speakers work also changes the
  schema. Instead, add your tables with `CREATE TABLE IF NOT EXISTS` inside one function,
  e.g. `pipeline::ensure_schema(&Connection)`, called from `db::open()` with a single
  added line. Add columns with a presence check, like `migrate()` does. Keep it idempotent.
- **Frontend.**
  - New screens go in a feature folder (`desktop/src/pipeline/`) and use only `ui/`
    primitives and theme tokens: no literal colors, phone-ready, at least 44px touch
    targets, no hover-only controls.
  - All host calls go through `desktop/src/lib/ipc.ts`; never import `@tauri-apps/*` in
    components.
  - Add mock handlers to `desktop/src/dev/mock-ipc.ts` so screens render with `?mock`, and
    review screenshots at desktop, 960, tablet, and phone in dark and light.
- **Shared files.** Keep edits in these files small and append-only, because Claude edits
  them too:
  - `src-tauri/src/lib.rs`: new commands and handler-list entries.
  - `src-tauri/src/db.rs`: one call to your schema function.
  - `desktop/src/lib/ipc.ts`, `lib/types.ts`, `lib/router.ts`, `shell/nav.ts`, `App.tsx`, and
    `dev/mock-ipc.ts`.
  Don't restyle or refactor anything outside your feature.
- **Claude's files.** Don't edit: `desktop/src/speakers/`, `notes/`, `map/`, `player/`,
  `library/`, `ui/`, `theme/`, `speech.rs` assignment matching other than the label
  carry-over above, or Claude's speaker functions in `db.rs`.
- **Verification before saying "done".** Run:
  - `pnpm --dir desktop test:ts`
  - `pnpm --dir desktop build`
  - `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
  - `cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
  Then do a real-window check with the separate identifier and a data copy.
- **Commits.** Descriptive sentences in the repo's style, on your branch only. Don't push or
  merge. When you're done, tell the user; Claude or the user merges into
  `rewrite/rust-tauri`.

## 5. Coordination

- **Claude's next work:** Speakers. It touches `speakers/`, `player/NameVoiceDialog.tsx`,
  and speaker and assignment functions in `db.rs`, and adds `speakers.is_noise` and
  `speakers.sample_count` columns.
- **If you need a change in a Claude-owned area,** write it in your branch's
  `docs/superpowers/briefs/` notes for the user to relay, rather than editing those files.
- **Update `docs/HANDOFF.md`** with your delivery's status in its own section when you finish.
