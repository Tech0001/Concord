#!/usr/bin/env python3
"""Compare native Parakeet with Concord's current transcription in the lab."""
import argparse
import importlib.util
import json
from pathlib import Path
import time
import uuid

import lab

MODEL = 'nvidia/parakeet-tdt-0.6b-v3'
MODEL_REVISION = '541d1f99c6b0c3cd0b11a95167540bb8edefd82b'
MODEL_SHA256 = 'e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e'
PIPELINE = Path(__file__).resolve().parents[2] / 'server/transcription-engines/transcribe-parakeet.py'


def bridge_module():
    spec = importlib.util.spec_from_file_location('existing_parakeet', PIPELINE)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    return bridge


def normalized_result(raw_chunks, duration, bridge):
    words, texts = [], []
    for offset, raw in raw_chunks:
        texts.append(raw['text'].strip())
        words.extend({'start': w['start'] + offset, 'end': w['end'] + offset, 'text': w['word']}
                     for w in raw['words'])
    # Use Concord's existing fallback grouping and long-segment handling.
    segments = bridge.group_words_into_segments(words)
    segments = bridge.split_long_segments(segments, words)
    text = ' '.join(t for t in texts if t)
    return {'schema_version': 2, 'model': MODEL, 'language': 'auto',
            'duration_seconds': duration, 'duration_formatted': bridge.format_timestamp(duration),
            'text': text, 'words': words, 'segments': segments,
            'segment_count': len(segments), 'word_count': len(text.split())}


def run(args):
    db, root = lab.connect_lab(args.root)
    audio = args.audio.expanduser().resolve(strict=True)
    bridge = bridge_module()
    duration = bridge.get_wav_duration(str(audio))
    if duration <= 0:
        raise ValueError('Use a nonempty mono 16 kHz PCM WAV')
    run_id = f'{audio.stem}-{args.engine}-{args.device.replace(":", "-")}-{uuid.uuid4().hex[:8]}'
    folder = root / 'asr' / 'runs' / run_id
    folder.mkdir(parents=True)
    config = {'audio': str(audio), 'audio_sha256': lab.sha256(audio),
              'duration_seconds': duration, 'engine': args.engine, 'device': args.device,
              'model': MODEL, 'pipeline_sha256': lab.sha256(PIPELINE),
              'chunk_threshold_seconds': bridge.CHUNK_THRESHOLD_SECONDS,
              'chunk_duration_seconds': bridge.CHUNK_DURATION_SECONDS,
              'cpu_threads': 8}
    db.execute('''CREATE TABLE IF NOT EXISTS asr_runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, config TEXT NOT NULL, metrics TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    with db:
        db.execute('INSERT INTO asr_runs(id,status,config) VALUES(?,?,?)',
                   (run_id, 'running', json.dumps(config)))
    started = time.monotonic()
    chunks = []
    try:
        if args.engine == 'native':
            binary = lab.CACHE/'NeMo-Speech.cpp/build-asr-lab/bin/nemo-speech'
            model = lab.CACHE/'models/parakeet-v3/parakeet-tdt-0.6b-v3.q8_0.gguf'
            if lab.sha256(model) != MODEL_SHA256:
                raise ValueError('Model hash differs from the pinned official artifact')
            config.update({'runtime_sha256': lab.sha256(binary),
                           'runtime_revision': lab.RUNTIME_REVISION,
                           'model_revision': MODEL_REVISION, 'model_sha256': MODEL_SHA256,
                           'quantization': 'Q8_0'})
            input_path = audio
            if duration > bridge.CHUNK_THRESHOLD_SECONDS:
                input_path = folder/'chunks'
                input_path.mkdir()
                chunks = bridge.split_wav_into_chunks(str(audio), bridge.CHUNK_DURATION_SECONDS, str(input_path))
            raw_dir = folder/'raw'
            raw_dir.mkdir()
            command = [str(binary), 'transcribe', str(input_path), '--model', str(model),
                       '--device', args.device, '--format', 'json', '--no-batching']
            if chunks:
                command += ['--output-dir', str(raw_dir), '--concurrency', '1']
            else:
                command += ['--output', str(raw_dir/'result.json')]
            seconds, rss, vram = lab.invoke_native(command, folder/'worker.log', args.device)
            raw_chunks = [(offset, json.loads((raw_dir/f'{Path(path).stem}.json').read_text()))
                          for path, offset in chunks] if chunks else [(0, json.loads((raw_dir/'result.json').read_text()))]
            result = normalized_result(raw_chunks, duration, bridge)
            (folder/'transcript.json').write_text(json.dumps(result, indent=2))
        else:
            if args.device not in ('cpu', 'cuda'):
                raise ValueError('Current Python engine supports cpu or cuda')
            # NeMo chooses a device while restoring weights, before Concord's
            # .to(device) call. Hide CUDA for an actual CPU-only baseline.
            prefix = ['env', 'CUDA_VISIBLE_DEVICES=', 'OMP_NUM_THREADS=8', 'MKL_NUM_THREADS=8'] if args.device == 'cpu' else []
            command = prefix + [str(Path.home()/'.local/share/concord/venv/bin/python'),
                               str(PIPELINE), str(audio), str(folder/'transcript.md'),
                               '--model', MODEL, '--device', args.device]
            seconds, rss, vram = lab.invoke_native(command, folder/'worker.log', args.device)
            result = json.loads((folder/'transcript.json').read_text())
        metrics = {'worker_seconds': round(seconds, 2), 'wall_seconds': round(time.monotonic()-started, 2),
                   'audio_seconds': duration, 'audio_seconds_per_worker_second': round(duration/seconds, 2),
                   'sampled_peak_worker_rss_mib': round(rss/1024, 2) if rss else None,
                   'sampled_peak_worker_vram_mib': vram,
                   'word_timestamps': len(result['words']), 'segments': len(result['segments'])}
        with db:
            db.execute('UPDATE asr_runs SET status=?,config=?,metrics=? WHERE id=?',
                       ('complete', json.dumps(config), json.dumps(metrics), run_id))
        (folder/'summary.json').write_text(json.dumps({'id': run_id, 'config': config, 'metrics': metrics}, indent=2))
        print(json.dumps({'id': run_id, **metrics}), flush=True)
    except BaseException as error:
        with db:
            db.execute('UPDATE asr_runs SET status=?,metrics=? WHERE id=?',
                       ('failed', json.dumps({'error': str(error)}), run_id))
        raise
    finally:
        for path, _ in chunks:
            Path(path).unlink(missing_ok=True)
        db.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=lab.DEFAULT_ROOT)
    p.add_argument('--audio', type=Path, required=True)
    p.add_argument('--engine', choices=['native', 'current'], default='native')
    p.add_argument('--device', default='cpu')
    run(p.parse_args())
