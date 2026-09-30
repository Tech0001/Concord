#!/usr/bin/env python3
"""Isolated native Nemotron evaluation. Never imports Concord's database code."""
import argparse
import hashlib
import html
import json
import math
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import time
import uuid
import wave
import xml.etree.ElementTree as ET

MODEL_REVISION = "f667ed73aee57d40cc39428eb768b4fd87a0a29e"
RUNTIME_REVISION = "4c101bc7113f49101a3e11d2c994c519f41939f6"
DEFAULT_ROOT = Path.home() / ".local/share/concord-diarization-lab"
CACHE = Path.home() / ".cache/concord-diarization-lab"
ARCHIVE = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "concord/pipeline.db"
# NVIDIA's published long-recording evaluation geometry, in coarse 80ms frames.
RECORDING_GEOMETRY = {'chunk': 340, 'right_context': 40, 'left_context': 0,
                      'fifo': 40, 'spkcache': 264, 'update_period': 300}


def connect_lab(root, archive=ARCHIVE):
    root = Path(root).expanduser().resolve()
    target = root / "lab.sqlite3"
    if target.resolve() == Path(archive).resolve() or target.resolve() == ARCHIVE.resolve():
        raise ValueError("The experiment database must be separate from the archive")
    if target.exists() and Path(archive).exists() and os.path.samefile(target, archive):
        raise ValueError("The experiment database aliases the archive")
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(target)
    db.row_factory = sqlite3.Row
    # Refuse a production database copied or symlinked to the lab location.
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "video_queue" in tables or "app_config" in tables:
        db.close()
        raise ValueError("Refusing to write to a Concord production-schema database")
    db.executescript("""
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, audio TEXT NOT NULL, sha256 TEXT NOT NULL,
        duration REAL NOT NULL, expected_speakers INTEGER NOT NULL,
        baseline TEXT NOT NULL DEFAULT '[]', baseline_profiles TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL, config TEXT NOT NULL, metrics TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS segments (
        run_id TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, speaker TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS segments_run ON segments(run_id, start);
    """)
    return db, root


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def duration(path):
    return float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)
    ], text=True).strip())


def prepare(args):
    audio = Path(args.audio).expanduser().resolve(strict=True)
    if not audio.is_file():
        raise ValueError("Audio input must be a file")
    baseline, profiles = [], []
    if args.baseline_video_id:
        archive = Path(args.archive_db).expanduser().resolve(strict=True)
        with sqlite3.connect(archive.as_uri() + "?mode=ro", uri=True) as source:
            source.row_factory = sqlite3.Row
            source.execute("PRAGMA query_only=ON")
            rows = source.execute("""SELECT v.local_speaker, s.name, v.centroid,
                v.sample_start, v.sample_end FROM video_speaker_assignments v
                LEFT JOIN speakers s ON s.id=v.speaker_id WHERE v.video_id=?""",
                (args.baseline_video_id,)).fetchall()
            names = {r['local_speaker']: r['name'] or r['local_speaker'] for r in rows}
            import array
            for row in rows:
                values = array.array('f')
                values.frombytes(row['centroid'])
                profiles.append({'speaker': names[row['local_speaker']],
                                 'centroid': list(values), 'start': row['sample_start'],
                                 'end': row['sample_end']})
            baseline = [{'start': float(r['start_seconds']), 'end': float(r['end_seconds']),
                         'speaker': names.get(r['speaker'], r['speaker'] or 'unknown')}
                        for r in source.execute("""SELECT start_seconds, end_seconds, speaker
                           FROM transcript_segments_fts WHERE video_id=?
                           ORDER BY CAST(start_seconds AS REAL)""", (args.baseline_video_id,))]
            if not baseline:
                raise ValueError("No baseline transcript segments found for that video")
    db, root = connect_lab(args.root, args.archive_db)
    case_id = args.case or audio.stem
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', case_id):
        raise ValueError('Case ID must contain only letters, numbers, dots, underscores, or hyphens')
    if db.execute("SELECT 1 FROM cases WHERE id=?", (case_id,)).fetchone():
        raise ValueError("Case already exists; use a different --case to preserve results")
    seconds = duration(audio)
    with db:
        db.execute("INSERT INTO cases VALUES (?,?,?,?,?,?,?)", (
            case_id, str(audio), sha256(audio), seconds, args.expected_speakers,
            json.dumps(baseline), json.dumps(profiles)))
    db.close()
    print(json.dumps({'case': case_id, 'duration_seconds': seconds,
                      'expected_speakers': args.expected_speakers,
                      'baseline_named_speakers': len({s['speaker'] for s in baseline}),
                      'database': str(root / 'lab.sqlite3')}), flush=True)


