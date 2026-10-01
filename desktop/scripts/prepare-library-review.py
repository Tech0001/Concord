#!/usr/bin/env python3
"""Small native library fixture; only synthetic content and temporary media."""
import json,pathlib,sqlite3,subprocess
root=pathlib.Path(subprocess.check_output(['python3',str(pathlib.Path(__file__).with_name('prepare-search-review.py'))],text=True).strip())
db=sqlite3.connect(root/'library.db')
db.execute("update media set category='work' where id='health-good'")
db.execute("insert into jobs(id,media_id,title,status,message) values('library-failure','health-good','Healthy meeting','failed','Synthetic replacement failure; old text retained')")
db.execute("insert into docs(id,title,body,category) values('work-doc','Work harbour guide','Work harbour evidence','work')")
db.execute("insert into notes(id,title,body) values('work-note','Work evidence','Work harbour evidence'),('personal-note','Personal evidence','Personal harbour evidence')")
db.execute("insert into note_anchors(id,note_id,position,media_id,start,end) values('work-anchor','work-note',0,'health-good',1,3),('personal-anchor','personal-note',0,'health-copy',2,4)")
for id,category in [('work-source','work'),('personal-source','personal')]:
 db.execute("insert into channels(id,name,category,kind) values(?,?,?,'collection')",(id,id,category))
db.commit();db.close();print(root)
