#!/usr/bin/env python3
"""Native Settings opt-in, real official download/update, disable and restart persistence."""
import hashlib,json,os,pathlib,sqlite3,subprocess,tempfile
repo=pathlib.Path(__file__).resolve().parents[2]
root=pathlib.Path(tempfile.mkdtemp(prefix='concord-downloader-native-'))
reports=[]
for phase in ('install','restart'):
 env=dict(os.environ,CONCORD_NEXT_DATA=str(root),CONCORD_NEXT_TEST_SCRIPT=str(repo/'desktop/scripts/native-downloader-smoke.js'),CONCORD_NEXT_TEST_RECORDING=phase,GST_PLUGIN_PATH=str(repo/'build/binaries/gstreamer'))
 with (root/(phase+'.log')).open('w') as log:
  run=subprocess.run([str(repo/'desktop/src-tauri/target/debug/concord-next')],env=env,stdout=log,stderr=log,timeout=260)
 report=json.loads((root/'native-test-result.json').read_text())
 print(json.dumps({'root':str(root),'phase':phase,**report},indent=2),flush=True)
 assert run.returncode==0 and report['ok']
 reports.append(report)
active=json.loads((root/'download-tools/active.json').read_text())
folder=root/'download-tools/versions'/active['directory']
assert hashlib.sha256((folder/'yt-dlp').read_bytes()).hexdigest()==active['hash']
assert (folder/'LICENSE').is_file() and (folder/'THIRD_PARTY_LICENSES.txt').is_file()
with sqlite3.connect(root/'library.db') as db:
 assert db.execute("select value from settings where key='downloads.enabled'").fetchone()[0]=='false'
 assert db.execute('select count(*) from media').fetchone()[0]==0
