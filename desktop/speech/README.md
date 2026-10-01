# Private speech setup

Concord Next 0.11 installs speech from Settings. It keeps models in `models/nemo`,
Python in `speech/python`, and versioned voice environments in `speech/environments`,
all relative to the Concord Next data folder. It never installs into system Python.
The `speech/active` pointer switches atomically after a successful fingerprint check.
Old environments remain available if setup is cancelled or fails. Reused model files
are hashed before copying. Partial downloads are never published as usable models.

The private installer is uv 0.12.5, pinned and verified by
[`stage-next-setup.sh`](../../scripts/stage-next-setup.sh). It installs managed CPython
3.12.14 and the hash-locked Linux dependencies here. The main pins are NeMo Toolkit
2.7.3 and PyTorch 2.13.0 CPU. The Python layer supplies TitaNet voice fingerprints and
cross-window grouping; native NeMo-Speech.cpp supplies transcription and diarization.
CPU voice matching avoids downloading the large NVIDIA PyTorch runtime on new installs.
Existing CUDA-capable environments continue to be used until private setup is selected.

The model manifest in [`speech_setup.rs`](../src-tauri/src/speech_setup.rs) pins URLs,
revisions, byte sizes and SHA-256 hashes:

| Model | Artifact | Bytes |
| --- | --- | ---: |
| [Nemotron 3.5 multilingual ASR](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) | Q8 GGUF | 741,548,352 |
| [Nemotron 3 Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization) | Q8 GGUF | 107,012,128 |
| [TitaNet Large](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_large) | v1 `titanet-l.nemo` | 101,621,760 |

Model licenses and usage terms are provided on the linked upstream model pages.
Model weights are not included in this repository or the AppImage.

Maintainers can regenerate the dependency locks with the pinned uv, then repeat the real
installation and recording tests before changing them:

```sh
uv --no-config pip compile desktop/speech/requirements-linux-x64.in \
  --python-version 3.12 --python-platform x86_64-unknown-linux-gnu \
  --torch-backend cpu --generate-hashes --no-header --no-annotate \
  -o desktop/speech/requirements-linux-x64.lock
```

Use `aarch64-unknown-linux-gnu` and `requirements-linux-arm64.lock` for the ARM lock.
ARM dependencies resolve, but the end-to-end installation has been tested on x86-64 only.

Verification includes corruption/replacement checks, interrupted setup state, activation
validation, a fresh private install plus a real diarized recording, an entirely CPU-based
recording, and native WebKitGTK setup/cancellation. The ignored Rust integration test
`real_independent_install_runs_a_diarized_recording` requires `CONCORD_TEST_AUDIO` and
keeps its temporary library path in the test output for native follow-up inspection.
`desktop/scripts/native-speech-setup-smoke.js` checks the Settings UI against that library.
