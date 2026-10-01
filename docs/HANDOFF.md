# Concord development handoff

Updated September 30, 2026. Code baseline: `rewrite/rust-tauri`, **Concord Next 0.2.0**
(Delivery 1: foundation, polish pass, and player ranges).

The working Electron application has been moved onto the tested Nemotron speech
stack and preserved on its own branch. The Linux-first Rust/Tauri rebuild is
installed beside it as **Concord Next**. Delivery 1 rebuilt the interface on a
themeable, phone-ready design system and restored the player's range tools
(select, loop, copy, export, save as note). It is still a preview, not full parity
with the Electron app; see the delivery plan below.

## Status at handoff back to Codex (September 30, 2026, evening)

Claude built Delivery 1 and handed development back. Start here.

**Shipped and installed:** Concord Next **0.2.0** at `~/.local/opt/concord-next/`. The real
library migrated to `user_version` 2. Everything committed on `rewrite/rust-tauri`.

**Committed after 0.2.0, not packaged yet:**
- `2e33c7b`: a sidebar toggle beside the logo; the labelled sidebar opens as an overlay
  drawer on windows narrower than 1200px. Requested by the user.
- `49a149f`: the brief for parallel Delivery 6 work,
  `docs/superpowers/briefs/2026-09-30-codex-delivery-6.md`. Now that Codex owns everything,
  ignore its worktree and coordination rules; its scope and legacy notes still apply.
- `docs/superpowers/specs/2026-09-30-speakers-design.md`: a **draft** Delivery 2 spec.
  The user has not approved it.

**Open bug, reported by the user and not investigated:** "the playback is wonky" in
the installed 0.2.0 WebKitGTK window. Playback of the new player was never verified in the
real window, only in headless Chromium.

Unconfirmed hypotheses, to check with evidence before fixing:
1. `player/useMedia.ts` pushes `currentTime` into the time store on every
   `requestAnimationFrame`. `Timeline`'s `Playhead` then re-renders about 20 times a second
   and moves via `left: %`, which forces layout and paint. That is expensive with
   `WEBKIT_DISABLE_DMABUF_RENDERER=1` (software compositing on NVIDIA/Wayland, see
   `main.rs`), and could starve GStreamer. The 0.1 player used native controls with
   `timeupdate` (about 4 Hz).
2. `player/Transcript.tsx` follow-along calls `scrollIntoView({ behavior: "smooth" })` on
   every line change, with `content-visibility: auto` rows.
3. `seek(t, true)` sets `currentTime` and calls `play()` immediately; WebKitGTK may stutter
   if play is called mid-seek.

Ask the user what "wonky" means (stutter, jumps, lag on seek, desync) and watch CPU for
`WebKitWebProcess` while playing.

**Also never verified in the real window:** export through the native save dialog, "Show
in folder" (D-Bus FileManager1 with an xdg-open fallback, `system.rs`), and Copy
(`lib/clipboard.ts`, with an `execCommand` fallback).

**The final whole-branch code review** of 0.2.0 was started but its findings were not
processed. The commit range is `f147a9b..b77bf90`.

**Useful tooling:**
- Mock host: `pnpm --dir desktop dev`, then open `http://127.0.0.1:1420/?mock`. Add
  `&theme=lifeOS`, `&mode=light`, or `&gallery`.
- Screenshot runner: `node desktop/scripts/screens.mjs <outdir> [filter]`, with env `SIZES`,
  `MODES`, `EXTRA` (JSON shots with `after`/`probe` scripts), `BASE`, and `CDP_PORT`.
  `PlayerPage` exposes `window.__concordTest` in dev for scripted range/find/export.
- Real-window review builds: `pnpm --dir desktop tauri build --no-bundle --config
  '{"identifier":"app.concord.next.review"}'`, run with `CONCORD_NEXT_DATA` pointing at a
  `sqlite3 .backup` copy of the library.

## What the user wants

Concord is a local spoken-word research archive: recordings, transcripts, speaker
identities, documents, notes, and connections between them. The rebuild should
make it easier to use, install, maintain, and present as an open-source project.