def windows(seconds, size, overlap):
    if size <= 0 or overlap < 0 or overlap >= size:
        raise ValueError("Window size must be positive and larger than overlap")
    start = 0.0
    while start < seconds:
        end = min(start + size, seconds)
        yield start, end
        if end >= seconds:
            break
        start += size - overlap


def stitch(segments, offset, keep_from, end):
    output = []
    for segment in segments:
        start = max(float(segment['start']) + offset, keep_from)
        stop = min(float(segment['end']) + offset, end)
        if not math.isfinite(start) or not math.isfinite(stop):
            raise ValueError("Non-finite native timestamp")
        if stop > start:
            output.append({'start': start, 'end': stop, 'speaker': str(segment['speaker'])})
    return output


def write_segments(db, run_id, segments):
    with db:
        db.executemany("INSERT INTO segments VALUES (?,?,?,?)", [
            (run_id, s['start'], s['end'], s['speaker']) for s in segments])


def load_segments(db, run_id):
    return [dict(r) for r in db.execute(
        "SELECT start,end,speaker FROM segments WHERE run_id=? ORDER BY start,end", (run_id,))]


def summarize(segments, baseline):
    by_speaker = {}
    for s in segments:
        d = by_speaker.setdefault(s['speaker'], {'seconds': 0, 'turns': 0, 'samples': [], 'baseline_overlap': {}})
        d['seconds'] += s['end'] - s['start']
        d['turns'] += 1
        d['samples'].append({'start': s['start'], 'end': s['end']})
    # Old automatically generated transcript is a comparison reference, NOT ground truth.
    for s in segments:
        counts = by_speaker[s['speaker']]['baseline_overlap']
        for ref in baseline:
            if ref['start'] >= s['end']:
                break
            overlap = min(s['end'], ref['end']) - max(s['start'], ref['start'])
            if overlap > 0:
                counts[ref['speaker']] = counts.get(ref['speaker'], 0) + overlap
    dominant = {}
    mixed = []
    for speaker, d in by_speaker.items():
        d['seconds'] = round(d['seconds'], 2)
        # Three temporally separated samples help expose splits and false merges.
        candidates = sorted(d['samples'], key=lambda s: s['end']-s['start'], reverse=True)
        samples = []
        for s in candidates:
            if all(abs(s['start'] - p['start']) >= 30 for p in samples):
                samples.append(s)
            if len(samples) == 3:
                break
        d['samples'] = samples
        matches = sorted(d['baseline_overlap'].items(), key=lambda kv: -kv[1])
        total_overlap = sum(value for _, value in matches)
        if matches and d['seconds'] >= 15:
            dominant.setdefault(matches[0][0], []).append(speaker)
            if len(matches) > 1 and matches[1][1] >= 15 and matches[1][1] >= 0.2 * total_overlap:
                mixed.append(speaker)
        d['baseline_overlap'] = dict(matches[:3])
        d['dominant_reference_share_percent'] = round(100*matches[0][1]/total_overlap, 1) if total_overlap else None
    reference_names = {s['speaker'] for s in baseline}
    return {'speaker_count': len(by_speaker), 'segment_count': len(segments),
            'speakers': by_speaker, 'reference_kind': 'existing automatic transcript; not ground truth',
            'reference_comparison': {
                'named_people_in_old_transcript': len(reference_names),
                'people_dominant_in_a_track_of_at_least_15_seconds': len(dominant),
                'people_not_dominant_in_any_substantial_track': sorted(reference_names-set(dominant)),
                'tracks_with_two_substantial_reference_voices': mixed,
                'reference_people_split_across_substantial_tracks': {k:v for k,v in dominant.items() if len(v)>1}
            }}


