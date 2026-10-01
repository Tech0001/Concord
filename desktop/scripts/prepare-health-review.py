#!/usr/bin/env python3
"""Create a small native health fixture using a read-only copy of the current schema.
No archive content or live records are copied or modified.
"""
import pathlib,sqlite3,tempfile,wave,json
root=pathlib.Path(tempfile.mkdtemp(prefix='concord-health-native-'))
source=pathlib.Path.home()/'.local/share/concord-next/library.db'
src=sqlite3.connect(f'file:{source}?mode=ro',uri=True);db=sqlite3.connect(root/'library.db')
for typ in ['table','index','trigger']:
 for name,sql in src.execute("select name,sql from sqlite_master where type=? and sql is not null",(typ,)):
  if name.startswith('sqlite_') or (name.startswith('segments_') and name not in ('segments_fts','segments_insert','segments_delete','segments_update','segments_recording_time')):continue
  db.execute(sql)
src.close();db.execute('pragma user_version=5')
with wave.open(str(root/'sample.wav'),'wb') as wav:
 wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(8000);wav.writeframes(b'\0\0'*8000*10)
(root/'copy.wav').write_bytes((root/'sample.wav').read_bytes())
md=root/'transcript.md';md.write_text('# Transcript\n- [00:00 → 00:05] **S0:** A new searchable prayer.\n- [00:05 → 00:10] **S1:** Another passage.\n')
for id,title,path,trans in [('health-good','Healthy meeting',root/'sample.wav',md),('health-copy','Copy recording',root/'copy.wav',None),('health-missing','Missing transcript fixture',root/'sample.wav',root/'missing.md')]:
 db.execute("insert into media(id,title,path,transcript,status,duration) values(?,?,?,?,?,10)",(id,title,str(path),str(trans) if trans else None,'ready' if trans is None else 'complete'))
db.execute("insert into segments(media_id,start,end,speaker,text) values('health-good',0,5,'S0','Previous index content')")
db.execute("insert into speakers(id,name) values('health-person','Health Alice')")
db.execute("insert into assignments(media_id,local_id,speaker_id) values('health-good','S0','health-person')")
db.execute("insert into notes(id,title,body) values('health-note','Backup test note','Research retained')")
db.commit();db.close();print(root)
