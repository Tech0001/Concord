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


def dedup_overlap_turns(chunks_segments, chunk_starts, overlap_sec):
    """Concatenate per-chunk turns into a global timeline, dropping the
    overlap-region duplicates. For chunk i (i>0), we keep prev chunk's
    view of the [chunk_starts[i], chunk_starts[i] + overlap_sec] window
    and discard curr's duplicate turns there. Turns straddling the
    boundary get clipped to start at overlap_end. Result is a single
    timeline with no gaps and no duplicates.
    """
    out = []
    for i, turns in enumerate(chunks_segments):
        if i == 0:
            for t in turns:
                out.append({"start": t["start"], "end": t["end"]})
        else:
            overlap_end = chunk_starts[i] + overlap_sec
            for t in turns:
                if t["start"] >= overlap_end:
                    out.append({"start": t["start"], "end": t["end"]})
                elif t["end"] > overlap_end:
                    out.append({"start": overlap_end, "end": t["end"]})
                # else: fully inside overlap — drop (prev chunk has it)
    out.sort(key=lambda t: t["start"])
    return out


def merge_minor_speakers(turns, embeddings, min_airtime_sec: float = 5.0):
    """Post-process pass to merge low-airtime "speakers" into the major
    speakers they're acoustically closest to. Sortformer + TitaNet on long
    audio with diverse content (intro music, ads, voiceovers) tends to
    spawn brief spurious speakers — turns that genuinely have a different
    acoustic signature from the main voices but don't represent a real
    new person joining the conversation.

    For each speaker with less than `min_airtime_sec` total speaking time,
    compute its centroid embedding (averaging across its turns) and
    reassign all of its turns to the major speaker whose centroid is
    closest by cosine distance. If a minor speaker has no embeddings
    (only sub-second turns assigned via continuation), reassign to the
    largest major speaker by airtime as a sensible default.

    Mutates `turns` in place. Then renumbers speaker IDs densely starting
    from 0 so the final output doesn't have ID gaps.
    """
    import numpy as np

    # Accumulate per-speaker airtime and centroid embedding
    speaker_time = {}
    speaker_emb_sum = {}
    speaker_emb_count = {}
    for turn, emb in zip(turns, embeddings):
        sid = turn["global_speaker"]
        speaker_time[sid] = speaker_time.get(sid, 0.0) + (turn["end"] - turn["start"])
        if emb is not None:
            if sid not in speaker_emb_sum:
                speaker_emb_sum[sid] = emb.astype(np.float32).copy()
                speaker_emb_count[sid] = 1
            else:
                speaker_emb_sum[sid] += emb.astype(np.float32)
                speaker_emb_count[sid] += 1

    centroids = {
        sid: (s / speaker_emb_count[sid]) for sid, s in speaker_emb_sum.items()
    }
    norms = {
        sid: c / (np.linalg.norm(c) + 1e-12) for sid, c in centroids.items()
    }

    major_ids = {sid for sid, t in speaker_time.items() if t >= min_airtime_sec}
    minor_ids = {sid for sid, t in speaker_time.items() if t < min_airtime_sec}

    if not major_ids or not minor_ids:
        # Nothing to merge (everyone meets threshold OR no one does).
        # In the second case, leave as-is rather than collapsing real speakers.
        renumber_speakers(turns)
        return

    # For each minor, find closest major by centroid; fall back to largest
    # major when the minor has no embedding to compare with.
    largest_major = max(major_ids, key=lambda m: speaker_time[m])
    remap = {}
    for sid in minor_ids:
        if sid in norms:
            best_dist = float("inf")
            best_major = None
            for mid in major_ids:
                if mid not in norms:
                    continue
                dist = 1.0 - float(np.dot(norms[sid], norms[mid]))
                if dist < best_dist:
                    best_dist = dist
                    best_major = mid
            remap[sid] = best_major if best_major is not None else largest_major
        else:
            remap[sid] = largest_major

    for turn in turns:
        if turn["global_speaker"] in remap:
            turn["global_speaker"] = remap[turn["global_speaker"]]

    renumber_speakers(turns)


def renumber_speakers(turns):
    """Densely renumber speaker IDs starting from 0 in order of first
    appearance, so output doesn't have gaps like S0, S2, S5."""
    seen = {}
    for turn in turns:
        sid = turn["global_speaker"]
        if sid not in seen:
            seen[sid] = len(seen)
        turn["global_speaker"] = seen[sid]


