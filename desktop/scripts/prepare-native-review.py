#!/usr/bin/env python3
"""Make an isolated SQLite backup and synthetic media for native UI checks.
Usage: python3 desktop/scripts/prepare-native-review.py /path/to/library.db
Use the printed root and recording ID with CONCORD_NEXT_TEST_* in a debug review build.
The source connection is read-only. A fresh temporary folder is created on every run.
"""
import json
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import wave

source = Path(sys.argv[1]).resolve(strict=True)
root = Path(tempfile.mkdtemp(prefix="concord-native-review-"))
src = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
db = sqlite3.connect(root / "library.db")
src.backup(db)
src.close()
recording_id = "native-speaker-fixture"
media = root / "sample.wav"
with wave.open(str(media), "wb") as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(16000)
    audio.writeframes(b"\0\0" * 16000 * 25)
db.execute("INSERT INTO media(id,title,path,duration) VALUES (?,?,?,25)",
           (recording_id, "Native speaker fixture", str(media)))
# S0 and S1 represent two fingerprints of one person; S2 is a distinct voice.
for local, start, end, values in [("S0", 0, 8, [1., 0.]), ("S1", 8, 16, [.99, .01]), ("S2", 16, 25, [0., 1.])]:
    db.execute("INSERT INTO assignments(media_id,local_id,airtime,start,end,centroid) VALUES (?,?,?,?,?,?)",
               (recording_id, local, end-start, start, end, struct.pack("<ff", *values)))
    db.execute("INSERT INTO segments(media_id,start,end,speaker,text) VALUES (?,?,?,?,?)",
               (recording_id, start, end, local, "Native speaker test passage"))
# Test history independently of the user's jobs. This affects only the new copy.
db.execute("DELETE FROM jobs")
db.execute("INSERT INTO jobs(id,media_id,title,status,message) VALUES ('native-old-job',?,'Previous test attempt','failed','An earlier failure')", (recording_id,))
db.commit()
db.close()
(root / "Native document fixture.md").write_text("# Native document fixture\n\nThis is a selected document passage.\n")
print(json.dumps({"root": str(root), "id": recording_id}))
