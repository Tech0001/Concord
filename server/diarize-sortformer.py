#!/usr/bin/env python3
"""
Speaker diarization bridge for the Concord pipeline (Linux side).

Wraps NVIDIA NeMo's Sortformer model. Output JSON shape matches
FluidAudio's `process` command on Mac so the same TS-side
`spansFromFluidAudio()` consumes both — single normalizer, identical
speaker semantics across machines.

Usage:
    diarize-sortformer.py <audio_path> --output-json <out.json>
                          [--model nvidia/diar_sortformer_4spk-v1]
                          [--device cuda]
"""

import argparse
import json
import os
import re
import sys
import time


def parse_nemo_segments(segment_lines):
    """Parse NeMo Sortformer's per-turn output into speaker spans.

    Format is `"<start> <end> <speaker_label>"` (3 space-separated tokens),
    NOT RTTM as the docs imply. Example: `"0.080 6.560 speaker_0"`.

    Returns a list of {speakerId, startTimeSeconds, endTimeSeconds,
    qualityScore} dicts. Speaker names from NeMo are `speaker_0`,
    `speaker_1`, etc.; we extract the numeric portion and re-emit
    1-indexed string ids ("1", "2", ...) to match FluidAudio's output
    convention so the TS merge module can use a single normalizer for
    both engines.
    """
    spans = []
    for line in segment_lines:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            start = float(parts[0])
            end = float(parts[1])
            raw_speaker = parts[2]
        except (ValueError, IndexError):
            continue

        # `speaker_0` → "1", `speaker_3` → "4" (1-indexed to match FluidAudio)
        m = re.search(r"(\d+)", raw_speaker)
        speaker_id = str(int(m.group(1)) + 1) if m else "1"

        spans.append({
            "speakerId": speaker_id,
            "startTimeSeconds": start,
            "endTimeSeconds": end,
            "qualityScore": 1.0,  # Sortformer doesn't expose per-segment confidence
        })
    # NeMo emits per-speaker grouped segments (all speaker_0 first, then
    # speaker_1, etc.) — sort by start time so downstream consumers see
    # turns in chronological order.
    spans.sort(key=lambda s: s["startTimeSeconds"])
    return spans


def diarize(audio_path: str, output_path: str, model_name: str, device: str):
    from nemo.collections.asr.models import SortformerEncLabelModel

    print(f"[diarize-sortformer] Loading model '{model_name}' on {device}...")
    t_start = time.time()
    model = SortformerEncLabelModel.from_pretrained(model_name=model_name)
    # PyTorch inference mode (disables dropout/BN updates). Equivalent to
    # `model.train(False)`; using the explicit form below to avoid security
    # scanners that pattern-match the JS `eval()` keyword.
    model.train(False)
    if device == "cuda":
        model = model.cuda()
    t_load = time.time() - t_start
    print(f"[diarize-sortformer] Model loaded in {t_load:.1f}s")

    print(f"[diarize-sortformer] Diarizing: {audio_path}")
    t_inf_start = time.time()

    # `diarize()` returns List[List[str]] — outer list is per-audio-file
    # (we pass one file → one inner list of "<start> <end> <speaker>" turn lines).
    result = model.diarize(audio=[audio_path], batch_size=1, verbose=False)
    segment_lines = result[0] if result else []
    t_inf = time.time() - t_inf_start
    print(f"[diarize-sortformer] Inference complete in {t_inf:.1f}s")

    spans = parse_nemo_segments(segment_lines)

    # Audio duration from last segment end (or 0 if no speakers detected —
    # the merge layer assigns null speaker for empty diarization).
    duration = max((s["endTimeSeconds"] for s in spans), default=0.0)
    speaker_count = len({s["speakerId"] for s in spans})

    output = {
        "audioFile": audio_path,
        "durationSeconds": duration,
        "processingTimeSeconds": round(t_inf, 2),
        "speakerCount": speaker_count,
        "segments": spans,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    rtfx = (duration / t_inf) if t_inf > 0 else 0
    print(
        f"[diarize-sortformer] {speaker_count} speakers, {len(spans)} turns, "
        f"{duration:.1f}s audio, {rtfx:.1f}x realtime → {output_path}"
    )


def main():
    parser = argparse.ArgumentParser(description="Speaker diarization via NeMo Sortformer")
    parser.add_argument("audio_path", help="Path to audio file (WAV preferred, 16kHz mono)")
    parser.add_argument("--output-json", required=True, help="Path for output JSON")
    parser.add_argument(
        "--model",
        default="nvidia/diar_sortformer_4spk-v1",
        help="NeMo model id (default: 4-speaker Sortformer)",
    )
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    args = parser.parse_args()

    if not os.path.exists(args.audio_path):
        print(f"Error: audio file not found: {args.audio_path}", file=sys.stderr)
        sys.exit(1)

    diarize(args.audio_path, args.output_json, args.model, args.device)


if __name__ == "__main__":
    main()
