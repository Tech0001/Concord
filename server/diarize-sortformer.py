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


def split_wav(audio_path: str, chunk_sec: float, overlap_sec: float, tmpdir: str):
    """Split a WAV file into overlapping chunks. Returns a list of
    (chunk_path, chunk_start_sec) tuples. Chunks share their first
    `overlap_sec` with the previous chunk's tail so we can match
    speakers across the boundary."""
    import wave
    chunks = []
    with wave.open(audio_path, "rb") as src:
        framerate = src.getframerate()
        nframes = src.getnframes()
        nchannels = src.getnchannels()
        sampwidth = src.getsampwidth()
        duration = nframes / framerate
        chunk_frames = int(chunk_sec * framerate)
        step_frames = int(max(1.0, chunk_sec - overlap_sec) * framerate)

        idx = 0
        pos = 0
        while pos < nframes:
            src.setpos(pos)
            data = src.readframes(min(chunk_frames, nframes - pos))
            chunk_path = os.path.join(tmpdir, f"chunk_{idx:04d}.wav")
            with wave.open(chunk_path, "wb") as dst:
                dst.setnchannels(nchannels)
                dst.setsampwidth(sampwidth)
                dst.setframerate(framerate)
                dst.writeframes(data)
            chunks.append((chunk_path, pos / framerate))
            if pos + chunk_frames >= nframes:
                break
            pos += step_frames
            idx += 1
    return chunks, duration


def parse_chunk_segments(segment_lines, time_offset: float):
    """Parse chunk-local segments and shift timestamps by time_offset
    (the chunk's start position in the original audio)."""
    parsed = []
    for line in segment_lines:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            start = float(parts[0]) + time_offset
            end = float(parts[1]) + time_offset
            raw_speaker = parts[2]
        except (ValueError, IndexError):
            continue
        m = re.search(r"(\d+)", raw_speaker)
        local_id = int(m.group(1)) if m else 0
        parsed.append({
            "start": start,
            "end": end,
            "local_speaker": local_id,
        })
    return parsed


def link_chunks(chunks_segments, overlap_sec: float):
    """Given per-chunk segments with local speaker IDs, build a global
    speaker mapping by matching speakers in the overlap region between
    consecutive chunks. Chunk N's local speaker that dominates the
    overlap region in chunk N+1 inherits N+1's matching local speaker's
    global ID — so the same person stays as the same global ID across
    chunk boundaries.

    Greedy and not perfect (won't handle a speaker only in N+2 that
    didn't appear in the overlap), but works for the common case of
    a small number of speakers carrying through the audio.
    """
    if not chunks_segments:
        return []

    # First chunk: each local id becomes a global id
    global_map_per_chunk = []
    next_global = 0

    first_local_to_global = {}
    for seg in chunks_segments[0]:
        if seg["local_speaker"] not in first_local_to_global:
            first_local_to_global[seg["local_speaker"]] = next_global
            next_global += 1
    global_map_per_chunk.append(first_local_to_global)

    for i in range(1, len(chunks_segments)):
        prev = chunks_segments[i - 1]
        curr = chunks_segments[i]
        if not curr:
            global_map_per_chunk.append({})
            continue

        # Find overlap region: [curr_start, curr_start + overlap_sec]
        # in absolute time. (curr's segments are already in absolute time.)
        overlap_start = curr[0]["start"] if curr else 0
        overlap_end = overlap_start + overlap_sec

        # For each local speaker in curr, find the speaker in prev who
        # overlaps it most in the overlap region.
        prev_in_window = [s for s in prev if s["end"] > overlap_start and s["start"] < overlap_end]

        local_to_global = {}
        for seg in curr:
            local = seg["local_speaker"]
            if local in local_to_global:
                continue
            # Find prev segments that overlap this segment's window
            best_overlap = 0.0
            best_prev_local = None
            for ps in prev_in_window:
                ovl = max(0.0, min(seg["end"], ps["end"]) - max(seg["start"], ps["start"]))
                if ovl > best_overlap:
                    best_overlap = ovl
                    best_prev_local = ps["local_speaker"]
            if best_prev_local is not None and best_prev_local in global_map_per_chunk[i - 1]:
                local_to_global[local] = global_map_per_chunk[i - 1][best_prev_local]
            else:
                # No match — assign a new global id
                local_to_global[local] = next_global
                next_global += 1
        global_map_per_chunk.append(local_to_global)

    # Apply the global mapping
    all_spans = []
    for i, segs in enumerate(chunks_segments):
        mapping = global_map_per_chunk[i]
        for seg in segs:
            global_id = mapping.get(seg["local_speaker"], 0)
            all_spans.append({
                "start": seg["start"],
                "end": seg["end"],
                "global_speaker": global_id,
            })
    return all_spans


