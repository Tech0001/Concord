# Nemotron ASR replacement experiment

This tests actual transcription-model replacements for Parakeet, using the
isolated lab. Nemotron ASR writes words. Nemotron Diarization is the separate
speaker-turn model tested earlier. Nothing in the production app or database
was changed.

## Candidates and method

All native candidates use official Q8_0 artifacts, verified by SHA-256 against
the pinned runtime model index. Exact revisions and hashes are in `asr.py`.

| Model | Parameters | GGUF bytes | GGUF MiB |
| --- | ---: | ---: | ---: |
| Parakeet TDT v3 | 600M | 713,975,456 | 680.90 |
| Nemotron English | 600M | 699,872,960 | 667.45 |
| Nemotron 3.5 multilingual | 600M | 741,548,352 | 707.20 |

The new models are approximately the same download size as Parakeet. Download
size is not inference RAM or VRAM.

Hardware: i7-13700K, eight inference threads, RTX 2080 Ti with Vulkan. Runtime:
`4c101bc7113f49101a3e11d2c994c519f41939f6`. Current-reference runs use Concord's
unchanged Python Parakeet script and existing NeMo environment, with CUDA
hidden for a genuine CPU run. Native inference runs without Python/PyTorch.

Audio excerpts:

- October 22: original minutes 15–21, matching the earlier Parakeet benchmark.
- October 7: original minutes 17–27, selected by the user to check glossolalia
  and English lines that Parakeet missed.

All candidates retain Concord's 240-second chunk threshold, 180-second outer
chunks, and global word timestamp offsets. These excerpts are not full-meeting
benchmarks. Speaker detection is off during ASR timing. Trials are single
samples on a shared desktop; process startup and model loading are included.

## Processing mode matters

The runtime silently routes Vulkan RNNT file requests to streaming for backend
compatibility, while CPU file requests use offline inference for these clips.
The harness therefore records actual mode and geometry from the worker log.

Default streaming lookahead is one encoder frame (160 ms steps). That setting
is aimed at low latency, not archived-meeting throughput. `--stream` explicitly
selects streaming on both CPU and GPU. `--right-context -1` preserves the
exported model's setting: 13 frames / 1120 ms steps for English, but only three
frames / 320 ms steps for this multilingual artifact. Explicit context 13 is
also a documented supported multilingual setting. Exported context is not
necessarily the largest setting the model supports.

On the six-minute clip, English offline CPU took 84.84 s with 3,892 MiB RAM;
English streaming at 1120 ms took 58.27 s with 1,014 MiB RAM. Multilingual
offline CPU took 278.13 s with 3,997 MiB RAM. These are different execution
paths, so the slow offline result is not a streaming-CPU benchmark.

The first English default-lookahead GPU run was exploratory: a CPU job was
launched before GPU completion was confirmed. Later selected runs execute
sequentially. That exploratory time is retained in the lab but excluded from
the primary comparison.

## Selected measurements

Six-minute October 22 excerpt:

| Model / runtime / mode | Device | Seconds | Peak sampled RAM MiB | Peak sampled VRAM MiB |
| --- | --- | ---: | ---: | ---: |
| Current Parakeet / Python / offline | CPU | 85.53 | 5937.43 | — |
| Parakeet / native / offline | CPU | 60.78 | 2037.13 | — |
| Nemotron English / native / streaming 1120 ms | CPU | 58.27 | 1014.39 | — |
| Parakeet / native / offline | Vulkan | 11.79 | 436.27 | 2120 |
| Nemotron English / native / streaming 1120 ms | Vulkan | 10.59 | 246.54 | 932 |
| Nemotron 3.5 / native / streaming 1120 ms | Vulkan | 7.74 | 190.64 | 930 |

Ten-minute October 7 excerpt, original minutes 17–27:

| Model / runtime / mode | Device | Seconds | Peak sampled RAM MiB | Peak sampled VRAM MiB |
| --- | --- | ---: | ---: | ---: |
| Current Parakeet / Python / offline | CPU | 116.29 | 5927.82 | — |
| Parakeet / native / offline | Vulkan | 4.63 | 281.77 | 2130 |
| Nemotron English / native / streaming 1120 ms | Vulkan | 11.74 | 190.01 | 932 |
| Nemotron 3.5 / native / streaming 1120 ms | Vulkan | 11.45 | 190.74 | 930 |

