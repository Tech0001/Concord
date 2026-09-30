#!/usr/bin/env python3
"""Compare native transcription models with Concord's current ASR in the lab."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import time
import uuid

import lab

MODEL = 'nvidia/parakeet-tdt-0.6b-v3'
# Pinned official artifacts from the runtime's models/index.json.
MODELS = {
    'parakeet': {
        'repo': MODEL, 'directory': 'parakeet-v3', 'language': 'auto',
        'file': 'parakeet-tdt-0.6b-v3.q8_0.gguf',
        'revision': '541d1f99c6b0c3cd0b11a95167540bb8edefd82b',
        'sha256': 'e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e'},
    'nemotron-en': {
        'repo': 'nvidia/nemotron-speech-streaming-en-0.6b',
        'directory': 'nemotron-en', 'language': 'en-US',
        'file': 'nemotron-speech-streaming-en-0.6b.q8_0.gguf',
        'revision': 'ebe59e5a817142986528bbbee5dba8db7b38ed50',
        'sha256': 'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d'},
    'nemotron-3.5': {
        'repo': 'nvidia/nemotron-3.5-asr-streaming-0.6b',
        'directory': 'nemotron-3.5', 'language': 'en-US',
        'file': 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf',
        'revision': '1c8deaecc64b91f034d73e08dd8b64625eb3395d',
        'sha256': 'a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae'},
}
PIPELINE = Path(__file__).resolve().parents[2] / 'server/transcription-engines/transcribe-parakeet.py'


def bridge_module():
    spec = importlib.util.spec_from_file_location('existing_parakeet', PIPELINE)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    return bridge


def normalized_result(raw_chunks, duration, bridge, model=MODEL, language='auto'):
    words, texts = [], []
    for offset, raw in raw_chunks:
        texts.append(raw['text'].strip())
        words.extend({'start': w['start'] + offset, 'end': w['end'] + offset, 'text': w['word']}
                     for w in raw['words'])
    # Use Concord's existing fallback grouping and long-segment handling.
    segments = bridge.group_words_into_segments(words)
    segments = bridge.split_long_segments(segments, words)
    text = ' '.join(t for t in texts if t)
    return {'schema_version': 2, 'model': model, 'language': language,
            'duration_seconds': duration, 'duration_formatted': bridge.format_timestamp(duration),
            'text': text, 'words': words, 'segments': segments,
            'segment_count': len(segments), 'word_count': len(text.split())}


def run(args):
    if args.engine == 'current' and args.model != 'parakeet':
        raise ValueError('The current-engine reference is Concord’s existing Parakeet model')
    if (args.stream or args.right_context is not None) and (args.engine != 'native' or args.model == 'parakeet'):
        raise ValueError('Streaming options in this lab apply only to native Nemotron ASR')
    if args.engine == 'current' and args.language:
        raise ValueError('The unchanged current-engine reference uses automatic language detection')
    artifact = MODELS[args.model]
    language = args.language or artifact['language']
    db, root = lab.connect_lab(args.root)
    audio = args.audio.expanduser().resolve(strict=True)
    bridge = bridge_module()
    duration = bridge.get_wav_duration(str(audio))
    if duration <= 0:
        raise ValueError('Use a nonempty mono 16 kHz PCM WAV')
    run_id = f'{audio.stem}-{args.model}-{args.engine}-{args.device.replace(":", "-")}-{uuid.uuid4().hex[:8]}'
    folder = root / 'asr' / 'runs' / run_id
    folder.mkdir(parents=True)
    config = {'audio': str(audio), 'audio_sha256': lab.sha256(audio),
              'duration_seconds': duration, 'engine': args.engine, 'device': args.device,
              'model': artifact['repo'], 'model_key': args.model, 'language': language,
              'requested_mode': 'streaming' if args.stream else 'file',
              'right_context': args.right_context, 'pipeline_sha256': lab.sha256(PIPELINE),
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
            model = lab.CACHE/'models'/artifact['directory']/artifact['file']
            if lab.sha256(model) != artifact['sha256']:
                raise ValueError('Model hash differs from the pinned official artifact')
            config.update({'runtime_sha256': lab.sha256(binary),
                           'runtime_revision': lab.RUNTIME_REVISION,
                           'model_revision': artifact['revision'], 'model_sha256': artifact['sha256'],
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
            # Only the multilingual Nemotron has language-ID prompt conditioning.
            if args.model == 'nemotron-3.5' or args.language:
                command += ['--language', language]
            if args.stream:
                command += ['--stream']
            if args.right_context is not None:
                command += ['--asr.streaming.rnnt_right_context', str(args.right_context)]
            if chunks:
                command += ['--output-dir', str(raw_dir), '--concurrency', '1']
            else:
                command += ['--output', str(raw_dir/'result.json')]
            config['command'] = command
            with db:
                db.execute('UPDATE asr_runs SET config=? WHERE id=?', (json.dumps(config), run_id))
            seconds, rss, vram = lab.invoke_native(command, folder/'worker.log', args.device)
            # File requests may route to streaming internally (notably Vulkan
            # RNNT). Record actual execution rather than inferring from flags.
            execution = re.findall(r'\[asr\] mode=(.*)', (folder/'worker.log').read_text())
            config['execution'] = list(dict.fromkeys(execution))
            config['mode'] = ','.join(dict.fromkeys(e.split()[0] for e in execution)) or 'unknown'
            raw_chunks = [(offset, json.loads((raw_dir/f'{Path(path).stem}.json').read_text()))
                          for path, offset in chunks] if chunks else [(0, json.loads((raw_dir/'result.json').read_text()))]
            result = normalized_result(raw_chunks, duration, bridge, artifact['repo'], language)
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
            config['mode'] = 'offline'
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
    p.add_argument('--model', choices=MODELS, default='parakeet')
    p.add_argument('--language', help='Language prompt override (multilingual Nemotron defaults to en-US)')
    p.add_argument('--stream', action='store_true', help='Explicitly request streaming on CPU as well as GPU')
    p.add_argument('--right-context', type=int, help='RNNT streaming lookahead in encoder frames; -1 preserves the exported model setting')
    p.add_argument('--device', default='cpu')
    run(p.parse_args())
