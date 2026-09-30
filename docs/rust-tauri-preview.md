# Rust/Tauri preview

`rewrite/rust-tauri` starts from the working Nemotron branch, preserved as
`feature/nemo-native`. The preview is installed as **Concord Next** with its own
identifier, launcher, SQLite database, generated transcripts, and thumbnail cache.
Imported media stays in place. Imported transcripts remain readable in place until
the user re-transcribes; each replacement is written under the new data directory.

## Architecture

- `desktop/src/`: React interface; Tauri IPC is the only backend transport.
- `desktop/src-tauri/src/db.rs`: isolated SQLite storage, import, and FTS5 search.
- `speech.rs`: cancellable process groups, model verification, and atomic publication.
- `transcript.rs`: word-to-speaker assignment and saved-voice comparisons.
- `thumbnail.rs`: reuse imported artwork or extract a local video frame with FFmpeg.
- `playback.rs`: range-aware, bounded media streaming on loopback for WebKitGTK.
  Only the current recording is registered behind an unguessable session URL;
  there is no directory serving or HTTP application API.
- `server/transcription-engines/transcribe-nemo.py`: the existing tested speech
  coordinator, packaged as a helper while its remaining responsibilities are ported.

NeMo-Speech.cpp runs multilingual transcription and diarization. TitaNet/Python
still supplies voice fingerprints and cross-window clustering. The Rust rewrite
does not change the established method for linking more than eight people across
a recording. It is not evidence of a new 16-person accuracy benchmark.

## Verify

```sh
pnpm --dir desktop build
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings

# Optional real recording test; writes only into a temporary test library.
CONCORD_TEST_AUDIO=/absolute/path/to/recording.wav \
  cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  real_speech_job_publishes_only_to_new_library -- --ignored

pnpm --dir desktop package
bash scripts/install-next-local.sh
```

Storage tests cover read-only legacy import, transcript search, speaker assignments,
duplicate-media handling, and isolated thumbnail reuse. Transcript tests cover
speaker IDs above eight and short-turn absorption without changing word labels.
The optional integration test checks actual ASR/diarization, job completion,
transcript publication, and searchable results.

The Linux build packages media codecs for WebKitGTK playback. Its build script
checks common codecs before invoking Tauri. AppImage portability still needs
validation on other distributions; the current preview is built and exercised on
the development machine. macOS and Windows are later targets.

## Deliberate limits of this first slice

The speech installer currently reuses the previous app's model files and managed
Python environment. Channel subscriptions/downloads, durable queued work, semantic
search, and chat providers still need native implementations. Embedding providers
and chat providers will have separate configuration.

Documents currently expose imported searchable text, plus Markdown/plain-text
imports. Notes retain their primary passage and links; full legacy anchors, tags,
and rich editing are not yet ported. The old database retains that information.
Watchers and standalone Compare are absent from the new navigation.
