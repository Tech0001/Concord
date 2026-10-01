#!/usr/bin/env python3
"""Fixture-only server for native-help-smoke.js; rejects wrong context or private diagnostics."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json, sys
root=Path(sys.argv[1])
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  text=json.dumps(body);messages=body['messages'];system=messages[0]['content'];last=messages[-1]['content']
  failures=[]
  if 'Filtered app status' in text:
   for private in ['PRIVATE_SOURCE_SENTINEL','FIXTURE_PRIVATE_KEY','ARCHIVE_SENTINEL','GENERAL_REQUEST_SENTINEL','GENERAL_RESPONSE_SENTINEL',str(root)]:
    if private in text: failures.append('Help included private or other-context data: '+private)
   if 'speech' not in text or 'recentErrors' not in text: failures.append('Missing status')
   answer='HELP_RESPONSE_SENTINEL: Check your source, then start the queue when ready. [Sources](#/pipeline?tab=sources)'
  elif 'Library evidence' in last:
   if 'ARCHIVE_SENTINEL' not in last: failures.append('Missing archive excerpt')
   if 'HELP_RESPONSE_SENTINEL' in text or 'GENERAL_REQUEST_SENTINEL' in text: failures.append('Other context in archive')
   answer='ARCHIVE_RESPONSE_SENTINEL [1].'
  else:
   if 'HELP_RESPONSE_SENTINEL' in text or 'recentErrors' in text or 'ARCHIVE_SENTINEL' in text: failures.append('Other context in general chat')
   answer='GENERAL_RESPONSE_SENTINEL'
  with (root/'requests.jsonl').open('a') as f: f.write(json.dumps({'failures':failures,'body':body})+'\n')
  self.send_response(500 if failures else 200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  if failures: return
  for event in [{'choices':[{'delta':{'content':answer}}]},{'choices':[{'delta':{},'finish_reason':'stop'}]}]:
   self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
  self.wfile.write(b'data: [DONE]\n\n')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
(root/'provider-url').write_text(f'http://127.0.0.1:{server.server_port}/v1')
server.serve_forever()