class SpeakerManager:
    """Greedy embedding-based speaker assignment, mirroring FluidAudio's
    SpeakerManager (Sources/FluidAudio/Diarizer/Clustering/) approach:

      - For each new turn embedding, compute cosine distance to every
        known speaker's running centroid.
      - If closest distance <= threshold (FluidAudio default: 0.65),
        assign to that speaker and update its centroid as a count-weighted
        running average.
      - Otherwise, create a new speaker with this embedding as the seed.

    Cosine distance = 1 - cos_similarity, range [0, 2]. Threshold 0.65
    corresponds to similarity ~0.35 — fairly permissive, which is
    appropriate for diarization (false-merges are usually less harmful
    than false-splits for downstream UX).

    Updates the centroid as a weighted average of all observed embeddings
    for that speaker (rather than just the most recent), so brief audio
    artifacts don't drift a speaker's reference voice.
    """

    def __init__(self, threshold: float = 0.65):
        import numpy as np
        self.np = np
        self.threshold = threshold
        self.centroids = []  # list of np.ndarray (192-dim normalized)
        self.counts = []

    def assign(self, embedding):
        np = self.np
        if embedding is None:
            return 0
        emb = np.asarray(embedding, dtype=np.float32)
        emb_norm = emb / (np.linalg.norm(emb) + 1e-12)

        if not self.centroids:
            self.centroids.append(emb_norm.copy())
            self.counts.append(1)
            return 0

        # Cosine distance to every existing centroid (already normalized).
        best_dist = float("inf")
        best_id = -1
        for i, c in enumerate(self.centroids):
            dist = 1.0 - float(np.dot(emb_norm, c))
            if dist < best_dist:
                best_dist = dist
                best_id = i

        if best_dist <= self.threshold:
            # Weighted moving average; renormalize so future cosines stay valid.
            n = self.counts[best_id]
            new_centroid = (self.centroids[best_id] * n + emb_norm) / (n + 1)
            new_centroid = new_centroid / (np.linalg.norm(new_centroid) + 1e-12)
            self.centroids[best_id] = new_centroid
            self.counts[best_id] = n + 1
            return best_id

        # No match — new speaker.
        self.centroids.append(emb_norm.copy())
        self.counts.append(1)
        return len(self.centroids) - 1

    @property
    def speaker_count(self) -> int:
        return len(self.centroids)


def extract_turn_embeddings(waveform, sample_rate, turns, titanet, device, min_turn_sec: float = 0.75):
    """Extract a 192-dim TitaNet embedding for each turn. Slices the
    pre-loaded waveform tensor (no per-turn disk I/O); each slice runs
    through the model in a tight inference-mode loop.

    Skips turns shorter than `min_turn_sec` (default 0.75s). TitaNet
    needs ~1s of audio to produce a stable speaker embedding — sub-second
    snippets just give noise that doesn't cluster reliably with anyone,
    creating spurious "speakers." Caller assigns those short turns to a
    surrounding speaker via context.

    Returns a list of np.ndarray (or None for skipped/too-short turns,
    same length as `turns` so callers can zip).
    """
    import torch
    import numpy as np

    embeddings = []
    min_samples = int(min_turn_sec * sample_rate)

    with torch.inference_mode():
        for turn in turns:
            start_sample = int(turn["start"] * sample_rate)
            end_sample = int(turn["end"] * sample_rate)
            if end_sample - start_sample < min_samples:
                embeddings.append(None)
                continue
            slice_ = waveform[start_sample:end_sample].unsqueeze(0)
            if device == "cuda":
                slice_ = slice_.cuda(non_blocking=True)
            length = torch.tensor([slice_.shape[1]], device=slice_.device, dtype=torch.long)
            _, emb = titanet.forward(input_signal=slice_, input_signal_length=length)
            embeddings.append(emb.squeeze(0).detach().cpu().numpy().astype(np.float32))

    return embeddings


