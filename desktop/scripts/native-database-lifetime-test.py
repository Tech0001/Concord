#!/usr/bin/env python3
"""Linux native regression: WAL sidecars must persist across IPC calls until exit.

Build the debug app against a running Vite server first. Uses inotify so even brief
delete/recreate cycles are detected. All data stays in a new temporary library.
"""
import ctypes
import json
import os
from pathlib import Path
import select
import sqlite3
import struct
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix="concord-database-native-"))
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
assert fd >= 0, "Cannot initialize inotify"
CREATE, DELETE = 0x100, 0x200
assert libc.inotify_add_watch(fd, os.fsencode(root), CREATE | DELETE) >= 0
events = []


def collect():
    while select.select([fd], [], [], 0)[0]:
        data = os.read(fd, 65536)
        offset = 0
        while offset < len(data):
            _, mask, _, size = struct.unpack_from("iIII", data, offset)
            offset += 16
            name = data[offset:offset + size].split(b"\0", 1)[0].decode()
            offset += size
            if name in ("library.db-wal", "library.db-shm"):
                events.append((name, "create" if mask & CREATE else "delete"))


env = dict(os.environ, CONCORD_NEXT_DATA=str(root),
           CONCORD_NEXT_TEST_SCRIPT=str(repo / "desktop/scripts/native-database-lifetime-smoke.js"),
           CONCORD_NEXT_TEST_RECORDING="database-lifetime",
           GST_PLUGIN_PATH=str(repo / "build/binaries/gstreamer"))
app = None
try:
    with (root / "app.log").open("w") as log:
        app = subprocess.Popen([str(repo / "desktop/src-tauri/target/debug/concord-next")],
                               env=env, stdout=log, stderr=log)
        deadline = time.monotonic() + 90
        while app.poll() is None:
            collect()
            if time.monotonic() > deadline:
                raise TimeoutError("Native database test timed out")
            time.sleep(.025)
        collect()
    report = json.loads((root / "native-test-result.json").read_text())
    counts = {name: {kind: events.count((name, kind)) for kind in ("create", "delete")}
              for name in ("library.db-wal", "library.db-shm")}
    print(json.dumps({"root": str(root), **report, "sidecar_events": counts}, indent=2), flush=True)
    assert app.returncode == 0 and report["ok"], "Native IPC regression failed"
    for name, count in counts.items():
        assert count == {"create": 1, "delete": 1}, f"Sidecar churn: {name}: {count}"
        assert not (root / name).exists(), "Sidecar not cleaned up on normal exit"
    # Only open SQLite after measuring the app lifecycle; the observer adds no connections.
    for path in (root / "library.db", Path(report["backup"])):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
            assert db.execute("pragma integrity_check").fetchone()[0] == "ok"
            assert db.execute("select title from ai_conversations where id=?",
                              [report["conversationId"]]).fetchone()[0] == "Database lifetime test"
    print("Sidecars stayed open across 60 IPC reads; normal exit and backup preserved writes.")
finally:
    os.close(fd)
    if app is not None and app.poll() is None:
        app.terminate()
        app.wait(timeout=10)