- Use Rust and Tauri. Platform order is **Linux, then macOS, then Windows**.
- Keep the improved multilingual transcription and the existing method of linking
  speakers across overlapping windows. Aim for 16-person recording capacity.
- Support CPU operation for lower-spec PCs and eventually Macs; an NVIDIA GPU
  should not be a prerequisite for native ASR and diarization.
- Remove the **Watchers** section. This does not mean removing ordinary channel
  subscriptions, imports, or background transcription.
- Make search coherent. The previous split between exact search, semantic search,
  and AI chat was confusing.
- Keep Documents and Speakers. Notes need refinement, but are used less often.
- Keep and improve the Map: the user sees it as a potential differentiator.
- Simplify channel setup and AI configuration, which had accumulated in Pipeline.
- Keep **embedding providers/models separate from chat providers/models**.
  The user wants local AI and OpenRouter options, and asked about an optional
  Codex/ChatGPT account login. That login integration is not implemented or
  validated in this preview; investigate the supported authentication path first.
- The user questioned Compare's purpose. It is absent from the new navigation;
  do not port it automatically without a useful workflow.
- Use the supplied icon assets, not the previous placeholder branding.

The user prefers concrete implementation and installed builds to try. Preserve
the working lane while developing the next one. They specifically asked that model
experiments first run with a separate database and the same proven Concord
grouping pipeline, rather than replacing several parts of the algorithm at once.

## Delivery plan (agreed September 30, 2026)

The Electron app is the reference: the user liked it and wants the same
capabilities rebuilt in Tauri and **more polished**, not reinvented. Each area
reaches Electron parity, then gets polished. Order:

1. **Foundation, polish pass, and player ranges** — done in 0.2.0. Spec:
   `docs/superpowers/specs/2026-09-30-next-foundation-polish-design.md`; plan:
   `docs/superpowers/plans/2026-09-30-next-foundation-polish.md`.
2. **Speakers** — rebuild to the Electron page: edit, recolor, merge, noise,
   rescan/find matches, unidentified queue, the full label dialog. Appearances
   ("where they spoke") and speaker notes already shipped in 0.2.0. Needs
   `speakers.is_noise` and `sample_count`.
3. **Notes** — multi-anchor notes (ranges and document passages), tags, typed links,
   a real Notes page, range notes from the player.
4. **Search and AI** — one search experience (words, meaning, chat); embedding and
   chat providers and models configured separately (local, OpenRouter, …).
5. **Map** — Electron parity, then better (explicit user control, persisted layouts).
6. **Channels and pipeline** — subscriptions, downloads, a durable batch
   re-transcription queue. No Watchers.

Decisions from the user: range selection is line-level, not word-level. Every
screen must work on a phone (the UI is ready; serving it to a phone is a later
decision). Legacy data top-up/sync is deferred, because the whole archive will be
re-transcribed on the new engine; add schema fields fresh as features need them.
The user prefers building over long planning and few questions.

## Branches and completed stages

| Branch | Code checkpoint | Purpose |
| --- | --- | --- |
| `main` | `dcf1fe5`, tag `v2.4.4` | Original baseline before these experiments |
| `experiment/nemotron-diarization` | `26a73df` | Isolated diarization and ASR comparisons |
| `feature/nemo-native` | `856337f` | Working existing UI with native multilingual Nemotron ASR and diarization; parked for continued use |
| `rewrite/rust-tauri` | `c65bcce`, then `8b1e271` | Native desktop foundation, followed by resizable video/transcript panes |

These are local checkpoints. This work has not been pushed or published.
The installed original Concord remains available; do not overwrite it when
installing Next. Legacy source remains in the rewrite branch for migration and
because the speech coordinator is still reused.

The early isolated tests initially tried alternative speaker grouping. Those
results are historical, not the final replacement strategy. At the user's
direction, we reran Nemotron through Concord's existing diarization pipeline.
Then we compared actual transcription models and selected Nemotron 3.5
multilingual after the user reviewed the difficult October 7 passage and found
it substantially better than Parakeet.

Some experiment reports end with cautious recommendations made **before** that
review and integration. Preserve their measurements, but use the later branch
decision as the current product direction.

