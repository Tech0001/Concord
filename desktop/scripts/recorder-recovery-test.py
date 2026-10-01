#!/usr/bin/env python3
"""Native Linux regression: kill a synthetic capture, restart, recover and play it.

Requires a desktop session and a debug review build (see native-tools-smoke.js).
Never opens a microphone or touches the real archive.
"""
import json
import os
import pathlib
import signal
import subprocess
import time

repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(subprocess.check_output(["python3", str(pathlib.Path(__file__).with_name("prepare-health-review.py"))], text=True).strip())
binary = repo / "desktop/src-tauri/target/debug/concord-next"
start = root / "start-capture.js"
start.write_text('''const invoke=(cmd,args)=>window.__TAURI_INTERNALS__.invoke(cmd,args);
await invoke('recorder_start',{input:'concord-test-tone',title:'Recovered native capture',category:'personal'});
await new Promise(()=>{});
''')
finish = root / "recover-capture.js"
finish.write_text('''const invoke=(cmd,args)=>window.__TAURI_INTERNALS__.invoke(cmd,args);
const state=await invoke('tools_state');
const s=state.recorder.sessions[0];
if(state.recorder.active||!s||s.status!=='recovered'||s.seconds<1)throw Error('Interrupted capture not recovered');
const url=await invoke('recorder_preview',{id:s.id});
const audio=document.createElement('audio');audio.src=url;document.body.append(audio);
await new Promise((resolve,reject)=>{audio.onloadedmetadata=resolve;audio.onerror=()=>reject(Error('Recovered WAV did not load'));setTimeout(()=>reject(Error('Playback timeout')),15000);});
await audio.play();await new Promise(r=>setTimeout(r,300));if(audio.currentTime<=0)throw Error('Recovered audio did not play');audio.pause();
const saved=await invoke('recorder_save',{id:s.id,title:s.title,category:s.category,transcribe:false,device:'cpu'});
return {passed:['forced exit preserves captured PCM, releases the capture process, repairs the WAV header and restores native playback'],seconds:s.seconds,id:saved.id};
''')
env = dict(os.environ, CONCORD_NEXT_DATA=str(root), CONCORD_NEXT_TEST_RECORDING="health-good",
           CONCORD_NEXT_TEST_SCRIPT=str(start), GST_PLUGIN_PATH=str(repo / "build/binaries/gstreamer"))
log = open(root / "recovery.log", "w")
proc = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
try:
    deadline = time.monotonic() + 30
    while True:
        assert proc.poll() is None, "Capture app exited unexpectedly"
        files = list((root / "voice-recordings").glob("*/recording.wav"))
        if files and files[0].stat().st_size > 64044:
            break
        assert time.monotonic() < deadline, "No synthetic audio captured"
        time.sleep(0.1)
    children = []
    for thread in pathlib.Path(f"/proc/{proc.pid}/task").iterdir():
        children.extend(int(pid) for pid in (thread / "children").read_text().split())
    captures = [pid for pid in children if pathlib.Path(f"/proc/{pid}/comm").read_text().strip() == "ffmpeg"]
    assert captures, "No capture child found"
    proc.kill()
    proc.wait(timeout=5)
    time.sleep(0.3)
    for pid in captures:
        path = pathlib.Path(f"/proc/{pid}/status")
        assert not path.exists() or "State:\tZ" in path.read_text(), "Capture outlived the application"
    env["CONCORD_NEXT_TEST_SCRIPT"] = str(finish)
    restarted = subprocess.run([str(binary)], env=env, stdout=log, stderr=log, timeout=45)
    result = json.loads((root / "native-test-result.json").read_text())
    assert restarted.returncode == 0 and result["ok"], result
    print(json.dumps({"root": str(root), **result}, indent=2))
finally:
    if proc.poll() is None:
        proc.send_signal(signal.SIGKILL)
        proc.wait(timeout=5)
    log.close()
