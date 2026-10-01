#!/usr/bin/env python3
"""Synthetic files on the home filesystem, with a private desktop Trash for native checks."""
import pathlib,sqlite3,subprocess,tempfile,shutil,json
root=pathlib.Path(subprocess.check_output(['python3',str(pathlib.Path(__file__).with_name('prepare-health-review.py'))],text=True).strip())
assets=pathlib.Path(tempfile.mkdtemp(prefix='concord-file-review-',dir=pathlib.Path.home()/'.cache'))
for name in ['recording.wav','copy.wav','backup.wav']:shutil.copyfile(root/'sample.wav',assets/name)
db=sqlite3.connect(root/'library.db');db.execute("update media set path=? where id in ('health-good','health-missing')",(str(assets/'recording.wav'),));db.execute("update media set path=? where id='health-copy'",(str(assets/'copy.wav'),));db.execute("update media set date='20260930'");db.execute("insert into note_anchors(id,note_id,position,media_id,start,end,quote) values('file-anchor','health-note',0,'health-good',0,5,'Previous index content')");db.commit();db.close();(root/'file-fixture.json').write_text(json.dumps({'assets':str(assets),'xdg':str(assets/'xdg')}));print(root)