## Speech stack and evidence

| Responsibility | Current implementation |
| --- | --- |
| Words and timestamps | `nvidia/nemotron-3.5-asr-streaming-0.6b`, Q8 GGUF |
| Local speaker turns | `nvidia/Nemotron-3-Diarization`, Q8 GGUF |
| Native inference | NeMo-Speech.cpp, Vulkan or CPU |
| Voice fingerprints and cross-window grouping | Existing Python/NeMo TitaNet pipeline |
| Jobs, transcript merging, saved-profile matching, persistence in Next | Rust |

NeMo-Speech.cpp is a runtime; Nemotron ASR and Nemotron Diarization are separate
models. Diarization alone does not replace Parakeet's transcription function.
**Python/PyTorch has not been removed from voice matching.** On this PC the
embedding worker uses CUDA when available, or CPU when selected.

The pinned runtime revision is
`4c101bc7113f49101a3e11d2c994c519f41939f6`. Model checksums are pinned in
`server/nemo-runtime.ts` and `desktop/src-tauri/src/speech.rs`. The coordinator
uses 180-second outer ASR chunks and the tested 1,120 ms streaming context;
diarization uses 120-second windows, 10-second overlap, and the existing 0.65
grouping threshold. Do not silently change these while comparing implementations.

Nemotron has eight local speaker slots per window. Concord's overlapping windows
and voice matching link more than eight global identities across a recording;
this is not two fixed groups of eight. The October 22 recording produced 11 groups
for 11 reported participants. October 7 produced 12 groups for 10 reported
participants, retaining the known voices but leaving extra/split groups to review.
This demonstrates operation beyond eight; a real 16-person accuracy validation
has not been performed. Do not impose an eight-person library limit or describe
16-person recognition as proven.

The user selected minutes **17–27 of October 7** to inspect English missed around
glossolalia. Their listening comparison drove the multilingual model choice.
Do not treat additional phonetic words during glossolalia as verified speech.

On the development i7-13700K / RTX 2080 Ti, the existing-interface integration
processed the full approximately 135- and 179-minute meetings in about 217 and
276 seconds, including diarization and merging. These are local measurements,
not cross-platform promises. Selected native multilingual ASR excerpts used about
930 MiB sampled worker VRAM; native diarization used about 173 MiB. These figures
exclude other stages and are **not total application VRAM requirements**.
Matched-context multilingual CPU performance, low-end PCs, macOS, and Windows
still need validation.

Detailed evidence:

- [Diarization results](../experiments/diarization/RESULTS.md)
- [Native Parakeet runtime comparison](../experiments/diarization/ASR_RESULTS.md)
- [Nemotron ASR comparison](../experiments/diarization/NEMOTRON_ASR_RESULTS.md)
- [Existing-interface NeMo integration](nemo-native.md)

## What Concord Next currently does

- **Design system.** Tokens use tweakcn/shadcn names. The Concord brand theme comes
  in dark (default) and light, plus the 12 tweakcn themes from the Electron app
  (Settings → Appearance). Fonts are vendored: Inter, Source Serif 4 (titles,
  transcripts, documents; a Serif/Sans switch is in Settings), and JetBrains Mono.
- **Shell.** A grouped sidebar collapses to an icon rail under 1200px; phones get a
  bottom tab bar. There is a Ctrl+K command palette (recordings, speakers, notes,
  documents, actions), toasts with actions, an Activity panel, and hash routes
  (`#/recording/<id>?t=…`, `#/search?q=…`, …).
- **Library.** Grid and list views, filters (collection, type, transcript, review,
  starred), six sorts, page sizes of 60/120/240, stars, review state, resume
  progress, colored speaker chips, and a ⋮ menu (open, resume, (re)transcribe,
  review, star, show in folder, copy path). Settings persist.
