#!/usr/bin/env python3
"""WebKitGTK Discover test against a local synthetic YouTube API; no real key needed."""
import http.server
import json
import os
import pathlib
import subprocess
import threading
import urllib.parse

repo=pathlib.Path(__file__).resolve().parents[2]
root=pathlib.Path(subprocess.check_output(['python3',str(pathlib.Path(__file__).with_name('prepare-health-review.py'))],text=True).strip())
from downloader_fixture import stage
fixture=root/"yt-dlp-fixture"
fixture.write_text("#!/bin/sh\nprintf 'fixture-1.0\\n'\n")
stage(root,fixture,"fixture-1.0")
requests=[]
def hit(id,title,description):
    return {'id':{'videoId':id},'snippet':{'title':title,'description':description,'channelTitle':'Synthetic source','channelId':'fake-channel','publishedAt':'2026-09-30T12:00:00Z'}}
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        q=urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        requests.append({k:v for k,v in q.items() if k!='key'})
        assert q.get('key')==['synthetic-native-key']
        if q.get('q')==['quota']:
            code=403;data={'error':{'message':'synthetic-native-key','errors':[{'reason':'quotaExceeded'}]}}
        else:
            code=200;data={'items':[hit('abc123_-XYZ','Prayer &amp; music study','A conversation about prayer.')]}
            if q.get('pageToken')==['next+page&2']:data['items'].append(hit('def456_-XYZ','Another conversation','A music reaction.'))
            else:data['nextPageToken']='next+page&2'
        body=json.dumps(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(os.environ,CONCORD_NEXT_DATA=str(root),CONCORD_NEXT_TEST_RECORDING='health-good',CONCORD_NEXT_TEST_SCRIPT=str(repo/'desktop/scripts/native-discover-smoke.js'),CONCORD_NEXT_TEST_YOUTUBE_URL=f'http://127.0.0.1:{server.server_port}/search',GST_PLUGIN_PATH=str(repo/'build/binaries/gstreamer'))
try:
    with open(root/'discover.log','w') as log:
        result=subprocess.run([str(repo/'desktop/src-tauri/target/debug/concord-next')],env=env,stdout=log,stderr=log,timeout=90)
    report=json.loads((root/'native-test-result.json').read_text());assert result.returncode==0 and report['ok'],report
    assert len(requests)==3,requests
    assert requests[0]['q']==requests[1]['q']==['prayer & music'],requests
    assert requests[1]['pageToken']==['next+page&2'],requests
    print(json.dumps({'root':str(root),**report},indent=2))
finally:server.shutdown()