def extract(audio, wav, start=None, end=None):
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-n']
    if start is not None:
        command += ['-ss', str(start)]
    command += ['-i', str(audio)]
    if end is not None:
        command += ['-t', str(end - (start or 0))]
    command += ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(wav)]
    subprocess.run(command, check=True)


def invoke_native(command, log_path, device):
    """Sample this worker's RAM/VRAM without requiring an installed time utility."""
    peak_rss, peak_vram = None, None
    gpu_due = 0.0
    started = time.monotonic()
    with log_path.open('w') as log:
        process = subprocess.Popen(command, stdout=log, stderr=log)
        try:
            while process.poll() is None:
                try:
                    for line in Path(f'/proc/{process.pid}/status').read_text().splitlines():
                        if line.startswith('VmHWM:'):
                            peak_rss = max(peak_rss or 0, int(line.split()[1]))
                except (OSError, ValueError):
                    pass
                now = time.monotonic()
                if device != 'cpu' and now >= gpu_due:
                    gpu_due = now + 1
                    try:
                        xml = ET.fromstring(subprocess.check_output(
                            ['nvidia-smi', '-q', '-x'], text=True, stderr=subprocess.DEVNULL, timeout=2))
                        for info in xml.findall('.//process_info'):
                            if info.findtext('pid') == str(process.pid):
                                match = re.search(r'(\d+) MiB', info.findtext('used_memory', ''))
                                if match:
                                    peak_vram = max(peak_vram or 0, int(match[1]))
                    except (OSError, subprocess.SubprocessError, ET.ParseError):
                        pass
                time.sleep(0.1)
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode, command)
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            raise
    return time.monotonic()-started, peak_rss, peak_vram