Speed ordering differs by excerpt; the tested Nemotron configuration is not
universally faster than native Parakeet. Its GPU memory use is lower in both
samples. These measurements are worker memory, not total application needs.
There is no matched-context multilingual CPU streaming measurement yet.

## Output review

Each candidate produces word timestamps and Concord-format transcript JSON.
The native adapter uses Concord's fallback segment grouping; sentence rows
and punctuation differ from the existing NeMo output. Presence of timestamps
does not establish their alignment accuracy.

In the October 22 clip, the English candidate repeats `but` many times at the
same timestamp around original 16:44. It also lacks most of the sentence that
Parakeet renders as “Ryan called us the land of misfit toys” around 17:04.
The multilingual candidate includes a version of that sentence. These are
concrete output differences to review against the audio, not a ground-truth
accuracy ranking.

Some streaming outputs put word ends beyond the excerpt boundary, up to 0.56
seconds in the selected multilingual ten-minute run. Raw output is retained rather than silently repaired;
production integration needs boundary handling and speaker-alignment checks.
The native Nemotron transcripts also contain much less sentence punctuation
on this sample than Parakeet, despite the models supporting punctuation.

The private report provides the audio and side-by-side 30-second transcript
sections, with row labels in original-recording time. Differences from current
Parakeet are automatic-output disagreement, not word error rate. More words
during glossolalia are not automatically recovered English: listening review
must distinguish intelligible speech from invented or phonetic text.

### The user-selected difficult passage

At original 21:30–22:00 on October 7, both Nemotron candidates include an
additional passage beginning “he wants everybody to understand the gravitas
of what's at hand,” followed by the speaker describing praying for the group.
Both Parakeet outputs omit that passage and resume at the statement about
hedges of protection. This is a promising candidate recovery of the missing
English the user described; it is not yet a hand-verified reference transcript.
The report puts an isolated 30-second audio clip and all four outputs first.

Nemotron also includes additional words near original 19:00 and 24:20.
However, multilingual Nemotron produces phonetic-looking material in several
gaps within the user-identified glossolalia region. English Nemotron has less
of that material in this comparison. Neither model has established reliable
glossolalia detection or universal recovery of surrounding English.

Normalized word disagreement against current Parakeet is 13.80% for English
Nemotron and 18.50% for tuned multilingual Nemotron in this ten-minute section.
The six-minute general sample gives 7.74% and 6.93%, respectively. Those values
combine potential recoveries and errors and must not be read as accuracy.

All 15 saved ASR runs completed and were checked for correct model metadata,
duration, global chunk offsets, and nonnegative ordered word intervals. The
private `asr/output-audit.json` preserves boundary overruns and repeated
word/time records. The lab's 12 automated tests pass. Source audio and private
transcripts remain outside Git.

## Scope and remaining checks

The C++ runtime makes both model families viable without an NVIDIA GPU on this
PC. It does not establish performance on a Mac or low-end CPU. English-only
Nemotron also narrows the language coverage of Parakeet v3. Multilingual
Nemotron lists 32 locales working out of the box and eight requiring adaptation;
its supported language set is not a strict replacement for Parakeet's.

ASR model choice does not set the meeting's speaker count. The earlier
Nemotron diarization test reused Concord's existing cross-chunk TitaNet voice
grouping on the 10- and 11-person recordings. Global grouping has no eight-slot
limit, but accurate identification of 16 actual participants is still untested.
TitaNet is also still a separate Python dependency in the tested pipeline.

Recommendation: retain Parakeet as the reference and keep Nemotron English as
a selectable candidate while the targeted audio is reviewed. The native
runtime is useful with either model; model selection can stay independent of
the 16-speaker diarization goal. These results do not justify an unconditional
production replacement yet.

Sources: [English model](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b),
[multilingual model and context settings](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b),
[runtime configuration](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/4c101bc7113f49101a3e11d2c994c519f41939f6/docs/asr/configuration.md),
[runtime file-request routing](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/4c101bc7113f49101a3e11d2c994c519f41939f6/src/asr/recognizer.cpp).
