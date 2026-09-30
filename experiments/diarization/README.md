# Nemotron diarization experiment

This branch evaluates speaker quality before any Rust/Tauri or UI migration.
Native inference uses NVIDIA NeMo-Speech.cpp with Nemotron-3-Diarization Q8.
The small Python harness uses stdlib SQLite and FFmpeg. The optional voice
grouping experiment reuses Concord's already installed NeMo/TitaNet environment;
it does not update that environment or make Python part of the future Rust app.

All state lives in `~/.local/share/concord-diarization-lab/lab.sqlite3` and its
`runs/` directory. Runtime and model downloads live in
`~/.cache/concord-diarization-lab`. Media is read from the supplied copies.
The archive database is opened with SQLite `mode=ro` and `query_only`; only
speaker names, voice profiles, and segment timestamps are copied. No app
database initialization, migration, indexing, or production job is invoked.
Existing automatic labels are comparison references, not verified ground truth.

## Setup

```bash
bash experiments/diarization/build-runtime.sh vulkan
python -m unittest discover -s experiments/diarization -p 'test_*.py'
```

Use `cpu` instead of `vulkan` if Vulkan headers/compiler are unavailable.
The source runtime and HF model revisions are pinned in the scripts. Builds
need Git, CMake, Ninja, a C++ compiler, and the existing `hf` CLI; SentencePiece
is built inside the cache. Missing Vulkan headers are fetched at a pinned
revision inside the same cache. No system package installation is performed.

## Register recordings

```bash
python experiments/diarization/lab.py prepare --audio /path/meeting-10.ogg \
  --case meeting-10 --expected-speakers 10
python experiments/diarization/lab.py prepare --audio /path/meeting-11.ogg \
  --case meeting-11 --expected-speakers 11
```

Add `--baseline-video-id VIDEO_ID` and, if needed, `--archive-db /path/pipeline.db`
to copy a baseline from an existing archive. Case audio is fingerprinted; a
changed file requires a new case. `--root /path/to/lab` precedes the subcommand
and selects a separate lab directory. The harness rejects archive aliases and
production-schema databases at its output path.

## Use Concord's existing pipeline with Nemotron

This is the primary replacement test. It calls the existing production
`diarize()` function with a process-local adapter for the turn-detection model:

```bash
~/.local/share/concord/venv/bin/python experiments/diarization/concord_pipeline.py \
  --cases meeting-10 meeting-11 --device vulkan:0
```

The existing function performs its usual 120-second chunking, 10-second
overlap deduplication, full-turn TitaNet embeddings, 0.65 greedy grouping,
previous-speaker handling for short turns, minor-speaker cleanup, and voice
profile generation. The adapter only translates native Nemotron output into
the per-chunk format that function already consumes. The production script
is imported unchanged; the model substitution ends with the scoped test call.
Only the isolated lab database and lab files are written.

Each run records the production script's hash and saves its normal
`concord.diar.json`, including the same 192-dimensional speaker profiles.
The native worker's RAM/VRAM and PyTorch embedding allocator memory are measured
separately. Their accounting is different and neither is total app memory.

## Earlier native and alternative-grouping experiments

These exploratory tests changed grouping and cleanup behavior as well as the
turn detector. They are retained for reference, but are not the direct
replacement test above.

```bash
python experiments/diarization/lab.py run --case meeting-10 --mode native --device vulkan:0
python experiments/diarization/lab.py run --case meeting-10 --mode windowed --device vulkan:0
# Substitute the windowed run ID printed above:
~/.local/share/concord/venv/bin/python experiments/diarization/cluster.py --run RUN_ID
python experiments/diarization/lab.py report
```

Repeat for the second recording. Native mode is one continuous streaming
session and can emit at most eight identities. Windowed mode resets the native
session every 120 seconds with 10 seconds of overlap; window-local labels are
explicitly distinct until TitaNet embeddings group voices across windows.
By default, duration-weighted embeddings form one voice profile per native
window/channel; average-linkage cosine clustering groups those profiles.
`--strategy turns` retains the earlier greedy per-turn method for comparison.
The threshold sweep is unconstrained: it does not force 10, 11, or 16 people,
and does not discard low-airtime speakers to make the count look correct.
Short turns without embeddings retain their local channel's grouped identity,
or remain unresolved if that channel has no usable embedding. Overlapping
speech is retained in the raw output.
Both use NVIDIA's published recording evaluation geometry: chunk 340, right
context 40, left context 0, speaker cache 264, FIFO 40, refresh 300 (80ms frames).
This keeps streaming inference bounded while avoiding the CLI's default
1.04-second live-call chunks. `--geometry live` selects that live-call profile
for an explicit comparison. Neither mode uses full-file attention.

To run both prepared cases sequentially and produce the report:

```bash
python experiments/diarization/evaluate.py --cases meeting-10 meeting-11 --device vulkan:0
```

Each run saves raw JSON, process logs, sampled native RSS/VRAM, timing, normalized
segments, RTTM, and speaker summaries. `report.html` includes three separated
listening samples per native track and substantial track in the 0.65 grouping
candidate, plus overlap with old transcript labels. The complete threshold
sweep remains visible; all tracks remain in JSON/RTTM. The 15-second display
cutoff only reduces review clutter and does not discard brief speakers.
Check people being merged, one person being split, brief speakers,
overlap, and stability across the whole recording. A matching speaker count
alone is not a success criterion. DER requires hand-labelled reference RTTM;
the report deliberately does not present old-label agreement as DER.

Serve the private report locally:

```bash
python -m http.server 5051 --bind 127.0.0.1 \
  --directory ~/.local/share/concord-diarization-lab
# Open http://127.0.0.1:5051/report.html
```

Run optional numeric grouping tests with the existing embedding environment:

```bash
~/.local/share/concord/venv/bin/python -m unittest discover \
  -s experiments/diarization -p 'test_*.py'
```

The synthetic 16-profile test establishes that global grouping has no eight-slot
software limit. It does not establish recognition accuracy on a 16-person call.
See [measured results and limitations](RESULTS.md).

Sources: [Nemotron model](https://huggingface.co/nvidia/Nemotron-3-Diarization),
[native runtime](https://github.com/NVIDIA/NeMo-Speech.cpp),
[NVIDIA evaluation protocol](https://huggingface.co/nvidia/Nemotron-3-Diarization/blob/main/diarization_evaluation.md).
