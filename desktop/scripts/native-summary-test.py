#!/usr/bin/env python3
"""Native summary progress, re-entry, cancellation and publication; synthetic HTTP only."""
import http.server
import json
import os
import pathlib
import sqlite3
import subprocess
import threading

repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(subprocess.check_output(['python3', str(pathlib.Path(__file__).with_name('prepare-health-review.py'))], text=True).strip())
with sqlite3.connect(root / 'library.db') as db:
    db.execute("INSERT INTO ai_summaries(media_id,content,model,digest) VALUES('health-good','Previous saved summary','old-model','old-digest')")
requests = []
release = threading.Event()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        assert self.path == '/v1/chat/completions'
        assert 'Health Alice:' in body['messages'][1]['content']
        if len(requests) == 1:
            release.wait(60)
        text = '# Completed summary\n\nHealth Alice discussed the indexed passage at 0 seconds.'
        stream = 'data: ' + json.dumps({'choices': [{'delta': {'content': text}, 'finish_reason': None}]}) + '\n\n'
        stream += 'data: ' + json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n'
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(stream.encode())))
            self.end_headers()
            self.wfile.write(stream.encode())
        except (BrokenPipeError, ConnectionResetError):
            pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = dict(os.environ, CONCORD_NEXT_DATA=str(root), CONCORD_NEXT_TEST_RECORDING='health-good', CONCORD_NEXT_TEST_SCRIPT=str(repo / 'desktop/scripts/native-summary-smoke.js'), CONCORD_NEXT_TEST_AI_URL=f'http://127.0.0.1:{server.server_port}/v1', GST_PLUGIN_PATH=str(repo / 'build/binaries/gstreamer'))
try:
    with open(root / 'summary.log', 'w') as log:
        result = subprocess.run([str(repo / 'desktop/src-tauri/target/debug/concord-next')], env=env, stdout=log, stderr=log, timeout=90)
    report = json.loads((root / 'native-test-result.json').read_text())
    assert result.returncode == 0 and report['ok'], (root, report)
    assert len(requests) == 2, requests
    with sqlite3.connect(root / 'library.db') as db:
        assert db.execute('SELECT status FROM summary_jobs ORDER BY rowid').fetchall() == [('cancelled',), ('complete',)]
        assert db.execute('PRAGMA user_version').fetchone()[0] == 13
    print(json.dumps({'root': str(root), **report}, indent=2))
finally:
    release.set()
    server.shutdown()
