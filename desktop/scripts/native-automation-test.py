#!/usr/bin/env python3
"""Automatic AI through the native window; only synthetic archive/provider data."""
import http.server
import json
import os
import pathlib
import sqlite3
import subprocess
import threading
import time

repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(subprocess.check_output(['python3', str(pathlib.Path(__file__).with_name('prepare-health-review.py'))], text=True).strip())
requests = []
release = threading.Event()
seeded = threading.Event()
errors = []

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append((self.path, body))
        if self.path == '/v1/embeddings':
            assert body['model'] == 'native-embedding-fixture'
            assert all('Previous index content' in s for s in body['input']), body
            output = json.dumps({'data': [{'index': i, 'embedding': [1., 0.]} for i in range(len(body['input']))]})
            kind = 'application/json'
        else:
            assert self.path == '/v1/chat/completions'
            assert body['model'] == 'native-summary-fixture'
            assert 'Health Alice:' in body['messages'][1]['content']
            if sum(path == self.path for path, _ in requests) == 1:
                release.wait(60)
            output = 'data: ' + json.dumps({'choices': [{'delta': {'content': 'Automatic summary of the healthy passage.'}}]}) + '\n\n'
            output += 'data: ' + json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n'
            kind = 'text/event-stream'
        try:
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(output.encode())))
            self.end_headers()
            self.wfile.write(output.encode())
        except (BrokenPipeError, ConnectionResetError):
            pass

# The Rust queue tests exercise enqueue on transcription completion. Here we seed that
# durable completion in a scratch DB to exercise the real window without rerunning ASR.
def seed_completion():
    try:
        for _ in range(600):
            with sqlite3.connect(root / 'library.db', timeout=10) as db:
                found = db.execute("SELECT value FROM settings WHERE key='ai.automation'").fetchone()
                if found:
                    policy = json.loads(found[0])
                    if policy.get('embedding') and policy.get('summary'):
                        transcript = db.execute("SELECT transcript FROM media WHERE id='health-good'").fetchone()[0]
                        db.execute("INSERT INTO jobs(id,media_id,title,status) VALUES('native-completed','health-good','Healthy meeting','complete')")
                        for action in ('embedding', 'summary'):
                            db.execute("INSERT INTO ai_followups(id,parent_id,media_id,action,target,transcript) VALUES(?, 'native-completed','health-good',?,?,?)", (f'native-{action}', action, json.dumps(policy[action]), transcript))
                        seeded.set()
                        return
            time.sleep(.1)
        raise RuntimeError('AI actions were never enabled')
    except Exception as e:
        errors.append(str(e))

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Thread(target=seed_completion, daemon=True).start()
env = dict(os.environ, CONCORD_NEXT_DATA=str(root), CONCORD_NEXT_TEST_RECORDING='health-good', CONCORD_NEXT_TEST_SCRIPT=str(repo / 'desktop/scripts/native-automation-smoke.js'), CONCORD_NEXT_TEST_AI_URL=f'http://127.0.0.1:{server.server_port}/v1', GST_PLUGIN_PATH=str(repo / 'build/binaries/gstreamer'))
try:
    with open(root / 'automation.log', 'w') as log:
        result = subprocess.run([str(repo / 'desktop/src-tauri/target/debug/concord-next')], env=env, stdout=log, stderr=log, timeout=100)
    report = json.loads((root / 'native-test-result.json').read_text())
    assert result.returncode == 0 and report['ok'], (str(root), report)
    assert seeded.is_set() and not errors, errors
    assert len(requests) == 3, requests
    with sqlite3.connect(root / 'library.db') as db:
        assert db.execute("SELECT kind,source_id FROM ai_sources").fetchall() == [('recording', 'health-good')]
        assert db.execute("SELECT status FROM jobs WHERE id='native-completed'").fetchone()[0] == 'complete'
        assert db.execute('SELECT action,status FROM ai_followups ORDER BY action').fetchall() == [('embedding', 'complete'), ('summary', 'complete')]
        assert db.execute('PRAGMA user_version').fetchone()[0] == 12
    print(json.dumps({'root': str(root), **report}, indent=2))
finally:
    release.set()
    server.shutdown()
