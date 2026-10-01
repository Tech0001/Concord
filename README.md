# Concord Next

A local research archive for spoken-word media. Listen, transcribe, find passages,
recognize familiar voices, and connect what you learn.

This branch is the **Linux-first Rust/Tauri preview**. The working Electron/Nemotron
build is preserved on `feature/nemo-native`. Concord Next has its own database and
transcript folder and can run alongside it. Full Electron parity is still in progress.

## Available in the preview

- Library with saved views, Personal/Work categories and processing filters.
  Rename, relink or move media to Trash while retaining transcripts and research.
- Player with transcript seeking, speaker colors, resizable panes, range notes,
  looping, copy, media/transcript export, native pop-out video, and optional transcript-gap skipping.
- Nemotron 3.5 multilingual transcription and Nemotron diarization, on GPU or CPU.
  Voice fingerprints link speakers across overlapping windows and recordings.
- Speaker profiles, multiple fingerprints per person, naming/merging/noise review,
  matching, and an unidentified-voices queue.
- Word/phrase search with grouped, highlighted passages, plus a separate AI page for local semantic search and optional chat.
  Embedding and chat providers have independent models and credentials. Recording summaries
  have background progress and cancellation, preserving the previous summary until success.
- Research notes with multiple passages, tags, typed connections, and four map layouts.
- Markdown document folders, live sync, local images/links, categories, and research anchors.
- YouTube subscriptions and local source folders, download setup, persistent processing
  queues, delayed retries, and batch re-transcription that preserves existing transcripts.
- Tools for standalone M4A/MP3 extraction, recoverable Linux voice recording with optional local transcript preview, and
  manual YouTube discovery with phrase filters and direct queueing.
- Status, archive audits and repairs, backups/restore, activity history, and runtime logs.

## Install and prepare speech

Linux packages are built locally during this preview; there is no public release yet.
The `.deb` declares its system dependencies. The AppImage bundles playback codecs and
helper runtimes, but **FFmpeg must be installed using your Linux package manager**.

1. Install the package, or make the AppImage executable and launch it.
2. In **Settings → Speech**, choose **Prepare speech**. Concord installs private Python,
   voice-matching dependencies, and checksum-verified models inside its data folder.
   Allow several GB of free space. Setup has progress, logs, cancellation, and retry.
3. Leave processing on **Automatic** to use an available GPU, or select **CPU**.
4. Add local recordings, import an existing Concord library, or add sources in **Pipeline**.

Speech setup does not require Electron, an NVIDIA GPU, or changes to system Python.
ASR and diarization use NeMo-Speech.cpp; the portable TitaNet voice matcher runs on CPU.
Existing Electron speech installations remain usable until a private environment is prepared.
New environments are activated only after extracting and checking a real voice fingerprint.
A cancelled or failed repair keeps the previous working environment.

Semantic search uses a separate app-managed local Qwen3 embedding model, prepared from the
AI page or Settings. Chat remains disabled until a provider is configured. Local/OpenRouter/
custom embedding and chat services are supported independently. If you choose a remote
provider, relevant text is sent to that provider. Speech processing stays local. Discover
uses a separate YouTube Data API key in Settings and sends search queries to Google. It
never starts recurring searches or adds subscriptions automatically.

See [speech setup details](desktop/speech/README.md) for pinned models and dependencies.

## Develop and package on Linux

Install Rust, Node.js 24+, pnpm 10, FFmpeg, CMake/Ninja, Vulkan development tools,
GStreamer base/good/bad/libav plugins, patchelf, and the
[Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

```sh
pnpm install --frozen-lockfile
bash scripts/stage-nemo-runtime.sh
bash scripts/stage-next-setup.sh
bash scripts/stage-next-downloads.sh
bash scripts/build-embedding-runtime.sh
pnpm --dir desktop desktop
```

```sh
pnpm --dir desktop build
pnpm --dir desktop test:ts
pnpm --dir desktop test
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm --dir desktop package
bash scripts/install-next-local.sh
```

Packaging includes NeMo-Speech.cpp, the local embedding runtime, private yt-dlp/Node/uv
helpers, and GStreamer playback codecs. There is no Electron runtime or Node application
server. Node is used only by the bundled YouTube downloader. Downloaded build tools are
pinned and SHA-256 verified. Model weights are downloaded during setup and are not in Git.
Packaging checks AAC, H.264, AV1, Opus and Vorbis playback support. Additional distro-matched
plugins can be supplied through `CONCORD_GST_PLUGINS`.

On NVIDIA/Wayland, the app applies the
[WebKitGTK rendering workaround](https://v2.tauri.app/develop/debug/linux-graphics/)
for the reproduced `Gdk Error 71` failure. It does not change desktop settings or speech GPU
acceleration. An explicit `WEBKIT_DISABLE_DMABUF_RENDERER` takes precedence.

## Data and architecture

Linux data lives in `~/.local/share/concord-next/` (respecting `XDG_DATA_HOME`).
`CONCORD_NEXT_DATA` selects an isolated test library. Imported media stays in its original
location; new transcripts are versioned under the app folder. External drives must remain
connected. Import does not copy watchers, old queued jobs, or AI credentials.

Rust owns SQLite, jobs, child processes, transcript/speaker merging and search. React uses
Tauri IPC. A private loopback media server exposes only the opened recording through an
unguessable session URL, supporting WebKitGTK seeking without a public listening port.
Local semantic search uses a private app-managed llama.cpp service.

Voice capture uses the selected Linux microphone through FFmpeg/PulseAudio (including
PipeWire’s PulseAudio compatibility service). It starts only when you press Record and keeps
running if you change pages. Captured audio and unsaved drafts live under `voice-recordings/`;
interrupted captures are recovered on restart. Saving adds them to the Voice notes collection,
with optional full transcription and speaker labels. Live preview uses the same local ASR in short
sections; stopping preview leaves capture running. Preview text survives restart beside the draft,
and archive processing waits while preview is active. `pactl` enables the microphone picker; the system default
input can be used when the input list is unavailable.

Native code: `desktop/src-tauri/`. Interface: `desktop/src/`. Electron reference:
`client/`, `server/`, `electron/`. See [legacy build instructions](docs/legacy-build.md),
[Nemotron notes](docs/nemo-native.md), and the [development handoff](docs/HANDOFF.md).

## Remaining work

Remaining work includes ChatGPT sign-in, optional post-transcription AI actions, final
Electron parity checks and broad installation validation. macOS follows Linux, then Windows. Watchers and the standalone Compare screen
are intentionally omitted. Eleven-speaker recordings have been exercised; a recording with
sixteen distinct speakers still needs validation.

Private recordings, databases, model weights and credentials do not belong in Git.
Concord is MIT licensed; bundled components and downloaded models retain their own licenses.
