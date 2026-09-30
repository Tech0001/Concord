# Concord development handoff

Updated September 30, 2026. Code baseline: `rewrite/rust-tauri` at `8b1e271`.

The working Electron application has been moved onto the tested Nemotron speech
stack and preserved on its own branch. We have now started the Linux-first
Rust/Tauri rebuild, installed beside it as **Concord Next**. Continue from this
working preview, with user-driven UI refinement and simpler installation as the
next focus. This is a first native implementation, not full feature parity or a
public release ready for every machine.

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

- Imports the old library into its own SQLite database, including saved voice
  fingerprints, transcript search rows, document text, notes, and note links.
- Browses collections and recording titles, opens local audio/video, and seeks
  from transcript timestamps. Imports local media through a native file picker.
- Transcribes through the tested NeMo coordinator; shows job activity, permits
  cancellation, merges speaker labels, matches saved voices, and publishes a
  versioned transcript atomically into the new library.
- Searches transcript words with SQLite FTS5. Semantic search is not implemented.
- Names voices, reads documents, imports Markdown/plain text, saves passage notes,
  and connects notes on a simple interactive map.
- Uses the supplied icon and wordmark in the UI and installed launcher.
- Reuses existing video thumbnails in a separate cache, or extracts missing
  thumbnails with FFmpeg. Audio-only recordings keep an audio cover.
- Has a draggable video/transcript divider. The video defaults to 64% where space
  permits; minimum pane widths preserve readability. The split is saved in local
  storage under `player-video-width`. Arrow keys adjust it; double-click or Enter
  restores the default. The old 360-pixel video-height cap was also increased.

Navigation is Library, Search, Speakers, Documents, Notes, Map, and Settings.
The imported snapshot contains **2,020 recordings, 49 saved voices, 595 documents,
5 notes, and 957,728 transcript search rows**. Counts are a snapshot, not constants.

## Architecture and important fixes

| File or directory | Responsibility |
| --- | --- |
| `desktop/src/App.tsx` | Navigation, selection, imports, activity, note dialogs |
| `desktop/src/views.tsx` | Library, player, divider, search, speakers, documents, notes/map, settings |
| `desktop/src/style.css` | Layout and supplied brand palette |
| `desktop/src-tauri/src/lib.rs` | Tauri IPC commands, app state, single-instance behavior, shutdown |
| `desktop/src-tauri/src/db.rs` | SQLite schema, isolated import, search, speaker assignment |
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
bash scripts/install-next-local.sh
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

Latest bundles are under `desktop/src-tauri/target/release/bundle/`: approximately
170.39 MiB AppImage and 58.50 MiB Debian package, excluding model weights and the
Python environment. Only the AppImage has been installed and exercised here.
Build-host compatibility still needs broader testing. Do not edit a packaging
shell script while an invocation of that same script is running.

## Verification completed and remaining

- Frontend TypeScript checks and Vite builds passed, including the divider change.
- Rust suite passed: eight tests, plus one optional real-speech test ignored by
  default. Coverage includes isolated migration/search, speaker IDs above eight,
  short-turn merging, thumbnail reuse, and playback range/access behavior.
- The optional real-speech test was run separately on the ten-minute October 7
  excerpt and passed in 46.55 seconds on this PC. It exercised actual ASR,
  diarization, transcript publication, saved assignments, and search in a temporary
  library. This is not a full-meeting benchmark of the Rust app.
- Clippy passed with warnings denied. No Rust code changed for the final UI divider.
- AppImage and Debian bundles built. The installed AppImage launched and loaded
  the imported library. The formerly failing AV1/Opus video loaded after the
  streaming fix, and native UI state showed playback advancing and pausing.
- The latest installed UI exposes the resize separator with default value 64.
  Full pointer-drag, keyboard, and restart-persistence smoke checks remain useful;
  do not describe those interactions as comprehensively tested.

Reproduction commands:

```sh
pnpm --dir desktop build
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
CONCORD_TEST_AUDIO="$HOME/.local/share/concord-diarization-lab/asr/clips/2025-10-07-1020s-600s.wav" \
  cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  real_speech_job_publishes_only_to_new_library -- --ignored
```

Native UI inspection worked with `orca-ide computer` accessibility commands.
The current provider has no screenshots/window focus support; indexes become
stale when the user interacts or the layout changes. Refresh state before using
them, and avoid fighting the user's live interactions. Outside Orca-managed
terminals, do not run bare `orca`, which is the GNOME screen reader on this PC.

## Remaining work and suggested continuation

The user is actively trying the installed preview. Address their concrete feedback
first and keep delivering updates to **Concord Next**, leaving the parked app
available. Suggested next work, not a separately approved release plan:

1. Finish player/UI polish: verify divider dragging and persistence, audio-only
   playback, transcript seeking, window-size extremes, and long recordings.
2. Port a self-contained speech installer and model management. Today Next needs
   the original app's managed environment. Improve dependency checks and error
   recovery; benchmark the selected multilingual configuration on CPU.
3. Restore channel subscriptions/downloads with simpler setup and a durable queue.
   Current jobs run one at a time; interrupted jobs are marked on startup and are
   not automatically resumed.
4. Design one understandable search experience, then add semantic indexing and
   separately configured embedding/chat providers. Chat, OpenRouter, and account
   login are not implemented in Next.
5. Improve research tools. Documents currently expose cached searchable text and
   plain-text/Markdown imports, not full original formatting or rich editing.
   Notes retain primary passages and links; complete anchors/tags are not ported.
   The map is a simple interactive note/link view, not the final design.
6. Prepare public installation: fresh-machine setup, packaging on supported Linux
   bases, CI, dependency/license review, and clearer contributor documentation.
   Root package scripts and legacy source still contain the old application.
7. Add macOS, then Windows builds and actual device validation. Native inference
   portability does not yet establish application or packaging support.

Keep model improvements separate from speaker-count claims, and evaluate future
model changes through the working end-to-end pipeline. The current choice is the
multilingual Nemotron model the user preferred; do not restart the comparison or
replace clustering without a concrete reason.
