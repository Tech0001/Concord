#!/usr/bin/env python3
"""Small isolated grouped-search fixture; no live data is modified."""
import pathlib,sqlite3,subprocess,sys
root=pathlib.Path(subprocess.check_output([sys.executable,str(pathlib.Path(__file__).with_name('prepare-health-review.py'))],text=True).strip())
db=sqlite3.connect(root/'library.db')
db.execute('delete from segments')
db.execute("update media set date='20260930',channel='Meetings' where id='health-good'")
db.execute("update media set date='20260805',channel='Recordings' where id='health-copy'")
db.executemany('insert into segments(media_id,start,end,speaker,text) values(?,?,?,?,?)',[
 ('health-good',1,3,'S0','A quiet harbour awaits.'),
 ('health-good',5,7,'S0','We passed the harbour quietly.'),
 ('health-copy',2,4,'S1','The harbour at dawn.'),
 ('health-copy',6,8,'S1','Quiet voices filled the harbour.')])
db.execute("insert into docs(id,title,body) values('harbour-doc','Harbour guide','A harbour guide.')")
db.commit();db.close();print(root)
