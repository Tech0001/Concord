#!/usr/bin/env python3
"""Native multilingual ASR and turn detection, with Concord's existing voice grouping."""
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import time
import wave


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def wav_duration(path):
    with wave.open(str(path), 'rb') as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (16000, 1, 2):
            raise ValueError('Expected mono 16 kHz PCM16 WAV')
        return w.getnframes() / w.getframerate()


def normalized_words(raw, offset, duration):
    words = []
    for item in raw['words']:
        start, end = float(item['start']), float(item['end'])
        if not all(math.isfinite(v) for v in (start, end)) or end < start:
            raise ValueError('Native ASR returned an invalid word interval')
        # Streaming flush can emit padding beyond the chunk. Do not attach
        # those words to the next chunk or to a speaker outside the recording.
        if start >= duration or end <= 0:
            continue
        word = {'start': offset + max(0, start), 'end': offset + min(duration, end), 'text': item['word']}
        if not words or word != words[-1]:
            words.append(word)
    return words


class NativeTurnDetector:
    def __init__(self, binary, model, device, output):
        self.binary, self.model, self.device, self.output = binary, model, device, output
        self.ready = False

    def diarize(self, audio, batch_size, verbose):
        if not self.ready:
            command = [self.binary, 'diarize', str(Path(audio[0]).parent), '--model', self.model,
                       '--device', self.device, '--format', 'json', '--output-dir', str(self.output),
                       '--concurrency', '1', '--no-batching']
            for key, value in {'chunk':340, 'right_context':40, 'left_context':0,
                               'fifo':40, 'spkcache':264, 'update_period':300}.items():
                command += ['--diar.' + key, str(value)]
            subprocess.run(command, check=True)
            self.ready = True
        results = []
        for source in audio:
            raw = json.loads((self.output / (Path(source).stem + '.json')).read_text())
            results.append([f"{s['start']} {s['end']} speaker_{int(s['speaker'])-1}"
                            for s in sorted(raw['segments'], key=lambda s: (int(s['speaker']), s['start']))])
        return results


def run(args):
    bridge = module('transcribe-parakeet')
    duration = wav_duration(args.audio)
    if duration <= 0:
        raise ValueError('Empty recording')
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='concord-nemo-') as directory:
        folder = Path(directory)
        # Same 180-second outer chunks as the existing Concord pipeline.
        # Use stdlib WAV I/O so packaged operation needs no external ffmpeg here.
        if duration > bridge.CHUNK_THRESHOLD_SECONDS:
            chunks, _ = module('diarize-sortformer').split_wav(args.audio, 180, 0, directory)
            input_path = folder
        else:
            chunks = [(args.audio, 0)]
            input_path = Path(args.audio)
        raw_dir = folder/'raw'
        raw_dir.mkdir()
        command = [args.runtime, 'transcribe', str(input_path), '--model', args.asr_model,
                   '--device', args.device, '--language', args.language, '--stream',
                   '--asr.streaming.rnnt_right_context', '13', '--format', 'json', '--no-batching']
        if input_path.is_dir():
            command += ['--output-dir', str(raw_dir), '--concurrency', '1']
        else:
            command += ['--output', str(raw_dir/(input_path.stem + '.json'))]
        print('[nemo] Transcribing with Nemotron 3.5 multilingual', flush=True)
        subprocess.run(command, check=True)
        words = []
        for source, offset in chunks:
            raw = json.loads((raw_dir/(Path(source).stem + '.json')).read_text())
            words.extend(normalized_words(raw, offset, wav_duration(source)))
        text = ' '.join(w['text'] for w in words)
        segments = bridge.split_long_segments(bridge.group_words_into_segments(words), words)
        elapsed = time.monotonic() - started
        result = dict(schema_version=2, model='nvidia/nemotron-3.5-asr-streaming-0.6b',
                      language=args.language, language_probability=1.0 if args.language != 'auto' else 0.0,
                      duration_seconds=duration, duration_formatted=bridge.format_timestamp(duration),
                      load_time_seconds=0, transcription_time_seconds=round(elapsed, 2),
                      realtime_factor=round(duration / elapsed, 2), word_count=len(words),
                      segment_count=len(segments), text=text, words=words, segments=segments)
        Path(args.output_json).write_text(json.dumps(result, indent=2))
        if args.diar_output:
            print('[nemo] Detecting turns and linking speaker identities across chunks', flush=True)
            diar_dir = folder/'diar'
            diar_dir.mkdir()
            detector = NativeTurnDetector(args.runtime, args.diar_model, args.device, diar_dir)
            module('diarize-sortformer').diarize(args.audio, args.diar_output, args.diar_model,
                args.embedding_device, 120, 10, .65, turn_detector=detector)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('audio')
    p.add_argument('--output-json', required=True)
    p.add_argument('--runtime', required=True)
    p.add_argument('--asr-model', required=True)
    p.add_argument('--diar-model', required=True)
    p.add_argument('--diar-output')
    p.add_argument('--device', default='cpu')
    p.add_argument('--embedding-device', choices=['cpu','cuda'], default='cpu')
    p.add_argument('--language', default='en-US')
    run(p.parse_args())
