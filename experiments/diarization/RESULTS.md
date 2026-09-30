# Local evaluation results

Two private meeting recordings were evaluated on an RTX 2080 Ti (11 GiB),
using Vulkan and Nemotron-3-Diarization Q8. The recordings contain 10 and 11
reported participants. Existing Concord labels are automatic references,
not hand-labelled ground truth. Audio, names, databases, and outputs are
stored outside the repository.

Runtime revision: `4c101bc7113f49101a3e11d2c994c519f41939f6`.
Model revision: `f667ed73aee57d40cc39428eb768b4fd87a0a29e`.
Model file: 107,012,128 bytes (about 102 MiB).

## Primary test: unchanged Concord pipeline, Nemotron turn detector

`concord_pipeline.py` calls the production `diarize()` function unchanged,
substituting only the turn-detection model object in the test process. The
usual chunking, overlap deduplication, full-turn embeddings, 0.65 greedy
grouping, short-turn continuation, minor-speaker cleanup, and profile generation
all run in the existing code. Only the isolated lab database is written.

| Recording | Saved Concord profiles / named people | New groups | Reference people represented | Full pipeline seconds |
| --- | ---: | ---: | ---: | ---: |
| 2h 15m, 10 people | 10 / 10 | 12 | 10 / 10 | 44.28 |
| 2h 59m, 11 people | 12 / 11 | 11 | 11 / 11 | 58.06 |

The new model works with Concord's existing approach to exceed eight global
speaker identities. The 11-person recording yields 11 groups, each dominated
by a different existing reference name. The first recording retains groups
corresponding to all 10 names but has two extra groups to review. One extra
group has very little overlap with the old transcript, so its identity cannot
be established from the reference alone. No mixed group meets the report's
substantial-mixing criterion. These are comparisons with saved labels, not a
fresh old-model speed benchmark or a hand-labelled accuracy measurement.

Native turn detection took 28.64 / 41.58 seconds and used 173 MiB of sampled
worker VRAM. TitaNet's peak PyTorch reserved memory was 1,644 / 1,070 MiB;
allocator figures exclude CUDA context overhead and are not total pipeline
memory. Each run also emitted Concord's normal 192-dimensional speaker
profiles in `concord.diar.json`.

These results supersede the earlier alternative-grouping tests below for
assessing a model replacement. A real 16-person recording remains untested.

## Earlier standalone native inference

| Recording | Native seconds | Output identities | Sampled worker VRAM | Sampled worker RAM |
| --- | ---: | ---: | ---: | ---: |
| 2h 15m, 10 people | 53.54 | 8 | 172 MiB | 2,464.53 MiB |
| 2h 59m, 11 people | 82.33 | 8 | 172 MiB | 3,242.82 MiB |

Both recordings hit the native eight-speaker limit. Each has two tracks
containing substantial speech from multiple reference voices. Native
inference alone therefore does not satisfy the requested 10/11-person test.
The CLI loads the full input audio into host memory; model inference is
streaming, but full-file host memory is not constant.

The 60-second smoke test produced identical timestamps and speaker IDs on
CPU and Vulkan. This does not establish whole-recording CPU/GPU equivalence.

## Earlier windowed inference with alternative voice grouping

Sessions reset every 120 seconds, with 10 seconds of overlap. TitaNet supplies
192-dimensional voice embeddings. The candidate averages embeddings per
window/channel and applies average-linkage cosine clustering. Expected
speaker counts and old labels are not inputs to clustering. Brief voices
are retained; no minor-speaker merge is used.

| Recording | Windowed native seconds | Windowed worker VRAM / RAM | First embedding pass |
| --- | ---: | ---: | ---: |
| 2h 15m | 26.09 | 173 / 191.24 MiB | 10.22 seconds |
| 2h 59m | 37.97 | 173 / 195.96 MiB | 14.60 seconds |

Window extraction increases native-stage wall time to 30.21 and 44.20 seconds
respectively. Grouping cached embeddings takes under one second per threshold.
These memory measurements cover the native diarizer only. The Python/TitaNet
embedding worker was not memory-profiled; these numbers are not total pipeline
requirements. Parakeet transcription was not benchmarked or replaced.

At cosine distance 0.65, both recordings produce 13 substantial tracks
(at least 15 seconds of speech). All 10/11 reference voices dominate at least
one such track, with no mixed track meeting the report's substantial-mixing
criterion. However, one reference voice in the first recording and two in
the second are split into multiple substantial tracks. Each recording has
39 total tracks, including 18/16 unresolved local tracks and other brief
fragments. These are not 39 confirmed people.

Sensitivity matters: at 0.70 the first recording improves to 11 substantial
tracks, while the second merges two reference voices. A single more permissive
threshold is therefore not a reliable fix. Earlier per-turn greedy grouping
fragmented voices even more; its outputs remain available for comparison.

## Limitations of the earlier alternative grouping

The small native diarizer is a promising backend for the rebuild. These
earlier experiments changed grouping and cleanup as well as the model;
their results did not establish how a direct replacement would behave.
The alternative-grouping runs did not deliver clean 10/11-person identities.
It should not be advertised as validated 16-person recognition. A synthetic
16-profile test verifies grouping capacity only; a real 16-person recording
and listening review would be needed to assess that claim.

Listening review should include short speakers and overlapping speech.
Hand-labelled reference
intervals are needed for a meaningful diarization error rate. The local report
contains playable examples and all raw outputs for that review. No application
UI, production database, or transcription backend was changed.

Sources: [model card](https://huggingface.co/nvidia/Nemotron-3-Diarization),
[recording evaluation protocol](https://huggingface.co/nvidia/Nemotron-3-Diarization/blob/main/diarization_evaluation.md),
[native runtime](https://github.com/NVIDIA/NeMo-Speech.cpp).
