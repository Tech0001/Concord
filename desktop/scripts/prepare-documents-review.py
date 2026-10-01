#!/usr/bin/env python3
"""Prepare synthetic local files for native-documents-smoke.js; never modifies user files."""
import pathlib,subprocess,sys,base64,sqlite3,time
if len(sys.argv)>2 and sys.argv[1]=="--watch":
 root=pathlib.Path(sys.argv[2]);deadline=time.time()+90
 while time.time()<deadline:
  db=sqlite3.connect("file:"+str(root/"library.db")+"?mode=ro",uri=True)
  ready=db.execute("select count(*) from notes where title='__Document sync evidence'").fetchone()[0];db.close()
  if ready:
   path=root/"sources/nested/first.md";path.write_text(path.read_text().replace("Initial document evidence","Updated document evidence"));break
  time.sleep(.25)
 else:raise SystemExit("Native check did not reach the document edit")
 raise SystemExit(0)

root=pathlib.Path(subprocess.check_output([sys.executable,str(pathlib.Path(__file__).with_name('prepare-health-review.py'))],text=True).strip())
folder=root/'sources'/'nested';folder.mkdir(parents=True)
(folder/'first.md').write_text('---\ntitle: First source\nauthor: Health Alice\n---\n# First source\n\nInitial document evidence.\n\n![Local image](pixel.png)\n\n[Linked source](second.md)\n')
(folder/'second.md').write_text('# Linked source\n\nAnother document passage.\n')
(folder/'pixel.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII='))
print(root)
