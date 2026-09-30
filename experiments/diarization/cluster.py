#!/usr/bin/env python3
"""Reuse Concord's existing TitaNet environment to evaluate global voice grouping.

This is an experiment helper, not a proposed Python dependency for the Rust app.
Embeddings are cached once; threshold sweeps never force the expected speaker count.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import time
import uuid
import wave

from lab import connect_lab, load_segments, summarize, finish, write_segments, DEFAULT_ROOT


def group_local_tracks(segments, matrix, valid, sample_seconds, threshold):
    """Average-linkage cosine grouping of duration-weighted local voice profiles.

    The native session's channel identity is retained for all its turns. No
    expected count or archive labels enter clustering, and brief tracks remain
    present even when there is too little audio to produce a voice profile.
    """
    import numpy as np
    from scipy.cluster.hierarchy import linkage, fcluster
    sums = {}
    for segment, embedding, good in zip(segments, matrix, valid):
        if not good:
            continue
        norm = np.linalg.norm(embedding)
        if not np.isfinite(norm) or norm < 1e-8:
            raise ValueError('Invalid cached voice embedding')
        weight = min(segment['end'] - segment['start'], sample_seconds)
        track = segment['speaker']
        sums[track] = sums.get(track, 0) + weight * embedding / norm
    names = list(sums)
    mapping = {}
    if names:
        profiles = np.stack([sums[name] / np.linalg.norm(sums[name]) for name in names])
        labels = (fcluster(linkage(profiles, method='average', metric='cosine'),
                           threshold, criterion='distance') if len(names) > 1 else [1])
        # Stable display IDs ordered by first appearance, rather than arbitrary
        # hierarchy node numbering.
        display_ids = {}
        for name, label in zip(names, labels):
            display_ids.setdefault(int(label), f'S{len(display_ids)+1}')
            mapping[name] = display_ids[int(label)]
    return [{**s, 'speaker': mapping.get(s['speaker'], 'unresolved:' + s['speaker'])}
            for s in segments]


def cluster(args):
    import numpy as np
    db, root = connect_lab(args.root)
    run = db.execute("SELECT * FROM runs WHERE id=? AND status='complete'", (args.run,)).fetchone()
    if run is None or run['mode'] != 'windowed':
        raise ValueError('Provide a completed windowed run')
    case = db.execute('SELECT * FROM cases WHERE id=?', (run['case_id'],)).fetchone()
    segments = load_segments(db, args.run)
    cache = root / 'runs' / args.run / f'voice-embeddings-{args.sample_seconds:g}s.npz'
    bridge = None
    if not cache.exists() or args.strategy == 'turns':
        spec = importlib.util.spec_from_file_location('legacy_diarizer',
            Path(__file__).resolve().parents[2] / 'server/transcription-engines/diarize-sortformer.py')
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
    embedding_seconds = 0.0
    if cache.exists():
        saved = np.load(cache)
        matrix, valid = saved['embeddings'], saved['valid']
        if len(matrix) != len(segments):
            raise ValueError('Cached embedding count does not match run')
    else:
        import torch
        from nemo.collections.asr.models import EncDecSpeakerLabelModel
        started = time.monotonic()
        model = EncDecSpeakerLabelModel.from_pretrained(model_name='titanet_large')
        model.train(False)
        model = model.to(args.device)
        with wave.open(str(root / f"{run['case_id']}.wav"), 'rb') as wav:
            if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
                raise ValueError('Expected prepared mono PCM16 16kHz WAV')
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        waveform = torch.from_numpy(samples)
        # Cap long turns to eight seconds so memory does not grow with monologues.
        # Keep skipped short turns explicit; do not invent an embedding for them.
        turns = [{'start': s['start'], 'end': min(s['end'], s['start'] + args.sample_seconds)} for s in segments]
        values = []
        for pos in range(0, len(turns), 100):
            values.extend(bridge.extract_turn_embeddings(waveform, 16000, turns[pos:pos+100], model, args.device))
            print(f'embeddings {min(pos+100,len(turns))}/{len(turns)}', flush=True)
        valid = np.array([v is not None for v in values], dtype=bool)
        matrix = np.stack([v if v is not None else np.zeros(192, dtype=np.float32) for v in values]) if values else np.empty((0,192), dtype=np.float32)
        np.savez_compressed(cache, embeddings=matrix, valid=valid)
        embedding_seconds = time.monotonic() - started
        del model, waveform, samples
        if args.device == 'cuda':
            torch.cuda.empty_cache()
    for threshold in args.thresholds:
        started = time.monotonic()
        short_count = int((~valid).sum())
        if args.strategy == 'tracks':
            output = group_local_tracks(segments, matrix, valid, args.sample_seconds, threshold)
        else:
            manager = bridge.SpeakerManager(threshold=threshold)
            output, local_context = [], {}
            for s, emb, good in zip(segments, matrix, valid):
                if good:
                    speaker = f'S{manager.assign(emb)}'
                    local_context[s['speaker']] = speaker
                else:
                    speaker = local_context.get(s['speaker'], 'unresolved:' + s['speaker'])
                output.append({**s, 'speaker': speaker})
            for s in output:
                if s['speaker'].startswith('unresolved:'):
                    track = s['speaker'].removeprefix('unresolved:')
                    s['speaker'] = local_context.get(track, s['speaker'])
        run_id = f"{run['case_id']}-cluster-{args.strategy}-{threshold:g}-{uuid.uuid4().hex[:8]}"
        config = {**json.loads(run['config']), 'parent_run': args.run, 'embedding_model': 'titanet_large',
                  'cosine_distance_threshold': threshold, 'sample_seconds': args.sample_seconds,
                  'grouping_strategy': args.strategy,
                  'minor_speaker_merging': False, 'forced_speaker_count': None}
        with db:
            db.execute('INSERT INTO runs(id,case_id,mode,status,config) VALUES(?,?,?,?,?)',
                       (run_id, run['case_id'], 'clustered', 'running', json.dumps(config)))
        write_segments(db, run_id, output)
        metrics = summarize(output, json.loads(case['baseline']))
        metrics.update({'count_kind': 'unconstrained clustered identities (not forced to 10/11/16)',
                        'embedding_seconds': round(embedding_seconds, 2),
                        'embedding_cache_reused': cache.exists() and embedding_seconds == 0,
                        'clustering_seconds': round(time.monotonic()-started, 2),
                        'short_turns_without_embedding': short_count,
                        'unresolved_tracks': len({s['speaker'] for s in output if s['speaker'].startswith('unresolved:')}),
                        'speakers_with_at_least_15_seconds': sum(d['seconds'] >= 15 for d in metrics['speakers'].values())})
        finish(db, root, run_id, output, metrics)
    db.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    p.add_argument('--run', required=True)
    p.add_argument('--device', choices=['cuda', 'cpu'], default='cuda')
    p.add_argument('--strategy', choices=['tracks', 'turns'], default='tracks')
    p.add_argument('--thresholds', type=float, nargs='+', default=[0.35, 0.5, 0.65, 0.7])
    p.add_argument('--sample-seconds', type=float, default=8)
    a = p.parse_args()
    if any(t < 0 or t > 2 for t in a.thresholds) or a.sample_seconds < 1:
        p.error('Thresholds must be in [0,2]; samples must be at least one second')
    cluster(a)