- **Player.**
  - Custom transport with speed and volume, and a timeline with a waveform (audio),
    speaker lanes, saved-note markers, and a playhead.
  - Resume, previous/next, speaker panel with naming, and keyboard control (`?`
    lists shortcuts).
  - Transcript follow-along with "Back to playback", and find with highlighted
    matches.
  - **Ranges:** shift-click, select text across lines, or press I/O, then drag the
    timeline handles to fine-tune. Loop, copy, save as note, and export as M4A,
    MP3, MP4 (accurate or fast), TXT, Markdown, or SRT via the save dialog, with
    "Show in folder".
- **Search.** Word search grouped by recording, with highlighted matches and
  speaker names. Semantic search and AI are not implemented yet.
- **Speakers** lists voices by speaking time. A row expands to show the speaker's
  notes (saved on blur) and every recording they appear in; play opens the
  recording at their longest turn. Edit, rescan, merge, noise, and the unidentified
  queue remain for Delivery 2.
- **Documents** render Markdown. Notes and Map are restyled; their rebuilds are
  Deliveries 3 and 5.
- Imports the old library into its own SQLite database, transcribes through the
  tested NeMo coordinator, and streams media over loopback, all unchanged from 0.1.

Schema version 2 adds `media.starred`, `review_state`, `position`, and `opened_at`
(an idempotent migration, safe with the 0.1 app still running).
The imported snapshot contains **2,020 recordings, 49 saved voices, 595 documents,
5 notes, and 957,728 transcript search rows**. Counts are a snapshot, not constants.

## Architecture and important fixes

| File or directory | Responsibility |
| --- | --- |
| `desktop/src/App.tsx` | Shell, routing, app context, job polling |
| `desktop/src/lib/` | Typed IPC seam (`ipc.ts`), formatting, routing, ranges, time store, shortcuts, search helpers (tested with `node --test`) |
| `desktop/src/theme/`, `desktop/src/fonts/` | Brand theme, tokens, tweakcn theme scoping, vendored fonts |
| `desktop/src/ui/` | Primitives on Radix: buttons, menus, dialogs/sheets, selects, toasts |
| `desktop/src/shell/`, `library/`, `player/`, `search/`, `documents/`, `notes/`, `speakers/`, `map/`, `settings/` | Feature folders with co-located CSS |
| `desktop/src/dev/`, `desktop/scripts/screens.mjs` | Dev-only mock host (`?mock`) and headless screenshot runner |
| `desktop/src-tauri/src/lib.rs` | Tauri IPC commands, app state, single-instance behavior, shutdown |
| `desktop/src-tauri/src/db.rs` | SQLite schema and migration, import, library filters, palette, search, speaker assignment |
| `desktop/src-tauri/src/export.rs` | Range excerpts, TXT/MD/SRT rendering, ffmpeg media export with progress and cancel |
| `desktop/src-tauri/src/waveform.rs`, `system.rs` | Cached audio peaks; show in folder (D-Bus FileManager1, xdg-open fallback) |
| `desktop/src-tauri/src/speech.rs` | Runtime discovery, model verification, jobs, process groups, publication |
| `desktop/src-tauri/src/transcript.rs` | Word/turn merging, short-turn cleanup, cosine matching |
| `desktop/src-tauri/src/playback.rs` | Loopback media streaming and byte-range handling |
| `desktop/src-tauri/src/thumbnail.rs` | Thumbnail cache reuse and frame extraction |
| `desktop/src-tauri/src/main.rs` | Linux NVIDIA/Wayland rendering workaround |
| `server/transcription-engines/transcribe-nemo.py` | Reused speech coordinator; imports existing helpers including `diarize-sortformer.py` |
| `assets/brand/` | User-supplied `concord-icon.svg`, mono icon, and wordmark |

There is no Electron runtime or Node application server in Next. Application
commands use Tauri IPC. **Media playback is an intentional exception:** Rust binds
to `127.0.0.1` on an ephemeral port and streams only the most recently registered
recording using unguessable session URLs. It supports GET/HEAD and bounded byte
ranges; it does not serve directories or an application HTTP API. There is no
fixed browser UI port for the installed app. Vite development uses port 1420.

Three Linux playback/rendering problems were found and addressed:

