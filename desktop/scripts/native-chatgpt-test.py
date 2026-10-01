#!/usr/bin/env python3
"""Synthetic OAuth + Responses end-to-end in WebKitGTK. Never opens ChatGPT or uses real credentials."""
import base64
import hashlib
import http.server
import json
import os
import pathlib
import subprocess
import threading
import time
import urllib.parse
import urllib.request

repo=pathlib.Path(__file__).resolve().parents[2]
root=pathlib.Path(subprocess.check_output(['python3',str(pathlib.Path(__file__).with_name('prepare-health-review.py'))],text=True).strip())
fixtures=repo/'desktop/src-tauri/test-data/chatgpt'
requests=[]
attempts={}
errors=[]
stop=threading.Event()
release=threading.Event()

def b64(data):return base64.urlsafe_b64encode(data).rstrip(b'=').decode()
def token(nonce,client):
    header=b64(json.dumps({'alg':'RS256','typ':'JWT','kid':'concord-test-only'}).encode())
    claims=b64(json.dumps({'iss':'https://auth.openai.com','sub':'native-user','aud':client,'nonce':nonce,'email':'native@example.invalid','iat':int(time.time()),'exp':int(time.time())+3600}).encode())
    payload=f'{header}.{claims}'
    signature=subprocess.check_output(['openssl','dgst','-sha256','-sign',str(fixtures/'test-only-private.pem')],input=payload.encode())
    return f'{payload}.{b64(signature)}'
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def send(self,status,data,stream=False):
        body=data.encode() if isinstance(data,str) else json.dumps(data).encode()
        try:
            self.send_response(status);self.send_header('Content-Type','text/event-stream' if stream else 'application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError):pass
    def do_GET(self):
        if self.path=='/.well-known/jwks.json':self.send(200,json.loads((fixtures/'jwks.json').read_text()))
        elif self.path=='/.well-known/openid-configuration':self.send(200,{'issuer':'https://auth.openai.com','revocation_endpoint':base+'/api/accounts/oauth/revoke'})
        elif self.path=='/v1/models':
            assert self.headers.get('Authorization')=='Bearer native-access'
            self.send(200,{'models':[{'slug':'native-chat','display_name':'Native ChatGPT fixture','visibility':'list'},{'slug':'hidden','display_name':'Hidden','visibility':'hidden'}]})
        else:self.send(404,{})
    def do_POST(self):
        raw=self.rfile.read(int(self.headers['Content-Length']))
        if self.path=='/api/accounts/oauth/token':
            form={k:v[0] for k,v in urllib.parse.parse_qs(raw.decode()).items()}
            a=attempts[form['code']]
            assert form['client_id']==a['issued'] and form['redirect_uri']==a['redirect_uri'][0]
            assert b64(hashlib.sha256(form['code_verifier'].encode()).digest())==a['code_challenge'][0]
            assert form['resource']=='https://api.openai.com/v1'
            requests.append('token')
            self.send(200,{'access_token':'native-access','refresh_token':'native-refresh','id_token':token(a['nonce'][0],a['issued']),'token_type':'Bearer','expires_in':3600,'scope':'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'})
        elif self.path=='/api/accounts/oauth/revoke':
            form=urllib.parse.parse_qs(raw.decode());assert form['token']==['native-refresh'];requests.append('revoke');self.send(200,'')
        elif self.path=='/v1/responses':
            payload=json.loads(raw);assert self.headers.get('Authorization')=='Bearer native-access';assert set(payload)=={'model','input','store','stream'};assert payload['store'] is False and payload['stream'] is True
            assert all(m['role']!='system' for m in payload['input'])
            requests.append('responses')
            last=payload['input'][-1]['content']
            if last=='Wait for cancellation':
                (root/'request-waiting').write_text('yes');release.wait(60)
            text='OK' if last=='Reply with OK.' else 'Native ChatGPT response completed.'
            data='data: '+json.dumps({'type':'response.output_text.delta','delta':text})+'\n\n'
            data+='data: '+json.dumps({'type':'response.completed','response':{'status':'completed'}})+'\n\n'
            self.send(200,data,True)
        else:self.send(404,{})
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
base=f'http://127.0.0.1:{server.server_port}'
threading.Thread(target=server.serve_forever,daemon=True).start()
def callback_driver():
    seen=set()
    try:
        while not stop.wait(.05):
            path=root/'test-chatgpt-authorization.json'
            if not path.exists():continue
            url=json.loads(path.read_text())['url'];q=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            state=q['state'][0]
            if state in seen:continue
            seen.add(state)
            assert q['code_challenge_method']==['S256'] and q['scope'][0].find('chatgpt.tokens.use.direct')>=0
            issued=q['client_id'][0]
            if issued=='dynamic_agent_client':issued='oaiapp_native_'+str(len(seen));assert q['agent_name_hint']==['Concord']
            else:assert 'agent_name_hint' not in q
            q['issued']=issued;code='synthetic-code-'+str(len(seen));attempts[code]=q
            callback=q['redirect_uri'][0]+'?'+urllib.parse.urlencode({'state':state,'code':code,'client_id':issued})
            time.sleep(.75)
            with urllib.request.urlopen(callback,timeout=20) as response:assert response.status==200
    except Exception as e:errors.append(repr(e))
threading.Thread(target=callback_driver,daemon=True).start()
env=dict(os.environ,CONCORD_NEXT_DATA=str(root),CONCORD_NEXT_TEST_RECORDING='health-good',CONCORD_NEXT_TEST_SCRIPT=str(repo/'desktop/scripts/native-chatgpt-smoke.js'),CONCORD_CHATGPT_TEST_ENDPOINT=base,GST_PLUGIN_PATH=str(repo/'build/binaries/gstreamer'))
try:
    with open(root/'chatgpt.log','w') as log:result=subprocess.run([str(repo/'desktop/src-tauri/target/debug/concord-next')],env=env,stdout=log,stderr=log,timeout=180)
    report=json.loads((root/'native-test-result.json').read_text());assert result.returncode==0 and report['ok'],(root,report,errors)
    assert not errors,errors
    assert requests.count('token')==2 and 'revoke' in requests and requests.count('responses')>=3,requests
    assert all(a['ext_agent_host_id']==next(iter(attempts.values()))['ext_agent_host_id'] for a in attempts.values())
    print(json.dumps({'root':str(root),**report},indent=2))
finally:stop.set();release.set();server.shutdown()
