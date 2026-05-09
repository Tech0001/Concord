#!/usr/bin/env python3
"""
Parakeet transcription bridge for the YouTube_Ripper pipeline.

Usage:
    transcribe-parakeet.py <audio_path> <output_md_path> [--model nvidia/parakeet-tdt-0.6b-v3] [--device cuda]

Produces the same markdown and JSON metadata shape as transcribe.py, using
NVIDIA NeMo/Parakeet instead of faster-whisper.
"""

import argparse
import gc
import json
import os
import sys
import tempfile
import time
import wave
from typing import Any, Dict, List, Optional, Tuple

# Reduce CUDA fragmentation. Must be set before importing torch.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# Anything longer than this gets transcribed in fixed-size chunks instead of
# one shot. Parakeet's conformer encoder builds an O(L²) attention matrix, so
# a 1-hour file alone tries to allocate ~10 GB and OOMs on most consumer GPUs.
CHUNK_THRESHOLD_SECONDS = 240
CHUNK_DURATION_SECONDS = 180


def format_timestamp(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def get_wav_duration(audio_path: str) -> float:
    try:
        with wave.open(audio_path, "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate()
            return frames / float(rate) if rate else 0.0
    except Exception:
        return 0.0


def get_nested_attr(obj: Any, path: List[str], default: Any = None) -> Any:
    cur = obj
    for key in path:
        if isinstance(cur, dict):
            cur = cur.get(key, default)
        else:
            cur = getattr(cur, key, default)
        if cur is default:
            return default
    return cur


def normalize_hypotheses(raw: Any) -> List[Any]:
    # RNNT-style models may return (best_hypotheses, all_hypotheses).
    if isinstance(raw, tuple) and len(raw) >= 1:
        raw = raw[0]
    if isinstance(raw, list):
        return raw
    return [raw]


def timestamp_seconds(stamp: Dict[str, Any], key: str, time_stride: float) -> Optional[float]:
    if key in stamp:
        return float(stamp[key])
    offset_key = f"{key}_offset"
    if offset_key in stamp:
        return float(stamp[offset_key]) * time_stride
    return None


def normalize_timestamp_stamps(stamps: Any, text_key: str, time_stride: float) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    if not isinstance(stamps, list):
        return result

    for stamp in stamps:
        if not isinstance(stamp, dict):
            continue

        start = timestamp_seconds(stamp, "start", time_stride)
        end = timestamp_seconds(stamp, "end", time_stride)
        text = stamp.get(text_key) or stamp.get("word") or stamp.get("char") or stamp.get("text") or ""

        if start is None or end is None or not str(text).strip():
            continue

        result.append({
            "start": start,
            "end": end,
            "text": str(text).strip(),
        })

    return result


SEGMENT_SOFT_MAX_SECONDS = 35.0


def split_long_segments(
    segments: List[Dict[str, Any]],
    words: List[Dict[str, Any]],
    max_duration: float = SEGMENT_SOFT_MAX_SECONDS,
    max_gap: float = 1.2,
) -> List[Dict[str, Any]]:
    """Re-chunk any segment longer than `max_duration` using its constituent
    word-level timestamps. Parakeet returns nice short segments for normal
    speech, but for prayer / glossolalia / unbroken music it can return one
    segment per audio chunk (~3 minutes). Splitting by word gaps gives the
    transcript readable rows everywhere.
    """
    if not words:
        return segments
    result: List[Dict[str, Any]] = []
    for seg in segments:
        seg_start = float(seg["start"])
        seg_end = float(seg["end"])
        if seg_end - seg_start <= max_duration:
            result.append(seg)
            continue
        # Words whose timing falls inside this segment's window. Tiny tolerance
        # absorbs floating-point boundaries between adjacent segments.
        seg_words = [
            w for w in words
            if float(w["start"]) >= seg_start - 0.05 and float(w["end"]) <= seg_end + 0.05
        ]
        if not seg_words:
            result.append(seg)
            continue
        regrouped = group_words_into_segments(seg_words, max_gap=max_gap, max_duration=max_duration)
        result.extend(regrouped if regrouped else [seg])
    return result


def group_words_into_segments(words: List[Dict[str, Any]], max_gap: float = 1.2, max_duration: float = 30.0) -> List[Dict[str, Any]]:
    segments: List[Dict[str, Any]] = []
    current: List[Dict[str, Any]] = []

    for word in words:
        if not current:
            current = [word]
            continue

        gap = float(word["start"]) - float(current[-1]["end"])
        duration = float(word["end"]) - float(current[0]["start"])
        if gap > max_gap or duration > max_duration:
            segments.append({
                "start": current[0]["start"],
                "end": current[-1]["end"],
                "text": " ".join(w["text"] for w in current),
            })
            current = [word]
        else:
            current.append(word)

    if current:
        segments.append({
            "start": current[0]["start"],
            "end": current[-1]["end"],
            "text": " ".join(w["text"] for w in current),
        })

    return segments


def split_wav_into_chunks(
    audio_path: str,
    chunk_seconds: int,
    output_dir: str,
) -> List[Tuple[str, float]]:
    """Slice a WAV into fixed-duration pieces. Returns (path, start_seconds)
    pairs. Uses the stdlib `wave` module so it works without ffmpeg."""
    chunks: List[Tuple[str, float]] = []
    with wave.open(audio_path, "rb") as wav:
        framerate = wav.getframerate()
        nchannels = wav.getnchannels()
        sampwidth = wav.getsampwidth()
        total_frames = wav.getnframes()
        chunk_frames = int(chunk_seconds * framerate)
        index = 0
        while True:
            start_frame = index * chunk_frames
            if start_frame >= total_frames:
                break
            wav.setpos(start_frame)
            frames = wav.readframes(chunk_frames)
            if not frames:
                break
            chunk_path = os.path.join(output_dir, f"chunk_{index:04d}.wav")
            with wave.open(chunk_path, "wb") as out:
                out.setnchannels(nchannels)
                out.setsampwidth(sampwidth)
                out.setframerate(framerate)
                out.writeframes(frames)
            chunks.append((chunk_path, start_frame / float(framerate)))
            index += 1
    return chunks


def transcribe_one_pass(asr_model: Any, audio_path: str) -> Any:
    try:
        return asr_model.transcribe([audio_path], timestamps=True)
    except TypeError:
        return asr_model.transcribe([audio_path], return_hypotheses=True)


def hypothesis_to_payload(hypothesis: Any, time_stride: float) -> Dict[str, Any]:
    text = getattr(hypothesis, "text", None) or str(hypothesis)
    timestamp_dict = (
        getattr(hypothesis, "timestamp", None)
        or getattr(hypothesis, "timestep", None)
        or {}
    )
    words = normalize_timestamp_stamps(timestamp_dict.get("word"), "word", time_stride)
    segments = normalize_timestamp_stamps(timestamp_dict.get("segment"), "segment", time_stride)
    return {"text": text, "words": words, "segments": segments}


def configure_timestamps(asr_model: Any) -> None:
    try:
        from omegaconf import open_dict

        decoding_cfg = asr_model.cfg.decoding
        with open_dict(decoding_cfg):
            decoding_cfg.preserve_alignments = True
            decoding_cfg.compute_timestamps = True
            # NeMo docs currently spell these as "seperator"; keep both spellings
            # where supported for compatibility across releases.
            decoding_cfg.segment_seperators = [".", "?", "!"]
            decoding_cfg.word_seperator = " "
            decoding_cfg.segment_separators = [".", "?", "!"]
            decoding_cfg.word_separator = " "
            # CUDA graph capture is per-batch and gets corrupted when we call
            # transcribe() repeatedly across audio chunks: the second call
            # crashes inside currentStreamCaptureStatusMayInitCtx with
            # cudaErrorIllegalAddress. Disable graphs to keep chunked
            # transcription stable. Slight perf hit, no correctness change.
            decoding_cfg.allow_cuda_graphs = False
            if "greedy" in decoding_cfg:
                decoding_cfg.greedy.use_cuda_graph_decoder = False
                decoding_cfg.greedy.allow_cuda_graphs = False
        asr_model.change_decoding_strategy(decoding_cfg)
    except Exception as exc:
        print(f"[parakeet] Timestamp decoding config warning: {exc}")


def transcribe(
    audio_path: str,
    output_path: str,
    model_name: str = "nvidia/parakeet-tdt-0.6b-v3",
    device: str = "cuda",
) -> Dict[str, Any]:
    try:
        import nemo.collections.asr as nemo_asr
        import torch
    except ImportError as exc:
        raise RuntimeError(
            "Parakeet requires NVIDIA NeMo. Install it in the venv with: "
            "./venv/bin/pip install 'nemo_toolkit[asr]'"
        ) from exc

    print(f"[parakeet] Loading model '{model_name}'...")
    t_start = time.time()
    asr_model = nemo_asr.models.ASRModel.from_pretrained(model_name)

    if device == "cuda" and torch.cuda.is_available():
        asr_model = asr_model.to("cuda")
    elif device:
        asr_model = asr_model.to(device)

    asr_model.eval()
    configure_timestamps(asr_model)
    t_load = time.time() - t_start
    print(f"[parakeet] Model loaded in {t_load:.1f}s")

    print(f"[parakeet] Transcribing: {audio_path}")
    duration = get_wav_duration(audio_path)
    time_stride = float(get_nested_attr(asr_model, ["cfg", "preprocessor", "window_stride"], 0.01)) * 8.0
    t_trans_start = time.time()

    text_parts: List[str] = []
    words: List[Dict[str, Any]] = []
    segments: List[Dict[str, Any]] = []

    if duration > CHUNK_THRESHOLD_SECONDS:
        chunk_count_estimate = max(1, int(duration // CHUNK_DURATION_SECONDS) + 1)
        print(
            f"[parakeet] Long audio ({duration:.0f}s); transcribing in ~{CHUNK_DURATION_SECONDS}s "
            f"chunks (~{chunk_count_estimate}) to keep GPU memory bounded"
        )
        with tempfile.TemporaryDirectory(prefix="parakeet-chunks-") as tmpdir:
            chunks = split_wav_into_chunks(audio_path, CHUNK_DURATION_SECONDS, tmpdir)
            for index, (chunk_path, chunk_start) in enumerate(chunks, start=1):
                chunk_duration = get_wav_duration(chunk_path)
                print(
                    f"[parakeet] Chunk {index}/{len(chunks)} "
                    f"@ {format_timestamp(chunk_start)} ({chunk_duration:.0f}s)"
                )
                raw_hypotheses = transcribe_one_pass(asr_model, chunk_path)
                hypotheses = normalize_hypotheses(raw_hypotheses)
                hypothesis = hypotheses[0] if hypotheses else ""
                payload = hypothesis_to_payload(hypothesis, time_stride)

                for word in payload["words"]:
                    word["start"] += chunk_start
                    word["end"] += chunk_start
                for segment in payload["segments"]:
                    segment["start"] += chunk_start
                    segment["end"] += chunk_start

                if payload["text"].strip():
                    text_parts.append(payload["text"].strip())
                words.extend(payload["words"])
                segments.extend(payload["segments"])

                # Drop chunk activations between iterations or memory will
                # creep upward across chunks until we OOM anyway.
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.ipc_collect()
                gc.collect()
        text = " ".join(text_parts)
    else:
        raw_hypotheses = transcribe_one_pass(asr_model, audio_path)
        hypotheses = normalize_hypotheses(raw_hypotheses)
        hypothesis = hypotheses[0] if hypotheses else ""
        payload = hypothesis_to_payload(hypothesis, time_stride)
        text = payload["text"]
        words = payload["words"]
        segments = payload["segments"]

    if not segments and words:
        segments = group_words_into_segments(words)
    if not segments:
        segments = [{"start": 0.0, "end": duration, "text": text.strip()}] if text.strip() else []

    # Always split any segment Parakeet returned that's longer than the soft cap.
    segments = split_long_segments(segments, words)

    t_trans = time.time() - t_trans_start
    realtime_factor = round(duration / t_trans, 1) if duration > 0 and t_trans > 0 else 0
    print(f"[parakeet] Transcription complete in {t_trans:.1f}s ({realtime_factor}x realtime)")

    audio_basename = os.path.splitext(os.path.basename(audio_path))[0]
    full_text = text.strip() or " ".join(seg["text"] for seg in segments).strip()

    md_lines = [
        f"# Transcript: {audio_basename}",
        "",
        f"- **Model**: {model_name}",
        "- **Language**: auto",
        f"- **Duration**: {format_timestamp(duration)}",
        f"- **Segments**: {len(segments)}",
        f"- **Transcribed at**: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "---",
        "",
        "## Full Text",
        "",
        full_text,
        "",
        "---",
        "",
        "## Timestamped Segments",
        "",
    ]

    for seg in segments:
        ts = f"[{format_timestamp(float(seg['start']))} -> {format_timestamp(float(seg['end']))}]"
        md_lines.append(f"- {ts} {seg['text']}")

    if words:
        md_lines.extend(["", "---", "", "## Word Timestamps", ""])
        for word in words:
            ts = f"[{format_timestamp(float(word['start']))} -> {format_timestamp(float(word['end']))}]"
            md_lines.append(f"- {ts} {word['text']}")

    md_lines.extend(["", "---", "", "*Generated by YouTube_Ripper pipeline*"])

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines))

    metadata = {
        "schema_version": 2,
        "model": model_name,
        "language": "auto",
        "language_probability": 1,
        "duration_seconds": duration,
        "duration_formatted": format_timestamp(duration),
        "segment_count": len(segments),
        "load_time_seconds": round(t_load, 1),
        "transcription_time_seconds": round(t_trans, 1),
        "realtime_factor": realtime_factor,
        "word_count": len(full_text.split()),
        "text": full_text,
        "segments": segments,
        "words": words,
    }

    json_path = output_path.rsplit(".", 1)[0] + ".json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    print(f"[parakeet] Saved transcript to: {output_path}")
    return metadata


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio to markdown with NVIDIA Parakeet")
    parser.add_argument("audio_path", help="Path to WAV audio file")
    parser.add_argument("output_path", help="Path for output markdown file")
    parser.add_argument("--model", default="nvidia/parakeet-tdt-0.6b-v3", help="NeMo model name")
    parser.add_argument("--device", default="cuda", help="Device: cuda or cpu")
    parser.add_argument("--json", action="store_true", help="Output metadata as JSON to stdout")
    args = parser.parse_args()

    if not os.path.exists(args.audio_path):
        print(f"Error: Audio file not found: {args.audio_path}", file=sys.stderr)
        sys.exit(1)

    try:
        metadata = transcribe(args.audio_path, args.output_path, model_name=args.model, device=args.device)
    except Exception as exc:
        print(f"[parakeet:error] {exc}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(metadata))


if __name__ == "__main__":
    main()