1. NVIDIA/Wayland caused WebKitGTK `Gdk Error 71`. `main.rs` sets
   `WEBKIT_DISABLE_DMABUF_RENDERER=1` only when Wayland and the NVIDIA driver are
   detected, preserving an explicitly supplied value. This is app-local and does
   not disable speech GPU acceleration.
2. The host lacked some playback codecs. The AppImage now bundles GStreamer media
   plugins, including AV1 and libav support. FFmpeg alone does not supply the
   webview's GStreamer decoders.
3. WebKitGTK rejected Tauri's `asset:` URLs for media. Adding codecs alone did not
   fix this. The loopback streaming path fixed playback; scoped asset URLs remain
   suitable for thumbnails. Do not revert media to `convertFileSrc()` without
   validating Linux playback.

## Installed apps and local data

Paths below describe this development PC. XDG locations and environment overrides
are supported; do not hardcode this home directory into application code.

| Item | Location |
| --- | --- |
| Repository | `/home/pc/Documents/GitHub/Concord` |
| Original installed app | `~/.local/opt/concord/Concord.AppImage` |
| Original database | `~/.local/share/concord/pipeline.db` |
| Native preview | `~/.local/opt/concord-next/Concord-Next.AppImage` |
| Preview launcher | `~/.local/share/applications/concord-next.desktop` |
| Preview database | `~/.local/share/concord-next/library.db` |
| Preview transcripts, thumbnails, logs | `~/.local/share/concord-next/` |
| Reused speech models | `~/.local/share/concord/models/nemo/` |
| Reused voice environment | `~/.local/share/concord/venv/bin/python` |
| Cached C++ runtime source/build | `~/.cache/concord-diarization-lab/NeMo-Speech.cpp/` |
| Private experiment outputs | `~/.local/share/concord-diarization-lab/` |
| Original Claude conversation reference | `~/.claude/projects/-home-pc-Documents-GitHub-Concord/` |

The preview identifier is `app.concord.next`. It reads media in place, including
external drives, so those drives must remain connected. Imported transcripts are
initially read from their original paths. Re-transcription writes a new version
under Next's data root and updates only Next's database. A failed or cancelled job
preserves the previous transcript. Import requires an empty destination library;
do not delete the working preview database just to rerun import.

Use `CONCORD_NEXT_DATA` for isolated test profiles. Runtime overrides are
`CONCORD_NEMO_BIN`, `CONCORD_NEMO_MODELS`, and `CONCORD_SPEAKER_PYTHON`.

Private test inputs supplied by the user are `/home/pc/Videos/2025-10-07.ogg` and
`/home/pc/Videos/2025-10-22.ogg`. The ten-minute integration excerpt is
`~/.local/share/concord-diarization-lab/asr/clips/2025-10-07-1020s-600s.wav`.
Do not commit recordings, transcripts, databases, model weights, or credentials.
An unrelated untracked `.aws` entry is present in the checkout: leave it untouched
and excluded from commits.

## Build and install

Run from the repository root. Standard prerequisites are in [README](../README.md).
The native preview currently reuses speech setup from the original NeMo app.

```sh
pnpm install --frozen-lockfile
bash scripts/stage-nemo-runtime.sh
pnpm --dir desktop desktop
```

For the installed build on this PC:

```sh
PATH="$HOME/.cache/concord-build-tools:$PATH" pnpm --dir desktop package
bash scripts/install-next-local.sh   # installs the newest bundle in target/release/bundle/appimage
"$HOME/.local/opt/concord-next/Concord-Next.AppImage"
```

The PATH prefix supplies the locally staged `patchelf`; it is not a general
requirement on machines where patchelf is already installed. Two additional
distro-matched GStreamer plugins were extracted from signature-verified Arch
packages into ignored `build/binaries/gstreamer/`. The packaging script discovers
that directory, or accepts `CONCORD_GST_PLUGINS`. Do not reuse these binaries on
an unrelated distro or GStreamer release. System packages were not changed.

`scripts/package-next-linux.sh` validates codecs and stages GStreamer plugins and
helpers for the AppImage. It handles Arch's scanner path. The local installer
atomically replaces only the Next AppImage and installs the supplied icon and a
separate launcher. Close/reopen Next to use a new build; check for an active job
or unsaved work before restarting it.

