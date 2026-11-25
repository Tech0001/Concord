#!/usr/bin/env python3
"""Exercise the Terminal in native WebKitGTK using only a scratch library."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import wave

repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix="concord-terminal-native-"))
(root / "incoming/nested").mkdir(parents=True)
for name in ("first.wav", "nested/second.wav"):
    with wave.open(str(root / "incoming" / name), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(b"\0\0" * 16000)
env = dict(os.environ, CONCORD_NEXT_DATA=str(root),
           CONCORD_NEXT_TEST_SCRIPT=str(repo / "desktop/scripts/native-terminal-smoke.js"),
           CONCORD_NEXT_TEST_RECORDING="terminal", GST_PLUGIN_PATH=str(repo / "build/binaries/gstreamer"))
with (root / "app.log").open("w") as log:
    result = subprocess.run([str(repo / "desktop/src-tauri/target/debug/concord-next")], env=env,
                            stdout=log, stderr=log, timeout=100)
report = json.loads((root / "native-test-result.json").read_text())
print(json.dumps({"root": str(root), **report}, indent=2), flush=True)
assert result.returncode == 0 and report["ok"]
