# Native Nemotron branch

`feature/nemo-native` keeps the existing Concord interface and library format.
On Linux its recommended speech engine is now:

- Nemotron 3.5 multilingual ASR, Q8 GGUF, through NeMo-Speech.cpp.
- Nemotron 3 Diarization, Q8 GGUF, through the same native runtime.
- Existing TitaNet voice embeddings and Concord's cross-chunk grouping, speaker
  profiles, word/turn merge, and transcript editing.

The native runtime uses Vulkan when available, or CPU. TitaNet still uses the
managed Python/NeMo environment, with CUDA on supported NVIDIA hardware or CPU.
This branch therefore does not remove Python/PyTorch from saved voice matching.
Legacy engines remain available for rollback. macOS and Windows native packaging
are follow-up work; existing macOS FluidAudio behavior remains available.

## Installation and use

The Linux AppImage bundles the native executable and its private shared libraries.
Pipeline → Setup downloads and verifies about 810 MiB of pinned model files.
It reuses a compatible voice-matching environment; fresh installations also install
the NeMo Python dependencies. Model downloads require internet; processing is local.

Selecting the new engine preserves the library and existing transcripts. Use the
normal library re-transcribe action to regenerate selected recordings. Re-transcribing
replaces the transcript and recalculates local speaker labels; saved global voice
profiles remain available for automatic matching. Back up the database and transcript
folder before regenerating a large archive.

## Build

Use the repository's usual Node/pnpm prerequisites, Python, CMake, Ninja, a C++
compiler, and Vulkan build tools for a Vulkan build.

```sh
pnpm install
bash scripts/fetch-binaries.sh
pnpm check
pnpm test
pnpm build
pnpm electron:rebuild
pnpm exec electron-builder --linux AppImage
```

`scripts/stage-nemo-runtime.sh` stages the pinned native revision, libraries, and
licenses under ignored `build/binaries/nemo/`. It builds a missing runtime using
`experiments/diarization/build-runtime.sh`. Set `CONCORD_NEMO_BACKEND=cpu` for a
fresh CPU-only build. When changing backends, rebuild the cached runtime explicitly.
For source development, stage the runtime before using the setup page.

The native addon ABI differs between Node and Electron. Run
`pnpm rebuild better-sqlite3` before Node tests after packaging; run
`pnpm electron:rebuild` again before launching Electron.

## Validation and capacity

Private recordings and results stay outside the repository. On the development
RTX 2080 Ti, the full October 7 and October 22 recordings completed through the
application transcription adapter in about 217 and 276 seconds, respectively,
including diarization and speaker merging. The recordings are about 135 and 179
minutes long. The runs produced 12 and 11 speaker groups; those counts are not an
accuracy score. The October 7 call has 10 known participants, so split/extra groups
still need review.

Nemotron Diarization has eight local speaker slots per window. Concord retains
its overlapping-window and voice-fingerprint grouping, so the full recording is
not limited to eight speakers. Sixteen-person capacity is an aim, not yet a claim
validated on a real 16-person call. People must be distinguishable from their
audio; increasing capacity alone does not guarantee correct identities.

ASR uses 180-second outer chunks and the tested 1,120 ms right context. Diarization
uses 120-second windows with 10-second overlap and the existing 0.65 clustering
threshold. The native runtime/model revisions and checksums are pinned in
`server/nemo-runtime.ts` and the build script.

`rewrite/rust-tauri` is the next branch, based on this implementation. It is intended
for the later Rust/Tauri rebuild after the current-interface version is reviewed.