Latest bundles (0.2.0) are under `desktop/src-tauri/target/release/bundle/`: approximately
171.81 MiB AppImage and 59.94 MiB Debian package, excluding model weights and the
Python environment. Only the AppImage has been installed and exercised here.
Build-host compatibility still needs broader testing. Do not edit a packaging
shell script while an invocation of that same script is running.

## Verification completed and remaining

Delivery 1 (0.2.0), verified on this PC:

- **Tests.** 31 TypeScript unit tests (`pnpm --dir desktop test:ts`: formatting,
  routes, ranges, time store, shortcuts, search, themes, voices) and 30 Rust tests
  plus 1 ignored real-speech test. The Rust tests cover:
  - migration v2 on a v1 database;
  - library filters and sorts;
  - star, review, and position;
  - palette, search highlighting, speaker order, appearances, and notes;
  - TXT/MD/SRT rendering;
  - real ffmpeg exports of M4A, MP3, and MP4 (accurate and fast), checked with ffprobe
    (±0.2 s), plus cancellation and the missing-media error;
  - waveform peaks and cache.
- **Lint and build.** Clippy passes with warnings denied, and the tsc/Vite build
  passes.
- **Visual review.** The screenshot matrix (12 pages × desktop/960/tablet/phone ×
  dark/light) and three tweakcn themes were reviewed in headless Chromium with the
  mock host.
- **Interaction probes** over CDP:
  - resume at `?t=`, Space/arrow shortcuts, Space ignored in fields, follow-pill;
  - click-to-seek, shift-click ranges, text selection mapped to lines, I/O, play
    range stopping at its end, loop;
  - export flow and toast, Save note prefill.
- **Real WebKitGTK window** (review build, copy of the real library):
  - the migration ran (schema version 2);
  - Library loaded 2,020 recordings;
  - starring persisted through IPC;
  - Speakers listed 49 voices by airtime.

Not yet verified in the real window: media playback of the new player, the native
save dialog and a real export from the UI, "Show in folder" (D-Bus FileManager1),
clipboard copy in WebKitGTK, and phone-width behavior on an actual phone.

Reproduction commands:

```sh
pnpm --dir desktop test:ts
pnpm --dir desktop build
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm --dir desktop dev   # then open http://127.0.0.1:1420/?mock for the mock host
node desktop/scripts/screens.mjs <outdir> [name-filter]
```

Native UI inspection works with `orca-ide computer` accessibility commands. The
Linux provider has no screenshots and indexes go stale after re-renders, so refresh
state before every click. `grim` captures only the visible workspace, so never grab
a window on a hidden workspace. Outside Orca-managed terminals, do not run bare
`orca`, which is the GNOME screen reader on this PC.

## Remaining work and suggested continuation

Follow the delivery plan above: **Speakers** next (Delivery 2), then Notes, Search
and AI, Map, and Channels/pipeline. Keep delivering installed builds of Concord Next
and leave the parked Electron app available. Each delivery gets a short spec and a
plan under `docs/superpowers/`, with TDD, the mock screenshot matrix, and a
real-window check.

Carry-overs from Delivery 1:
- Verify the real-window items listed above: playback, the save dialog, reveal, and
  the clipboard.
- **Speech setup.** Port a self-contained speech installer and model management;
  today Next needs the original app's managed environment. Benchmark the
  multilingual configuration on CPU.
- **Batch re-transcription** of the whole archive (planned with Delivery 6). Jobs run
  one at a time and are not resumed after restart. Preserve manual speaker labels
  across re-transcription by matching old labelled voices to new ones by time
  overlap.
- **Public release preparation:** fresh-machine setup, packaging on supported Linux
  bases, CI, dependency and license review. The root package scripts and legacy
  source still contain the old application.
- **macOS, then Windows** builds and on-device validation.

Keep model improvements separate from speaker-count claims, and evaluate future
model changes through the working end-to-end pipeline. The current choice is the
multilingual Nemotron model the user preferred; do not restart the comparison or
replace clustering without a concrete reason.
