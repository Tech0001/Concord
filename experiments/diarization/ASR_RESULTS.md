# Parakeet runtime comparison

This replaces the inference runtime for Parakeet TDT 0.6B v3; it does not
replace the transcription model with Nemotron Diarization. Parakeet produces
words, Nemotron Diarization produces speaker turns, and NeMo-Speech.cpp can
run both. TitaNet voice fingerprinting remains a separate component.

## Setup

- CPU: Intel Core i7-13700K, eight inference threads.
- GPU: RTX 2080 Ti, Vulkan backend. No CUDA backend was built.
- Runtime: `4c101bc7113f49101a3e11d2c994c519f41939f6`, separate ASR-enabled build.
- Official model revision: `541d1f99c6b0c3cd0b11a95167540bb8edefd82b`.
- GGUF: 713,975,456 bytes, Q8_0.
- SHA-256: `e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e`.

Native model bytes were checked against the official artifact. The Python
reference uses Concord's existing NeMo environment and transcription script.
CPU reference workers hide CUDA during model restoration and use eight
OMP/MKL threads. The attempted current GPU smoke run ran out of available
VRAM during loading alongside other desktop workloads; no other processes
were stopped. That failed run is not a GPU speed comparison.

All audio and output data remain in the isolated test environment. A
one-minute excerpt from the first meeting and a six-minute excerpt from the
second were tested. These are not full-recording transcription benchmarks.

## Six-minute excerpt

Both runtimes use Concord's existing 240-second chunking threshold and
180-second chunks. Native word times are offset across the two chunks and
passed through Concord's fallback segment grouping. Speaker detection is off.

| Runtime / device | Worker seconds | Audio seconds per worker second | Peak sampled process RAM | Peak sampled worker VRAM |
| --- | ---: | ---: | ---: | ---: |
| Native Q8 / CPU | 60.78 | 5.92 | 2,037.13 MiB | CPU execution |
| Current Python / CPU | 85.53 | 4.21 | 5,937.43 MiB | CPU execution |
| Native Q8 / Vulkan | 11.79 | 30.53 | 436.27 MiB | 2,120 MiB |

Worker times include process startup and loading; they are single samples on
a shared desktop. Harness time, including preparation and hash verification,
was 61.28 / 85.53 / 12.39 seconds respectively. No Mac or lower-spec PC was
measured. NeMo-Speech.cpp's published streaming Nemotron-ASR benchmarks are
for a different model and are not used as evidence for these Parakeet results.

After normalizing punctuation and case, native CPU differs from the current
CPU transcript by 10 word edits over 995 reference words (1.01%). Native
Vulkan differs by 13 edits (1.31%). Native CPU and Vulkan differ by 5 edits
over 998 words (0.50%). These are disagreements between automatic outputs,
not accuracy scores; determining which words are correct requires listening.
The backends do not produce byte-identical text or timestamps.

Word timestamps are present in all outputs, including the second chunk's
global offset. The current reference emits 81 sentence segments and the
native adapter emits 15 larger segments using Concord's existing fallback
grouping; word-level speaker merging remains possible, but row segmentation
is not identical. Production integration should preserve the desired reading
and speaker-turn layout.

## One-minute smoke test

Native CPU completed in 8.43 seconds with 1,182.09 MiB sampled peak RAM.
Current CPU reported 15.7 seconds loading and 7.1 seconds transcription
(excluding interpreter/framework import time). The native output retained
all 97 normalized current-reference words and added four brief interjections.
Their correctness has not been hand-labelled.

## Implication

CPU Parakeet transcription is practical on this PC through the native runtime,
with lower measured RAM and startup-inclusive time in this test. The original
Python model can also run on CPU; the native approach chiefly simplifies
packaging and reduces dependence on the Python/PyTorch/CUDA installation.
Mac CPU/Metal support is provided upstream but remains untested here. Broader
quality checks and production integration are still required. Removing Python
from the entire application also requires a native voice-fingerprinting path.

Sources: [native runtime](https://github.com/NVIDIA/NeMo-Speech.cpp),
[Parakeet model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).
