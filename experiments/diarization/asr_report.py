#!/usr/bin/env python3
"""Private, local report for the transcription runtime comparison."""
import difflib
import html
import json
from pathlib import Path
import re

import lab


def label(config):
    names = {
        'nvidia/parakeet-tdt-0.6b-v3': 'Parakeet v3',
        'nvidia/nemotron-speech-streaming-en-0.6b': 'Nemotron English',
        'nvidia/nemotron-3.5-asr-streaming-0.6b': 'Nemotron 3.5 multilingual',
    }
    model = names.get(config['model'], config['model'])
    engine = 'current Python' if config['engine'] == 'current' else 'native C++'
    context = ' / exported lookahead' if config.get('right_context') == -1 else ''
    if config.get('right_context') is not None and config['right_context'] >= 0:
        context = f' / lookahead {config["right_context"]} frames'
    return f'{model} / {engine} / {config["device"]} / {config.get("mode", "offline")}{context}'


def matching_cpu(runs, config):
    return next((r for r in runs if r[1]['engine'] == 'native' and r[1]['device'] == 'cpu'
                 and all(r[1].get(k, default) == config.get(k, default)
                         for k, default in [('model', ''), ('mode', 'offline'), ('language', 'auto'),
                                            ('right_context', None)])), None)


def tokens(text):
    return re.findall(r"\w+(?:'\w+)?", text.lower().replace('’', "'"))


def edit_distance(reference, candidate):
    previous = list(range(len(candidate)+1))
    for i, word in enumerate(reference, 1):
        current = [i]
        for j, other in enumerate(candidate, 1):
            current.append(min(current[-1]+1, previous[j]+1, previous[j-1]+(word != other)))
        previous = current
    return previous[-1]


