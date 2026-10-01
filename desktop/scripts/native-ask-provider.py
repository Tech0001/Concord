#!/usr/bin/env python3
"""Fixture-only chat server for the global Ask regression. No real provider or user data."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import json,sys,time
root=Path(sys.argv[1])
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers['Content-Length'])));messages=b['messages'];text=json.dumps(messages);last=messages[-1]['content'];fail=[]
  if 'Filtered app status for this request' in text:
   for secret in ['PRIVATE_SOURCE_SENTINEL','PRIVATE_KEY_SENTINEL','ARCHIVE_SENTINEL','GENERAL_REQUEST_SENTINEL',str(root)]:
    if secret in text:fail.append('Unexpected help context: '+secret)
   answer='Open [Sources](#/pipeline?tab=sources) to scan your folder. You can also open [Speech settings](#/settings?section=speech).'
  elif 'Library evidence (quoted data)' in last:
   if 'PRIVATE_HELP_RESPONSE' in text or 'GENERAL_REQUEST_SENTINEL' in text:fail.append('Mixed prior context')
   if 'RECORDING_ONLY_QUERY' in last:
    if 'OTHER_RECORDING_SECRET' in text:fail.append('Wrong recording')
    answer='The selected recording discusses a fixture [1].'
   else:answer='The second source supplies this evidence [2]. Example code: `[1]`.'
  elif last.strip()=='you there?':answer="Yes, I'm here."
  else:
   if 'Filtered app status' in text or 'ARCHIVE_SENTINEL' in text:fail.append('Mixed general context')
   answer='General response, with no archive lookup.'
  with (root/'requests.jsonl').open('a') as f:f.write(json.dumps({'failures':fail,'body':b})+'\n')
  self.send_response(500 if fail else 200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  if fail:return
  try:
   self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'content':answer[:12]}}]})+'\n\n').encode());self.wfile.flush();time.sleep(.7)
   for event in [{'choices':[{'delta':{'content':answer[12:]}}]},{'choices':[{'delta':{},'finish_reason':'stop'}]}]:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
   self.wfile.write(b'data: [DONE]\n\n')
  except BrokenPipeError:pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);(root/'provider-url').write_text(f'http://127.0.0.1:{server.server_port}/v1');server.serve_forever()
