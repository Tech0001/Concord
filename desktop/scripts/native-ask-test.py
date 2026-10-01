#!/usr/bin/env python3
"""Run the global Ask regression with a fresh library and local synthetic provider.

Build the debug app against a running Vite server first; the native test hook
exists only in debug builds. Never uses the installed library or an AI account.
"""
import pathlib,tempfile,subprocess,time,os,sqlite3,wave,json
repo=pathlib.Path(__file__).resolve().parents[2];root=pathlib.Path(tempfile.mkdtemp(prefix='concord-ask-native-'));(root/'empty').mkdir()
with wave.open(str(root/'fixture.wav'),'wb') as w:w.setparams((1,2,16000,0,'NONE',''));w.writeframes(b'\x00\x00'*16000*30)
server=subprocess.Popen(['python3',str(repo/'desktop/scripts/native-ask-provider.py'),str(root)])
app=None
try:
 for _ in range(50):
  if (root/'provider-url').exists():break
  time.sleep(.1)
 env=os.environ.copy();env.update(CONCORD_NEXT_DATA=str(root),CONCORD_NEXT_TEST_SCRIPT=str(repo/'desktop/scripts/native-ask-smoke.js'),CONCORD_NEXT_TEST_RECORDING='fixture-a',CONCORD_NEXT_TEST_AI_URL=(root/'provider-url').read_text(),GST_PLUGIN_PATH=str(repo/'build/binaries/gstreamer'))
 with (root/'app.log').open('w') as log:
  app=subprocess.Popen([str(repo/'desktop/src-tauri/target/debug/concord-next')],env=env,stdout=log,stderr=log)
  for _ in range(200):
   if (root/'library.db').exists():
    db=sqlite3.connect(root/'library.db',timeout=10)
    if db.execute('pragma user_version').fetchone()[0]>=15:break
    db.close()
   time.sleep(.1)
  else:raise RuntimeError('App schema not ready')
  with db:
   for rid,title,text in [('fixture-a','Synthetic recording A','RECORDING_ONLY_QUERY selected recording evidence.'),('fixture-b','Synthetic recording B','RECORDING_ONLY_QUERY OTHER_RECORDING_SECRET evidence.')]:
    db.execute("insert into media(id,title,path,duration,category,status) values(?,?,?,30,'personal','complete')",(rid,title,str(root/'fixture.wav')))
    db.execute("insert into segments(media_id,start,end,text) values(?,0,10,?)",(rid,text))
   for did,title in [('doc-a','Synthetic document A'),('doc-b','Synthetic document B')]:db.execute("insert into docs(id,title,body) values(?,?,?)",(did,title,'ARCHIVE_SENTINEL synthetic evidence '+title))
   db.execute("insert into channels(id,name,url,kind,enabled,check_status) values('source','PRIVATE_SOURCE_SENTINEL',?,'folder',1,'complete')",(str(root/'empty'),))
  db.close()
  try:result=app.wait(timeout=200)
  except subprocess.TimeoutExpired:app.terminate();app.wait(timeout=10);raise
 print(root)
 print((root/'native-test-result.json').read_text() if (root/'native-test-result.json').exists() else 'No report')
 if result:raise SystemExit(result)
finally:
 server.terminate();server.wait(timeout=10)
 if app and app.poll() is None:app.terminate()