def run(args):
    db, root = connect_lab(args.root)
    case = db.execute('SELECT * FROM cases WHERE id=?', (args.case,)).fetchone()
    if case is None:
        raise ValueError('Unknown case; run prepare first')
    audio = Path(case['audio'])
    if sha256(audio) != case['sha256']:
        raise ValueError('Input changed since prepare; make a new case')
    binary = Path(args.runtime).expanduser().resolve(strict=True)
    model = Path(args.model).expanduser().resolve(strict=True)
    run_id = f"{args.case}-{args.mode}-{uuid.uuid4().hex[:8]}"
    folder = root / 'runs' / run_id
    folder.mkdir(parents=True)
    config = {'runtime': str(binary), 'runtime_revision': RUNTIME_REVISION,
              'runtime_sha256': sha256(binary),
              'model': str(model), 'model_revision': MODEL_REVISION, 'model_sha256': sha256(model),
              'device': args.device, 'window_seconds': args.window_seconds,
              'overlap_seconds': args.overlap_seconds, 'geometry': args.geometry,
              'recording_geometry': RECORDING_GEOMETRY if args.geometry == 'recording' else None}
    with db:
        db.execute('INSERT INTO runs(id,case_id,mode,status,config) VALUES(?,?,?,?,?)',
                   (run_id, args.case, args.mode, 'running', json.dumps(config)))
    started = time.monotonic()
    segments, native_seconds, peak_rss_kb, peak_vram_mib = [], 0.0, None, None
    spans = [(0, case['duration'])] if args.mode == 'native' else list(windows(
        case['duration'], args.window_seconds, args.overlap_seconds))
    print(f"{run_id}: {len(spans)} input window(s)", flush=True)
    try:
        wav = root / f"{args.case}.wav"
        if not wav.exists():
            partial = root / f"{args.case}.partial.wav"
            if partial.exists():
                partial.unlink()
            extract(audio, partial)
            partial.rename(wav)
        input_path = wav
        if args.mode == 'windowed':
            input_path = folder / 'input-windows'
            input_path.mkdir()
            for i, (start, end) in enumerate(spans):
                extract(wav, input_path / f'window-{i:04d}.wav', start, end)
            print('  windows extracted; loading one shared native engine', flush=True)
        command = [str(binary), 'diarize', str(input_path), '--model', str(model),
                   '--device', args.device, '--format', 'json']
        if args.geometry == 'recording':
            for key, value in RECORDING_GEOMETRY.items():
                command += ['--diar.'+key, str(value)]
        else:
            command += ['--preset', 'v3-streaming']
        if args.mode == 'native':
            command += ['--output', str(folder / 'window-0000.json')]
        else:
            # Each file starts a fresh diarization session while reusing model
            # weights. Sequential sessions keep GPU memory bounded.
            command += ['--output-dir', str(folder), '--concurrency', '1', '--no-batching']
        native_seconds, peak_rss_kb, peak_vram_mib = invoke_native(command, folder/'native.log', args.device)
        for i, (start, end) in enumerate(spans):
            output = folder / f'window-{i:04d}.json'
            raw = json.loads(output.read_text())['segments']
            clipped = stitch(raw, start, start + args.overlap_seconds if i else 0, end)
            for s in clipped:
                if args.mode == 'windowed':
                    s['speaker'] = f"w{i:04d}:{s['speaker']}"
            segments.extend(clipped)
            if args.mode == 'windowed':
                (input_path / f'window-{i:04d}.wav').unlink()
            print(f"  window {i+1}/{len(spans)} @ {start:.0f}s: {len(clipped)} turns", flush=True)
        segments.sort(key=lambda s: (s['start'], s['end']))
        write_segments(db, run_id, segments)
        metrics = summarize(segments, json.loads(case['baseline']))
        metrics.update({'wall_seconds': round(time.monotonic()-started, 2),
                        'native_seconds': round(native_seconds, 2),
                        'sampled_peak_native_rss_mib': round(peak_rss_kb/1024, 2) if peak_rss_kb is not None else None,
                        'sampled_peak_native_vram_mib': peak_vram_mib,
                        'native_audio_realtime_factor': round(sum(e-s for s,e in spans)/native_seconds, 2),
                        'count_kind': 'global native speaker slots' if args.mode == 'native' else 'window-local tracks; requires clustering'})
        finish(db, root, run_id, segments, metrics)
    except BaseException as error:
        write_segments(db, run_id, segments)
        with db:
            db.execute('UPDATE runs SET status=?,metrics=? WHERE id=?', ('failed', json.dumps({'error': str(error)}), run_id))
        raise
    finally:
        db.close()
    return run_id


def finish(db, root, run_id, segments, metrics):
    with db:
        db.execute('UPDATE runs SET status=?,metrics=? WHERE id=?', ('complete', json.dumps(metrics), run_id))
    folder = root / 'runs' / run_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'segments.json').write_text(json.dumps(segments, indent=2))
    (folder / 'summary.json').write_text(json.dumps(metrics, indent=2))
    (folder / 'segments.rttm').write_text(''.join(
        f"SPEAKER {run_id} 1 {s['start']:.3f} {s['end']-s['start']:.3f} <NA> <NA> {s['speaker']} <NA> <NA>\n"
        for s in segments))
    print(json.dumps({'run_id': run_id, **{k:v for k,v in metrics.items() if k != 'speakers'}}), flush=True)


