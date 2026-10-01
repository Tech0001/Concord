#!/usr/bin/env python3
"""Native multi-window playback against a synthetic video and a scratch archive."""
import json
import os
import pathlib
import sqlite3
import subprocess

repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(subprocess.check_output(['python3', str(pathlib.Path(__file__).with_name('prepare-health-review.py'))], text=True).strip())
video = root / 'synthetic.mp4'
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(video)], check=True)
with sqlite3.connect(root / 'library.db') as db:
    db.execute("UPDATE media SET path=?,duration=60 WHERE id='health-good'", (str(video),))
    db.execute("DELETE FROM segments WHERE media_id='health-good'")
    for start, end, text in [(0, 2, 'First passage'), (5, 7, 'Second passage'), (15, 50, 'Later passage')]:
        db.execute("INSERT INTO segments(media_id,start,end,speaker,text) VALUES('health-good',?,?,'S0',?)", (start, end, text))
env = dict(os.environ, CONCORD_NEXT_DATA=str(root), CONCORD_NEXT_TEST_RECORDING='health-good', CONCORD_NEXT_TEST_SCRIPT=str(repo / 'desktop/scripts/native-popout-smoke.js'), GST_PLUGIN_PATH=str(repo / 'build/binaries/gstreamer'))
with open(root / 'popout.log', 'w') as log:
    result = subprocess.run([str(repo / 'desktop/src-tauri/target/debug/concord-next')], env=env, stdout=log, stderr=log, timeout=150)
report = json.loads((root / 'native-test-result.json').read_text())
assert result.returncode == 0 and report['ok'], (root, report)
print(json.dumps({'root': str(root), **report}, indent=2))
