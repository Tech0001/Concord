#!/usr/bin/env python3
"""Isolated native source/download fixture. Its fake yt-dlp never accesses the network."""
import pathlib,subprocess,sys
root=pathlib.Path(subprocess.check_output([sys.executable,str(pathlib.Path(__file__).with_name('prepare-health-review.py'))],text=True).strip())
folder=root/'incoming';folder.mkdir();(folder/'meeting.wav').write_bytes((root/'sample.wav').read_bytes())
tool=root/'yt-dlp-fixture.py'
tool.write_text('''#!/usr/bin/env python3
import sys,json,pathlib,urllib.parse
root=pathlib.Path(__file__).resolve().parents[3]
args=sys.argv[1:]
if '--version' in args:print('fixture-1.0');raise SystemExit(0)
with (root/'fixture-calls.jsonl').open('a') as log:log.write(json.dumps(args)+'\\n')
if '--flat-playlist' in args:
 print(json.dumps({'_type':'playlist','id':'channel','entries':[{'id':'fixture0001','title':'First subscription recording'},{'id':'fixture0002','title':'Second subscription recording'}]}))
elif '--dump-single-json' in args:
 id=urllib.parse.parse_qs(urllib.parse.urlparse(args[-1]).query)['v'][0]
 print(json.dumps({'id':id,'title':'Downloaded '+id,'duration':10,'upload_date':'20260930','live_status':'not_live'}))
else:
 out=pathlib.Path(args[args.index('--output')+1].replace('%(ext)s','wav'))
 out.write_bytes((root/'sample.wav').read_bytes())
 print('CONCORD_PROGRESS:100%')
 print('CONCORD_FILE:'+json.dumps(str(out)))
''')
tool.chmod(0o755)
from downloader_fixture import stage
stage(root,tool,"fixture-1.0")
print(root)
