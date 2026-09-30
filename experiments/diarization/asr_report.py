#!/usr/bin/env python3
"""Private, local report for the transcription runtime comparison."""
import difflib
import html
import json
from pathlib import Path
import re

import lab


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
    rows = db.execute("SELECT * FROM asr_runs WHERE status='complete' ORDER BY created_at").fetchall()
    groups = {}
    for row in rows:
        config = json.loads(row['config'])
        result = json.loads((root/'asr/runs'/row['id']/'transcript.json').read_text())
        groups.setdefault(config['audio_sha256'], []).append(
            (row['id'], config, json.loads(row['metrics']), result))
    out = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
           '<title>Concord transcription test</title><style>body{font:16px system-ui;max-width:1100px;margin:30px auto;padding:0 20px;background:#15171c;color:#eee}a{color:#9bd0ff}td,th{padding:10px;border-bottom:1px solid #444;text-align:left}table{border-collapse:collapse;width:100%}pre{white-space:pre-wrap}summary{cursor:pointer;padding:12px 0}</style>',
           '<p><a href="../report.html">Speaker detection tests</a></p><h1>Parakeet: same transcription model, native runtime</h1>',
           '<p>Parakeet writes the words. Nemotron Diarization labels who spoke when. NeMo-Speech.cpp can run both. This page tests the Parakeet runtime change, with speaker detection turned off.</p>',
           '<p>CPU means no GPU acceleration for this worker. Tests use this PC’s i7-13700K; lower-spec PCs and Macs have not been measured. Native runs use the official Q8 model; the current Python pipeline uses its original precision.</p>',
           '<p>Worker time includes process startup and model loading. RAM is sampled peak process memory. Word disagreement compares two automatic outputs; it does not tell us which one is correct.</p>']
    comparisons = []
    for runs in groups.values():
        config = runs[0][1]
        out.append(f'<h2>{html.escape(Path(config["audio"]).stem)} ({config["duration_seconds"]/60:g} minutes)</h2>')
        try:
            audio = Path(config['audio']).relative_to(root/'asr').as_posix()
            out.append(f'<audio controls preload="none" src="{html.escape(audio)}"></audio>')
        except ValueError:
            pass
        out.append('<table><tr><th>Runtime / device</th><th>Seconds</th><th>Faster than real time</th><th>RAM MiB</th><th>GPU memory MiB</th><th>Timed words</th></tr>')
        for rid, c, m, result in runs:
            out.append(f'<tr><td>{html.escape(c["engine"])} / {html.escape(c["device"])}</td><td>{m["worker_seconds"]}</td><td>{m["audio_seconds_per_worker_second"]}×</td><td>{m["sampled_peak_worker_rss_mib"]}</td><td>{m["sampled_peak_worker_vram_mib"] if m["sampled_peak_worker_vram_mib"] is not None else "—"}</td><td>{m["word_timestamps"]}</td></tr>')
        out.append('</table>')
        current = next((r for r in runs if r[1]['engine']=='current'), None)
        cpu = next((r for r in runs if r[1]['engine']=='native' and r[1]['device']=='cpu'), None)
        for rid, c, m, result in runs:
            reference = current if c['engine']=='native' else None
            if reference:
                a, b = tokens(reference[3]['text']), tokens(result['text'])
                edits = edit_distance(a,b)
                percent = round(100*edits/len(a),2) if a else None
                comparisons.append({'reference':reference[0], 'candidate':rid, 'reference_words':len(a),
                                    'candidate_words':len(b), 'word_edits':edits, 'word_disagreement_percent':percent})
                out.append(f'<p><strong>{html.escape(c["engine"])} / {html.escape(c["device"])}:</strong> {edits} word edits versus the current runtime ({percent}% of its word count; punctuation and capitalization ignored).</p>')
                changes=[]
                for op,i,j,k,l in difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes():
                    if op!='equal':
                        changes.append(f'{" ".join(a[i:j]) or "∅"} → {" ".join(b[k:l]) or "∅"}')
                out.append('<details><summary>Word differences: current → native</summary><pre>'+html.escape('\n'.join(changes))+'</pre></details>')
            if cpu and c['engine']=='native' and c['device']!='cpu':
                a,b = tokens(cpu[3]['text']),tokens(result['text'])
                count = edit_distance(a,b)
                percent = round(100*count/len(a),2) if a else None
                out.append(f'<p>Native CPU versus {html.escape(c["device"])}: {count} word edits across {len(a)} words ({percent}% disagreement).</p>')
            out.append(f'<details><summary>Transcript: {html.escape(c["engine"])} / {html.escape(c["device"])}</summary><p>{html.escape(result["text"])}</p><a href="runs/{html.escape(rid)}/transcript.json">Words and timestamps</a> · <a href="runs/{html.escape(rid)}/summary.json">Measurements</a></details>')
    out.append('</html>')
    (root/'asr/comparisons.json').write_text(json.dumps(comparisons,indent=2))
    path = root/'asr/report.html'
    path.write_text('\n'.join(out))
    db.close()
    print(path)


if __name__ == '__main__':
    report()
