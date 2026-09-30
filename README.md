# Concord Next

A local research archive for spoken-word media. Listen, transcribe, find passages,
recognize familiar voices, and connect what you learn.

This branch is the **Linux-first Rust/Tauri preview**. The working Electron/Nemotron
build is preserved on `feature/nemo-native`. The new app runs beside it as
**Concord Next**, with a separate database and transcript folder.

## What works in the first native build

- Import an existing Concord library and saved voice fingerprints into a separate database.
- Browse collections, play local recordings, and seek from transcript timestamps.
- Import local audio/video and transcribe with Nemotron 3.5 multilingual ASR and
  Nemotron diarization; review activity and cancel processing.
- Search transcript words locally with SQLite FTS5.
- Name voices, read documents, save research notes, and connect notes on a map.
- Use the supplied Concord branding in the desktop window and launcher.

Rust owns database access, jobs, process management, transcript/speaker merging,
and search. The React interface talks to Rust through Tauri commands. There is no
Electron runtime or Node server. A small Rust media stream binds to loopback on a
random port with per-session unguessable URLs, because Linux WebKitGTK cannot play
Tauri's custom asset URLs. Only the open recording is exposed; app commands use IPC.
NeMo-Speech.cpp runs ASR and diarization; Python/TitaNet still provides the tested
voice fingerprints and cross-window clustering.

## Run on Linux

Install Rust, Node.js 24+, pnpm 10, FFmpeg, GStreamer base/good/bad/libav plugins, patchelf, and the
[Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).
For this first preview, finish speech setup in the existing Nemotron Concord app;
Next reuses its model files and voice-matching environment.

```sh
pnpm install --frozen-lockfile
bash scripts/stage-nemo-runtime.sh
pnpm --dir desktop desktop
```

The first launch can import the existing Concord database or start with local
recordings. No media files are copied or deleted. The import does not carry over
watchers, queued jobs, or AI credentials. Keep external media drives connected.

```sh
# Type-check and build the interface
pnpm --dir desktop build
# Rust storage, search, and transcript tests
pnpm --dir desktop test
# Linux desktop bundles
pnpm --dir desktop package
# Install alongside Concord, with its own application launcher
bash scripts/install-next-local.sh
```

The packaged app needs FFmpeg and the speech dependencies described above. The
AppImage includes GStreamer playback codecs, native runtime libraries, and helper
scripts. Packaging checks for AAC, H.264, AV1, Opus, and Vorbis support before building.
Maintainers can set `CONCORD_GST_PLUGINS` to a folder of additional plugins from the
same distro/GStreamer release as the build host. First-run model downloading and
voice-environment installation within Next are still to be ported.

On NVIDIA/Wayland, this build applies Tauri's documented
[WebKitGTK rendering workaround](https://v2.tauri.app/develop/debug/linux-graphics/)
inside the app after reproducing the `Gdk Error 71` failure. It does not change
desktop settings or speech GPU acceleration. An explicitly set
`WEBKIT_DISABLE_DMABUF_RENDERER` takes precedence.

## Data and development

Linux preview data lives in `~/.local/share/concord-next/` (or the corresponding
`XDG_DATA_HOME`). Set `CONCORD_NEXT_DATA` to isolate a test profile. New transcripts
are versioned under that folder; re-transcription never overwrites a transcript
owned by the stable app. Original media is read in place.

The native implementation is in `desktop/src-tauri/`; its interface is in
`desktop/src/`. The legacy application remains in `client/`, `server/`, and
`electron/` for migration reference. See [legacy build instructions](docs/legacy-build.md)
and [the Nemotron integration notes](docs/nemo-native.md).

For the current project state, decisions, local setup, validation, and next work,
start with the [development handoff](docs/HANDOFF.md).

## Next milestones

This is a working first native slice, not full feature parity. Upcoming work:

- Simplified channel subscriptions and downloads, with a durable job queue.
- A self-contained speech installer and broader Linux packaging validation.
- Unified word/semantic search; separate embedding and chat providers/models.
- Local/OpenRouter chat and research citations; evaluate supported account-login integrations separately.
- Full note anchors/tags and richer document editing and map navigation.
- macOS, then Windows packaging and validation.

Watchers and the standalone Compare screen are intentionally excluded from the
new navigation. Sixteen-speaker capacity continues to use overlapping diarization
windows and global voice matching; there is no eight-person recording limit.

Private recordings, databases, model weights, and local credentials do not belong
in Git. Concord is licensed under MIT; bundled components retain their licenses.