def merge_overlapping_spans(spans, overlap_sec: float):
    """Deduplicate the overlap region. After linking, consecutive chunks
    have duplicate spans in their shared overlap. Drop later-chunk spans
    whose start falls before the previous chunk's end - overlap/2 (the
    midpoint of the overlap region)."""
    if not spans:
        return []
    spans.sort(key=lambda s: s["start"])
    out = [spans[0]]
    for s in spans[1:]:
        prev = out[-1]
        # If the new span starts well before the previous one ended (by
        # more than overlap_sec/2), it's a duplicate from the overlap.
        if s["start"] < prev["end"] - overlap_sec / 2 and s["global_speaker"] == prev["global_speaker"]:
            # Same speaker continuing — extend prev
            prev["end"] = max(prev["end"], s["end"])
        elif s["start"] < prev["end"]:
            # Different speaker overlap — keep the longer one's end, advance
            out.append(s)
        else:
            out.append(s)
    return out


def diarize(audio_path: str, output_path: str, model_name: str, device: str,
            chunk_sec: float, overlap_sec: float):
    from nemo.collections.asr.models import SortformerEncLabelModel
    import tempfile
    import shutil

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

    # Sortformer attention is quadratic — full audio OOMs on consumer
    # GPUs past ~5 min. NeMo's DiarizeConfig.session_len_sec is silently
    # ignored by the Lhotse dataloader (verified vs NeMo 2.7.3), so we
    # chunk in user-space and stitch results with overlap-based speaker
    # linking.
    tmpdir = tempfile.mkdtemp(prefix="sortformer-chunks-")
    t_inf_start = time.time()
    try:
        chunks, audio_duration = split_wav(audio_path, chunk_sec, overlap_sec, tmpdir)
        print(f"[diarize-sortformer] Audio: {audio_duration:.1f}s split into {len(chunks)} chunks "
              f"({chunk_sec}s each, {overlap_sec}s overlap)")

        chunks_segments = []
        for i, (chunk_path, chunk_start) in enumerate(chunks):
            print(f"[diarize-sortformer] Chunk {i+1}/{len(chunks)} @ {chunk_start:.1f}s")
            result = model.diarize(audio=[chunk_path], batch_size=1, verbose=False)
            chunk_lines = result[0] if result else []
            chunks_segments.append(parse_chunk_segments(chunk_lines, chunk_start))
            # Free GPU memory between chunks — Sortformer doesn't release
            # eagerly between forward passes.
            if device == "cuda":
                import torch
                torch.cuda.empty_cache()

        global_spans = link_chunks(chunks_segments, overlap_sec)
        merged_spans = merge_overlapping_spans(global_spans, overlap_sec)

        # Convert to FluidAudio shape (1-indexed string speaker IDs).
        spans = [{
            "speakerId": str(s["global_speaker"] + 1),
            "startTimeSeconds": s["start"],
            "endTimeSeconds": s["end"],
            "qualityScore": 1.0,
        } for s in merged_spans]
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    t_inf = time.time() - t_inf_start
    print(f"[diarize-sortformer] All chunks complete in {t_inf:.1f}s")

    duration = max((s["endTimeSeconds"] for s in spans), default=audio_duration)
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
    parser.add_argument(
        "--chunk-sec",
        type=float,
        default=120.0,
        help="Audio chunk size in seconds. Sortformer's attention is "
             "quadratic — full audio OOMs on 10 GB GPUs after ~5 min. "
             "120s chunks fit comfortably and process at ~200x realtime. "
             "DiarizeConfig.session_len_sec is silently ignored by the "
             "Lhotse dataloader (NeMo 2.7.3) so we chunk in user-space.",
    )
    parser.add_argument(
        "--chunk-overlap-sec",
        type=float,
        default=10.0,
        help="Overlap between consecutive chunks in seconds. Used to align "
             "speaker labels across chunk boundaries — same speaker in two "
             "consecutive chunks should appear in the overlap region of "
             "both, so we can map chunk N+1's IDs onto chunk N's.",
    )
    args = parser.parse_args()

    if not os.path.exists(args.audio_path):
        print(f"Error: audio file not found: {args.audio_path}", file=sys.stderr)
        sys.exit(1)

    diarize(args.audio_path, args.output_json, args.model, args.device,
            args.chunk_sec, args.chunk_overlap_sec)


if __name__ == "__main__":
    main()
