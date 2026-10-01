#!/usr/bin/env python3
"""Exercise folder scanning and record-only removal in the native WebKitGTK app."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import wave

repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='concord-folder-native-'))
(root / 'empty').mkdir()
(root / 'incoming/nested').mkdir(parents=True)
(root / 'documents').mkdir()
(root / 'documents/notes.md').write_text('# Test document\nLocal document indexing.\n')
files = [root / 'incoming/first.wav', root / 'incoming/nested/second.wav']
for path in files:
    with wave.open(str(path), 'wb') as output:
        output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        output.writeframes(b'\0\0' * 16000)
(root / 'incoming/ignore.txt').write_text('Not media')
digests = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
env = dict(os.environ, CONCORD_NEXT_DATA=str(root),
           CONCORD_NEXT_TEST_SCRIPT=str(repo / 'desktop/scripts/native-folder-smoke.js'),
           CONCORD_NEXT_TEST_RECORDING='folders', GST_PLUGIN_PATH=str(repo / 'build/binaries/gstreamer'))
with (root / 'app.log').open('w') as log:
    run = subprocess.run([str(repo / 'desktop/src-tauri/target/debug/concord-next')], env=env,
                         stdout=log, stderr=log, timeout=140)
report = json.loads((root / 'native-test-result.json').read_text())
print(json.dumps({'root': str(root), **report}, indent=2), flush=True)
assert run.returncode == 0 and report['ok']
for path in files:
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digests[str(path)]
with sqlite3.connect(root / 'library.db') as db:
    assert db.execute('pragma foreign_key_check').fetchall() == []
    assert db.execute('select count(*) from media').fetchone()[0] == 2
    assert db.execute('select count(*) from docs').fetchone()[0] == 1
print('Original media bytes unchanged; database references valid.')
