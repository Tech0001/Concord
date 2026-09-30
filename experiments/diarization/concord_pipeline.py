#!/usr/bin/env python3
"""Run Concord's unchanged diarize() with a test-only Nemotron model adapter.

Only the Sortformer model object is substituted, scoped to this process.
Concord itself performs chunking, overlap deduplication, full-turn TitaNet
embedding, greedy grouping, short-turn continuation, minor-speaker cleanup,
and speaker-profile generation. No production database modules are imported.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import time
from unittest.mock import patch
import uuid

import lab

PIPELINE = Path(__file__).resolve().parents[2] / 'server/transcription-engines/diarize-sortformer.py'


def native_lines(segments):
    # Match NeMo's per-speaker grouped, zero-indexed output convention.
    return [f"{s['start']} {s['end']} speaker_{int(s['speaker'])-1}"
            for s in sorted(segments, key=lambda s: (int(s['speaker']), s['start']))]


def run_case(args, case_id):
    db, root = lab.connect_lab(args.root)
    case = db.execute('SELECT * FROM cases WHERE id=?', (case_id,)).fetchone()
    if case is None:
        raise ValueError('Unknown prepared case: ' + case_id)
    if lab.sha256(Path(case['audio'])) != case['sha256']:
        raise ValueError('Input changed since preparation')
    binary = args.runtime.expanduser().resolve(strict=True)
    model = args.model.expanduser().resolve(strict=True)
    run_id = f'{case_id}-concord-pipeline-{uuid.uuid4().hex[:8]}'
    folder = root / 'runs' / run_id
    folder.mkdir(parents=True)
    config = {
        'pipeline': str(PIPELINE), 'pipeline_sha256': lab.sha256(PIPELINE),
        'pipeline_entrypoint': 'diarize', 'grouping_strategy': 'existing-concord',
        'runtime_revision': lab.RUNTIME_REVISION, 'runtime_sha256': lab.sha256(binary),
        'model_revision': lab.MODEL_REVISION, 'model_sha256': lab.sha256(model),
        'native_device': args.device, 'embedding_device': args.embedding_device,
        'window_seconds': 120, 'overlap_seconds': 10,
        'cosine_distance_threshold': 0.65, 'sample_seconds': None,
        'minor_speaker_merging': 'max(15 seconds, 2% of final turn end)',
        'short_turn_assignment': 'previous global speaker',
        'forced_speaker_count': None, 'recording_geometry': lab.RECORDING_GEOMETRY,
    }
    with db:
        db.execute('INSERT INTO runs(id,case_id,mode,status,config) VALUES(?,?,?,?,?)',
                   (run_id, case_id, 'concord-pipeline', 'running', json.dumps(config)))
    try:
        wav = root / f'{case_id}.wav'
        if not wav.exists():
            lab.extract(case['audio'], wav)
        spec = importlib.util.spec_from_file_location('concord_existing_diarizer', PIPELINE)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        import nemo.collections.asr.models as models
        import torch
        if args.embedding_device == 'cuda':
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
        native_metrics = {}

        class NativeTurnDetector:
            @classmethod
            def from_pretrained(cls, model_name):
                return cls()

            def train(self, mode):
                return self

            def cuda(self):
                return self

            def diarize(self, audio, batch_size, verbose):
                # Concord has already created every chunk before this call.
                # Process that directory once with shared model weights; each
                # WAV still starts an independent native speaker session.
                if not native_metrics:
                    raw_folder = folder / 'native'
                    raw_folder.mkdir()
                    command = [str(binary), 'diarize', str(Path(audio[0]).parent),
                               '--model', str(model), '--device', args.device,
                               '--format', 'json', '--output-dir', str(raw_folder),
                               '--concurrency', '1', '--no-batching']
                    for key, value in lab.RECORDING_GEOMETRY.items():
                        command += ['--diar.' + key, str(value)]
                    seconds, rss, vram = lab.invoke_native(command, folder/'native.log', args.device)
                    native_metrics.update({
                        'native_seconds': round(seconds, 2),
                        'sampled_peak_native_rss_mib': round(rss/1024, 2) if rss is not None else None,
                        'sampled_peak_native_vram_mib': vram,
                    })
                return [native_lines(json.loads(
                    (folder/'native'/f'{Path(path).stem}.json').read_text())['segments'])
                    for path in audio]

        output = folder / 'concord.diar.json'
        started = time.monotonic()
        # This calls the existing production function, including its cleanup
        # pass. The model class substitution ends when the context exits.
        with patch.object(models, 'SortformerEncLabelModel', NativeTurnDetector):
            bridge.diarize(str(wav), str(output), str(model), args.embedding_device,
                           120.0, 10.0, 0.65)
        elapsed = time.monotonic() - started
        result = json.loads(output.read_text())
        segments = [{'start': s['startTimeSeconds'], 'end': s['endTimeSeconds'],
                     'speaker': f"S{int(s['speakerId'])-1}"} for s in result['segments']]
        lab.write_segments(db, run_id, segments)
        metrics = lab.summarize(segments, json.loads(case['baseline']))
        metrics.update(native_metrics)
        metrics.update({
            'wall_seconds': round(elapsed, 2),
            'count_kind': 'existing Concord pipeline with Nemotron turn detection',
            'speaker_profiles': len(result.get('speakerProfiles', [])),
            'embedding_peak_torch_reserved_mib': round(torch.cuda.max_memory_reserved()/1024**2, 2)
                if args.embedding_device == 'cuda' else None,
            'embedding_memory_note': 'PyTorch allocator only; excludes CUDA context and native Vulkan worker',
        })
        lab.finish(db, root, run_id, segments, metrics)
    except BaseException as error:
        with db:
            db.execute('UPDATE runs SET status=?,metrics=? WHERE id=?',
                       ('failed', json.dumps({'error': str(error)}), run_id))
        raise
    finally:
        db.close()
    return run_id


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=lab.DEFAULT_ROOT)
    p.add_argument('--cases', nargs='+', required=True)
    p.add_argument('--device', default='vulkan:0')
    p.add_argument('--embedding-device', choices=['cuda', 'cpu'], default='cuda')
    p.add_argument('--runtime', type=Path, default=lab.CACHE/'NeMo-Speech.cpp/build-lab/bin/nemo-speech')
    p.add_argument('--model', type=Path, default=lab.CACHE/'models/nemotron-3/Nemotron-3-Diarization.q8_0.gguf')
    args = p.parse_args()
    for case_id in args.cases:
        run_case(args, case_id)
    lab.report(args)


if __name__ == '__main__':
    main()