def report(root=lab.DEFAULT_ROOT):
    db, root = lab.connect_lab(root)
    manifest = root/'asr/clips.json'
    clips = {c['audio']: c for c in json.loads(manifest.read_text())} if manifest.exists() else {}
    rows = db.execute("SELECT * FROM asr_runs WHERE status='complete' ORDER BY created_at").fetchall()
    groups = {}
    for row in rows:
        config = json.loads(row['config'])
        result = json.loads((root/'asr/runs'/row['id']/'transcript.json').read_text())
        groups.setdefault(config['audio_sha256'], []).append(
            (row['id'], config, json.loads(row['metrics']), result))
    out = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
           '<title>Concord transcription test</title><style>body{font:16px system-ui;max-width:1100px;margin:30px auto;padding:0 20px;background:#15171c;color:#eee}a{color:#9bd0ff}td,th{padding:10px;border-bottom:1px solid #444;text-align:left}table{border-collapse:collapse;width:100%}pre{white-space:pre-wrap}summary{cursor:pointer;padding:12px 0}</style>',
           '<p><a href="../report.html">Speaker detection tests</a></p><h1>Transcription: Parakeet versus Nemotron ASR</h1>',
           '<p>This page compares the models that write the words. Nemotron ASR is a transcription alternative to Parakeet. Nemotron Diarization is a separate model that detects who spoke when; speaker detection is turned off for these tests.</p>',
           '<p>Lower seconds means faster. Lower RAM and GPU memory means lighter. Word differences need listening review: extra words can be recovered speech or mistakes, and fewer words can be omissions or removed hallucinations.</p>',
           '<p>CPU means no GPU acceleration for this worker. Tests use this PC’s i7-13700K; lower-spec PCs and Macs have not been measured. Native runs use the official Q8 model; the current Python pipeline uses its original precision.</p>',
           '<p>Worker time includes process startup and model loading. RAM is sampled peak process memory. Word disagreement compares two automatic outputs; it does not tell us which one is correct.</p>']
    findings = root/'asr/findings.json'
    if findings.exists():
        out.append('<h2>What the tests show</h2><ul>' + ''.join(
            '<li>'+html.escape(note)+'</li>' for note in json.loads(findings.read_text())) + '</ul>')
    comparisons = []
    for runs in sorted(groups.values(), key=lambda r: not bool(clips.get(r[0][1]['audio'], {}).get('purpose'))):
        config = runs[0][1]
        clip = clips.get(config['audio'], {})
        offset = clip.get('offset_seconds', 0)
        name = (f'{clip["case"]}: original minutes {offset/60:g}–{(offset+config["duration_seconds"])/60:g}'
                if clip else Path(config['audio']).stem)
        out.append(f'<h2 id="{html.escape(Path(config["audio"]).stem)}">{html.escape(name)} ({config["duration_seconds"]/60:g}-minute excerpt)</h2>')
        if clip.get('purpose'):
            out.append('<p>'+html.escape(clip['purpose'])+'</p>')
        try:
            audio = Path(config['audio']).relative_to(root/'asr').as_posix()
            out.append(f'<audio controls preload="none" src="{html.escape(audio)}"></audio>')
        except ValueError:
            pass
        out.append('<table><tr><th>Model / runtime / device / mode</th><th>Seconds</th><th>Faster than real time</th><th>RAM MiB</th><th>GPU memory MiB</th><th>Timed words</th></tr>')
        for rid, c, m, result in runs:
            out.append(f'<tr><td>{html.escape(label(c))}</td><td>{m["worker_seconds"]}</td><td>{m["audio_seconds_per_worker_second"]}×</td><td>{m["sampled_peak_worker_rss_mib"]}</td><td>{m["sampled_peak_worker_vram_mib"] if m["sampled_peak_worker_vram_mib"] is not None else "—"}</td><td>{m["word_timestamps"]}</td></tr>')
        out.append('</table>')
        current = next((r for r in runs if r[1]['engine']=='current'), None)
        if Path(config['audio']).is_relative_to(root/'asr'):
            # Keep the listening view small: current baseline plus the latest
            # GPU candidate per model (or CPU when GPU is not available).
            selected = {}
            for run in runs:
                key = (run[1]['engine'], run[1]['model'])
                old = selected.get(key)
                if old is None or run[1]['device'] != 'cpu' or old[1]['device'] == 'cpu':
                    selected[key] = run
            for window in clip.get('review_windows', []):
                out.append('<h3>Priority listening check</h3><p>'+html.escape(window['note'])+'</p>')
                out.append('<audio controls preload="none" src="'+html.escape(window['audio'])+'"></audio>')
                for r in selected.values():
                    excerpt = ' '.join(w['text'] for w in r[3]['words'] if window['start'] <= w['start'] < window['end'])
                    out.append('<p><strong>'+html.escape(label(r[1]))+'</strong><br>'+html.escape(excerpt or '[No transcribed words]')+'</p>')
            out.append('<details><summary>Listen and compare in 30-second sections</summary>')
            out.append('<p>Row labels show the original recording time when known; audio-player time starts at the beginning of this excerpt. Compare against the audio, especially when one model adds or drops a sentence.</p>')
            out.append('<div style="overflow:auto"><table><tr><th>Excerpt audio</th>' + ''.join(
                '<th>'+html.escape(label(r[1]))+'</th>' for r in selected.values()) + '</tr>')
            for start in range(0, int(config['duration_seconds']), 30):
                end = min(start+30, config['duration_seconds'])
                a, b = int(offset+start), int(offset+end)
                out.append(f'<tr><td>{a//60}:{a%60:02d}–{b//60}:{b%60:02d}<br><audio controls preload="none" style="width:180px" src="{html.escape(audio)}#t={start},{end}"></audio></td>')
                for r in selected.values():
                    excerpt = ' '.join(w['text'] for w in r[3]['words'] if start <= w['start'] < end)
                    out.append('<td style="vertical-align:top;min-width:230px">'+html.escape(excerpt or '[No transcribed words]')+'</td>')
                out.append('</tr>')
            out.append('</table></div></details>')
        for rid, c, m, result in runs:
            cpu = matching_cpu(runs, c)
            reference = current if c['engine']=='native' else None
            if reference:
                a, b = tokens(reference[3]['text']), tokens(result['text'])
                edits = edit_distance(a,b)
                percent = round(100*edits/len(a),2) if a else None
                comparisons.append({'reference':reference[0], 'candidate':rid, 'reference_words':len(a),
                                    'candidate_words':len(b), 'word_edits':edits, 'word_disagreement_percent':percent})
                out.append(f'<p><strong>{html.escape(label(c))}:</strong> {edits} word edits versus current Python Parakeet ({percent}% of its word count; punctuation and capitalization ignored).</p>')
                changes=[]
                for op,i,j,k,l in difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes():
                    if op!='equal':
                        changes.append(f'{" ".join(a[i:j]) or "∅"} → {" ".join(b[k:l]) or "∅"}')
                out.append('<details><summary>Word differences: current Parakeet → this candidate</summary><pre>'+html.escape('\n'.join(changes))+'</pre></details>')
            if cpu and c['engine']=='native' and c['device']!='cpu':
                a,b = tokens(cpu[3]['text']),tokens(result['text'])
                count = edit_distance(a,b)
                percent = round(100*count/len(a),2) if a else None
                out.append(f'<p>Same model and mode, CPU versus {html.escape(c["device"])}: {count} word edits across {len(a)} words ({percent}% disagreement).</p>')
            out.append(f'<details><summary>Transcript: {html.escape(label(c))}</summary><p>{html.escape(result["text"])}</p><a href="runs/{html.escape(rid)}/transcript.json">Words and timestamps</a> · <a href="runs/{html.escape(rid)}/summary.json">Measurements</a></details>')
            if c.get('measurement_note'):
                out.append('<p>'+html.escape(c['measurement_note'])+'</p>')
    out.append('</html>')
    (root/'asr/comparisons.json').write_text(json.dumps(comparisons,indent=2))
    path = root/'asr/report.html'
    path.write_text('\n'.join(out))
    db.close()
    print(path)


if __name__ == '__main__':
    report()
