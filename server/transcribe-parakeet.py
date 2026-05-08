#!/usr/bin/env python3
"""
Parakeet transcription bridge for the YouTube_Ripper pipeline.

Usage:
    transcribe-parakeet.py <audio_path> <output_md_path> [--model nvidia/parakeet-tdt-0.6b-v3] [--device cuda]

Produces the same markdown and JSON metadata shape as transcribe.py, using
NVIDIA NeMo/Parakeet instead of faster-whisper.
"""

import argparse
import json
import os
import sys
import time
import wave
from typing import Any, Dict, List, Optional


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
    t_trans_start = time.time()

    try:
        raw_hypotheses = asr_model.transcribe([audio_path], timestamps=True)
    except TypeError:
        raw_hypotheses = asr_model.transcribe([audio_path], return_hypotheses=True)

    hypotheses = normalize_hypotheses(raw_hypotheses)
    hypothesis = hypotheses[0] if hypotheses else ""
    text = getattr(hypothesis, "text", None) or str(hypothesis)

    timestamp_dict = (
        getattr(hypothesis, "timestamp", None)
        or getattr(hypothesis, "timestep", None)
        or {}
    )

    time_stride = float(get_nested_attr(asr_model, ["cfg", "preprocessor", "window_stride"], 0.01)) * 8.0
    words = normalize_timestamp_stamps(timestamp_dict.get("word"), "word", time_stride)
    segments = normalize_timestamp_stamps(timestamp_dict.get("segment"), "segment", time_stride)
    if not segments and words:
        segments = group_words_into_segments(words)
    if not segments:
        segments = [{"start": 0.0, "end": duration, "text": text.strip()}] if text.strip() else []

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
