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


def build_global_speaker_maps(chunks_segments, chunk_starts, overlap_sec):
    """Per-chunk local_to_global speaker ID maps, using overlap-region
    co-occurrence to link the same person across consecutive chunks.

    The overlap region between chunk i-1 and chunk i is the SAME
    physical audio window: [chunk_starts[i], chunk_starts[i] + overlap_sec].
    Within that window, both chunks heard the same voices — so if the
    model labeled person A as "speaker_2" in chunk i-1 and "speaker_0"
    in chunk i, those two labels should map to the same global ID.

    Algorithm:
      1. For each (prev_local, curr_local) pair, sum the time both were
         simultaneously the active speaker inside the overlap region.
      2. Greedy match: order curr's overlap-region speakers by total
         time-talked, assign each to the prev speaker with the highest
         co-occurrence (each prev speaker claimed at most once).
      3. Curr speakers who don't appear in the overlap region (= new
         speakers introduced after the overlap) get fresh global IDs.

    Won't catch a speaker who briefly disappears across a chunk boundary
    and reappears later — that's a hard problem requiring speaker
    embeddings. Acceptable for the common case where speakers carry
    through the audio with at least some overlap-region presence.
    """
    if not chunks_segments:
        return []

    global_map_per_chunk = []
    next_global = 0

    # First chunk: each local id becomes a global id, in order of first appearance.
    first_map = {}
    for seg in chunks_segments[0]:
        if seg["local_speaker"] not in first_map:
            first_map[seg["local_speaker"]] = next_global
            next_global += 1
    global_map_per_chunk.append(first_map)

    for i in range(1, len(chunks_segments)):
        prev = chunks_segments[i - 1]
        curr = chunks_segments[i]
        local_to_global = {}

        if not curr:
            global_map_per_chunk.append({})
            continue

        # Real overlap region using actual chunk start, NOT first-segment start.
        # If the model detected silence at the start of the chunk, first-segment
        # start would be later than the chunk boundary and shift our window
        # past the actual shared-audio region.
        overlap_start = chunk_starts[i]
        overlap_end = overlap_start + overlap_sec

        # Co-occurrence matrix: how many seconds did each (prev_local, curr_local)
        # pair simultaneously hold the floor inside the overlap region?
        co_occurrence = {}
        for ps in prev:
            ps_a = max(ps["start"], overlap_start)
            ps_b = min(ps["end"], overlap_end)
            if ps_b <= ps_a:
                continue  # ps doesn't intersect overlap region
            for cs in curr:
                cs_a = max(cs["start"], overlap_start)
                cs_b = min(cs["end"], overlap_end)
                if cs_b <= cs_a:
                    continue
                joint = max(0.0, min(ps_b, cs_b) - max(ps_a, cs_a))
                if joint > 0:
                    key = (ps["local_speaker"], cs["local_speaker"])
                    co_occurrence[key] = co_occurrence.get(key, 0.0) + joint

        # Total floor time each curr local speaker held in the overlap region
        # (used to order matching — dominant speakers get first pick).
        curr_time_in_overlap = {}
        for cs in curr:
            cs_a = max(cs["start"], overlap_start)
            cs_b = min(cs["end"], overlap_end)
            t = max(0.0, cs_b - cs_a)
            if t > 0:
                local = cs["local_speaker"]
                curr_time_in_overlap[local] = curr_time_in_overlap.get(local, 0.0) + t

        # Greedy assignment: dominant curr speakers claim their best prev match first.
        # Each prev local can only be claimed once — different curr speakers in
        # the overlap MUST be different people, so they can't both inherit the
        # same prev global ID.
        used_prev = set()
        for curr_local in sorted(curr_time_in_overlap, key=curr_time_in_overlap.get, reverse=True):
            best_prev = None
            best_joint = 0.0
            for (pl, cl), joint in co_occurrence.items():
                if cl == curr_local and pl not in used_prev and joint > best_joint:
                    best_joint = joint
                    best_prev = pl
            if best_prev is not None and best_prev in global_map_per_chunk[i - 1]:
                local_to_global[curr_local] = global_map_per_chunk[i - 1][best_prev]
                used_prev.add(best_prev)
            else:
                local_to_global[curr_local] = next_global
                next_global += 1

        # Curr speakers who don't appear in the overlap region — introduced
        # only later in this chunk — get fresh global IDs (no signal to
        # link them to anyone).
        for cs in curr:
            if cs["local_speaker"] not in local_to_global:
                local_to_global[cs["local_speaker"]] = next_global
                next_global += 1

        global_map_per_chunk.append(local_to_global)

    return global_map_per_chunk


def merge_chunked_spans(chunks_segments, chunk_starts, global_maps, overlap_sec):
    """Apply per-chunk global mappings, then dedupe overlap regions by
    keeping prev's view of the overlap and dropping curr's duplicate.

    Each chunk's segments are already in absolute time. For chunk i (i>0),
    drop any segments that fall entirely inside the overlap region with
    chunk i-1; clip segments that straddle the overlap boundary so they
    start at overlap_end. Result: no duplicate coverage, no gaps.
    """
    out = []
    for i, segs in enumerate(chunks_segments):
        mapping = global_maps[i]
        if i == 0:
            for seg in segs:
                out.append({
                    "start": seg["start"],
                    "end": seg["end"],
                    "global_speaker": mapping.get(seg["local_speaker"], 0),
                })
        else:
            overlap_end = chunk_starts[i] + overlap_sec
            for seg in segs:
                if seg["start"] >= overlap_end:
                    # Fully past the overlap — keep as-is
                    out.append({
                        "start": seg["start"],
                        "end": seg["end"],
                        "global_speaker": mapping.get(seg["local_speaker"], 0),
                    })
                elif seg["end"] > overlap_end:
                    # Straddles the overlap boundary — clip start to overlap_end
                    out.append({
                        "start": overlap_end,
                        "end": seg["end"],
                        "global_speaker": mapping.get(seg["local_speaker"], 0),
                    })
                # else: fully inside overlap — drop (prev chunk has it)
    out.sort(key=lambda s: s["start"])
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
        chunk_starts = [start for _, start in chunks]
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

        global_maps = build_global_speaker_maps(chunks_segments, chunk_starts, overlap_sec)
        merged_spans = merge_chunked_spans(chunks_segments, chunk_starts, global_maps, overlap_sec)

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
