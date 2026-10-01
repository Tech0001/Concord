#!/usr/bin/env python3
"""Synthetic AI provider for integration tests. Receives fixture text only; no real credentials."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json, sys
from pathlib import Path
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'data':[{'id':'tiny-embedding'},{'id':'tiny-chat'}]}).encode())
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  self.send_response(200)
  if self.path.endswith('/embeddings'):
   self.send_header('Content-Type','application/json');self.end_headers()
   data=[{'index':i,'embedding':[1.,0.] if ('prayer' in text.lower() or 'faith' in text.lower()) else [0.,1.]} for i,text in enumerate(body['input'])]
   self.wfile.write(json.dumps({'data':data}).encode())
  else:
   self.send_header('Content-Type','text/event-stream');self.end_headers()
   for event in [{'choices':[{'delta':{'content':'Prayer supports the community [1].'}}]},{'choices':[{'delta':{},'finish_reason':'stop'}]}]:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
   self.wfile.write(b'data: [DONE]\n\n')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
Path(sys.argv[1]).write_text(f'http://127.0.0.1:{server.server_port}/v1')
server.serve_forever()