def report(args):
    db, root = connect_lab(args.root)
    query = "SELECT r.*,c.audio,c.expected_speakers,c.baseline FROM runs r JOIN cases c ON c.id=r.case_id WHERE r.status='complete' ORDER BY created_at"
    rows = db.execute(query).fetchall()
    for row in rows:
        metrics = json.loads(row['metrics'])
        if 'reference_comparison' not in metrics:
            metrics.update(summarize(load_segments(db, row['id']), json.loads(row['baseline'])))
            with db:
                db.execute('UPDATE runs SET metrics=? WHERE id=?', (json.dumps(metrics), row['id']))
    rows = db.execute(query).fetchall()
    content = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Concord diarization lab</title>',
               '<style>body{font:16px system-ui;max-width:1200px;margin:30px auto;padding:0 20px;background:#15171c;color:#eee}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #444;text-align:left}audio{width:230px}small{color:#bbc}summary{cursor:pointer;padding:12px 0}h2{margin-top:35px}a{color:#9bd0ff}.scroll{overflow-x:auto}details{margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>',
               '<h1>Concord diarization lab</h1><p><strong>Current test: Concord’s existing pipeline with Nemotron replacing the turn-detection model.</strong> Chunking, voice matching, and cleanup use Concord’s existing code. This is running in the isolated test environment.</p>',
               '<p>The old transcript is an automatic comparison reference, not hand-labelled ground truth. Matching counts or labels does not establish accuracy. Listen for merged people, split voices, brief speakers, and overlap.</p>',
               '<p>“Substantial” means at least 15 seconds of detected speech, solely to make review manageable. Brief and unresolved tracks are retained in the raw output. An unresolved track is not an identified person. Native worker memory excludes TitaNet, transcription, and the desktop application.</p>']

    def summary_table(selected):
        content.append('<div class="scroll"><table><tr><th>Recording / mode</th><th>Expected people</th><th>Substantial / all tracks</th><th>Unresolved tracks</th><th>Old voices dominant</th><th>Mixed / split</th><th>Native seconds</th><th>Native worker VRAM / RAM MiB (sampled)</th></tr>')
        for row in selected:
            m, config = json.loads(row['metrics']), json.loads(row['config'])
            label = row['mode']
            if 'cosine_distance_threshold' in config:
                label += f" / {config.get('grouping_strategy', 'turns')} / {config['cosine_distance_threshold']}"
            ref = m['reference_comparison']
            substantial = sum(d['seconds'] >= 15 for d in m['speakers'].values())
            mixed = len(ref['tracks_with_two_substantial_reference_voices'])
            split = len(ref['reference_people_split_across_substantial_tracks'])
            parent = db.execute('SELECT metrics FROM runs WHERE id=?', (config.get('parent_run'),)).fetchone()
            native = json.loads(parent['metrics']) if parent else m
            content.append(f"<tr><td><a href=\"#{html.escape(row['id'])}\">{html.escape(row['case_id'])} / {html.escape(label)}</a></td><td>{row['expected_speakers']}</td><td>{substantial} / {m['speaker_count']}</td><td>{m.get('unresolved_tracks', 0)}</td><td>{ref['people_dominant_in_a_track_of_at_least_15_seconds']} / {ref['named_people_in_old_transcript']}</td><td>{mixed} tracks / {split} people</td><td>{native.get('native_seconds','—')}</td><td>{native.get('sampled_peak_native_vram_mib','—')} / {native.get('sampled_peak_native_rss_mib','—')}</td></tr>")
        content.append('</table></div>')

    candidates = [r for r in rows if r['mode'] == 'concord-pipeline']
    if candidates:
        content.append('<h2>Same Concord processing, new model</h2><p>A speaker label is the program’s guess at one person. Compare the expected number of people with the output labels, then listen to the samples to check that each label stays with the same person.</p>')
        content.append('<table><tr><th>Recording</th><th>People you reported</th><th>Saved Concord speaker groups</th><th>New speaker groups</th><th>People from existing labels represented</th><th>Full pipeline seconds</th></tr>')
        for row in candidates:
            m = json.loads(row['metrics'])
            ref = m['reference_comparison']
            profiles = db.execute('SELECT baseline_profiles FROM cases WHERE id=?', (row['case_id'],)).fetchone()[0]
            saved_groups = len(json.loads(profiles))
            content.append(f"<tr><td><a href=\"#{html.escape(row['id'])}\">{html.escape(row['case_id'])}</a></td><td>{row['expected_speakers']}</td><td>{saved_groups}</td><td>{m['speaker_count']}</td><td>{ref['people_dominant_in_a_track_of_at_least_15_seconds']} / {ref['named_people_in_old_transcript']}</td><td>{m.get('wall_seconds', '—')}</td></tr>")
        content.append('</table><details><summary>Processing measurements</summary>')
    summary_table(candidates)
    if candidates:
        content.append('</details>')
    content.append('<details><summary>Earlier experiments using different processing</summary><p>These earlier tests changed voice grouping and cleanup. Use the existing-pipeline results above to assess the model replacement.</p>')
    summary_table([r for r in rows if r not in candidates])
    content.append('</details>')
    for row in rows:
        metrics, config = json.loads(row['metrics']), json.loads(row['config'])
        folder = root / 'runs' / row['id']
        featured = row['mode'] == 'concord-pipeline'
        ref = metrics['reference_comparison']
        content.append(f'<details id="{html.escape(row["id"])}"'+(' open' if featured else '')+f'><summary><strong>{html.escape(row["id"])}</strong></summary>')
        content.append(f"<p>Expected: {row['expected_speakers']} people · Output: {metrics['speaker_count']} tracks · {html.escape(metrics.get('count_kind', 'clustered identities'))}</p>")
        content.append(f"<p>Missing dominant reference voices: {html.escape(', '.join(ref['people_not_dominant_in_any_substantial_track']) or 'none')}<br>Mixed substantial tracks: {html.escape(', '.join(ref['tracks_with_two_substantial_reference_voices']) or 'none')}<br>Split reference people: {html.escape(', '.join(ref['reference_people_split_across_substantial_tracks']) or 'none')}</p>")
        relative = folder.relative_to(root).as_posix()
        content.append(f'<p><a href="{relative}/summary.json">Full metrics</a> · <a href="{relative}/segments.json">All turns</a> · <a href="{relative}/segments.rttm">RTTM</a></p>')
        if not featured:
            content.append('</details>')
            continue
        content.append('<table><tr><th>Track</th><th>Speaking time</th><th>Old transcript overlap (top 3)</th><th>Listen</th></tr>')
        for speaker, data in sorted(metrics['speakers'].items(), key=lambda kv: -kv[1]['seconds']):
            if row['mode'] != 'native' and data['seconds'] < 15:
                continue
            samples = []
            for n, sample in enumerate(data['samples']):
                clip = folder / f"sample-{speaker}-{n}.wav"
                if not clip.exists():
                    extract(row['audio'], clip, sample['start'], min(sample['end'], sample['start']+12))
                clip_relative = clip.relative_to(root).as_posix()
                samples.append(f'<div><small>{sample["start"]:.1f}s</small><br><audio controls preload="none" src="{html.escape(clip_relative)}"></audio></div>')
            matches = '<br>'.join(f'{html.escape(k)}: {v:.1f}s' for k,v in data['baseline_overlap'].items())
            content.append(f'<tr><td>{html.escape(speaker)}</td><td>{data["seconds"]:.1f}s ({data["turns"]} turns)</td><td>{matches}</td><td>{"".join(samples)}</td></tr>')
        content.append('</table></details>')
    content.append('</html>')
    path = root / 'report.html'
    partial = root / 'report.partial.html'
    partial.write_text('\n'.join(content))
    partial.replace(path)
    db.close()
    print(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--audio', required=True)
    p.add_argument('--case')
    p.add_argument('--expected-speakers', type=int, required=True)
    p.add_argument('--archive-db', default=str(ARCHIVE))
    p.add_argument('--baseline-video-id')
    p.set_defaults(func=prepare)
    p = sub.add_parser('run')
    p.add_argument('--case', required=True)
    p.add_argument('--mode', choices=['native', 'windowed'], required=True)
    p.add_argument('--device', default='cpu')
    p.add_argument('--runtime', default=str(CACHE/'NeMo-Speech.cpp/build-lab/bin/nemo-speech'))
    p.add_argument('--model', default=str(CACHE/'models/nemotron-3/Nemotron-3-Diarization.q8_0.gguf'))
    p.add_argument('--window-seconds', type=float, default=120)
    p.add_argument('--overlap-seconds', type=float, default=10)
    p.add_argument('--geometry', choices=['recording','live'], default='recording')
    p.set_defaults(func=run)
    p = sub.add_parser('report')
    p.set_defaults(func=report)
    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
