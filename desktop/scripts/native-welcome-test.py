#!/usr/bin/env python3
"""Native first-run choice, restart persistence, and isolation between empty databases."""
import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile

repo = pathlib.Path(__file__).resolve().parents[2]
first = pathlib.Path(tempfile.mkdtemp(prefix='concord-welcome-native-'))
other = pathlib.Path(tempfile.mkdtemp(prefix='concord-welcome-other-'))
reports = []
for phase, root in [('start', first), ('restart', first), ('fresh', other)]:
    env = dict(os.environ, CONCORD_NEXT_DATA=str(root), CONCORD_NEXT_TEST_RECORDING=phase, CONCORD_NEXT_TEST_SCRIPT=str(repo / 'desktop/scripts/native-welcome-smoke.js'), GST_PLUGIN_PATH=str(repo / 'build/binaries/gstreamer'))
    with open(root / f'{phase}.log', 'w') as log:
        result = subprocess.run([str(repo / 'desktop/src-tauri/target/debug/concord-next')], env=env, stdout=log, stderr=log, timeout=45)
    report = json.loads((root / 'native-test-result.json').read_text())
    assert result.returncode == 0 and report['ok'], (str(root), phase, report)
    reports.append({'phase': phase, 'root': str(root), **report})
    with sqlite3.connect(root / 'library.db') as db:
        assert db.execute('SELECT count(*) FROM media').fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM settings WHERE key='imported_from'").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM settings WHERE key='library.started'").fetchone()[0] == (0 if phase == 'fresh' else 1)
print(json.dumps(reports, indent=2))