def diarize(audio_path: str, output_path: str, model_name: str, device: str,
            chunk_sec: float, overlap_sec: float, embedding_threshold: float):
    from nemo.collections.asr.models import SortformerEncLabelModel, EncDecSpeakerLabelModel
    import tempfile
    import shutil
    import wave
    import torch
    import numpy as np

    # ---- Load Sortformer (turn detection) + TitaNet (speaker embeddings) ----
    # Sortformer outputs WHEN people speak; TitaNet identifies WHO each turn is
    # by extracting speaker embeddings that we cluster across the full audio.
    # This mirrors FluidAudio's architecture on Mac (Sortformer + their own
    # SpeakerManager clustering layer) and gives consistent global speaker IDs
    # even when the same person disappears for entire chunks and reappears.
    print(f"[diarize-sortformer] Loading models on {device}...")
    t_start = time.time()
    sortformer = SortformerEncLabelModel.from_pretrained(model_name=model_name)
    sortformer.train(False)  # `.eval()` rewritten — JS-eval scanners trip on the literal
    titanet = EncDecSpeakerLabelModel.from_pretrained(model_name="titanet_large")
    titanet.train(False)
    if device == "cuda":
        sortformer = sortformer.cuda()
        titanet = titanet.cuda()
    t_load = time.time() - t_start
    print(f"[diarize-sortformer] Models loaded in {t_load:.1f}s")

    # Load full audio once for in-memory slicing during embedding extraction
    # — avoids per-turn disk I/O. Use stdlib `wave` + numpy (torchaudio isn't
    # in the parakeet venv and would pull in another ~300MB dep tree).
    # Concord's audio extract always produces 16kHz mono PCM16 WAV, so we
    # assume that and error out clearly otherwise.
    with wave.open(audio_path, "rb") as wf:
        sr = wf.getframerate()
        nframes = wf.getnframes()
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        raw = wf.readframes(nframes)
    if sr != 16000 or nchannels != 1 or sampwidth != 2:
        raise RuntimeError(
            f"Expected 16kHz mono PCM16 WAV; got sr={sr} channels={nchannels} "
            f"sampwidth={sampwidth}. Concord's audio extract should produce "
            f"this format — check the upstream ffmpeg invocation."
        )
    audio_np = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    waveform = torch.from_numpy(audio_np)  # (samples,)

    # Sortformer attention is quadratic — full audio OOMs on consumer GPUs past
    # ~5 min. NeMo's DiarizeConfig.session_len_sec is silently ignored by the
    # Lhotse dataloader (verified vs NeMo 2.7.3), so we chunk in user-space.
    # Speaker linking happens via TitaNet embeddings on the merged turn list,
    # NOT by chunk-overlap matching (which can't track speakers that disappear
    # across chunk boundaries).
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
            result = sortformer.diarize(audio=[chunk_path], batch_size=1, verbose=False)
            chunk_lines = result[0] if result else []
            chunks_segments.append(parse_chunk_segments(chunk_lines, chunk_start))
            if device == "cuda":
                torch.cuda.empty_cache()

        # Concatenate all chunks into a single timeline; drop overlap-region
        # duplicates. We don't care about chunk-local speaker IDs anymore —
        # TitaNet + clustering will assign final globals.
        turns = dedup_overlap_turns(chunks_segments, chunk_starts, overlap_sec)
        print(f"[diarize-sortformer] {len(turns)} turns after dedup; extracting embeddings...")

        # Free Sortformer's VRAM before loading TitaNet's tensors.
        if device == "cuda":
            torch.cuda.empty_cache()

        t_emb_start = time.time()
        embeddings = extract_turn_embeddings(waveform, sr, turns, titanet, device)
        t_emb = time.time() - t_emb_start
        print(f"[diarize-sortformer] Extracted {sum(1 for e in embeddings if e is not None)} "
              f"embeddings in {t_emb:.1f}s")

        # Greedy clustering — assigns each turn to an existing speaker if
        # cosine distance < threshold, else creates a new speaker. Threshold
        # 0.65 matches FluidAudio's SpeakerManager default.
        # For sub-second turns (no embedding), assign the previous turn's
        # speaker as a continuation — almost always the same person briefly
        # pausing or interjecting. Falls back to "speaker 0" if there's no
        # prior speaker yet (audio starts with a tiny artifact).
        manager = SpeakerManager(threshold=embedding_threshold)
        last_speaker = 0
        for turn, emb in zip(turns, embeddings):
            if emb is None:
                turn["global_speaker"] = last_speaker
            else:
                last_speaker = manager.assign(emb)
                turn["global_speaker"] = last_speaker

        # Final cleanup: merge low-airtime spurious speakers into the closest
        # major speaker by centroid similarity. Sortformer + TitaNet still
        # spawn brief noise speakers (intro music, voice-quality changes)
        # that aren't real distinct people — collapse them.
        merge_minor_speakers(turns, embeddings, min_airtime_sec=5.0)

        # Convert to FluidAudio shape (1-indexed string speaker IDs).
        spans = [{
            "speakerId": str(t["global_speaker"] + 1),
            "startTimeSeconds": t["start"],
            "endTimeSeconds": t["end"],
            "qualityScore": 1.0,
        } for t in turns]
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
        help="Overlap between consecutive Sortformer chunks in seconds. Used "
             "for clean dedup at chunk boundaries (the embedding clustering "
             "handles cross-chunk speaker linking — overlap doesn't need to "
             "be large for that).",
    )
    parser.add_argument(
        "--embedding-threshold",
        type=float,
        default=0.65,
        help="Cosine distance threshold for matching a turn embedding to an "
             "existing speaker. Below threshold = same speaker; above = new "
             "speaker. Default 0.65 matches FluidAudio's SpeakerManager.",
    )
    args = parser.parse_args()

    if not os.path.exists(args.audio_path):
        print(f"Error: audio file not found: {args.audio_path}", file=sys.stderr)
        sys.exit(1)

    diarize(args.audio_path, args.output_json, args.model, args.device,
            args.chunk_sec, args.chunk_overlap_sec, args.embedding_threshold)


if __name__ == "__main__":
    main()
