#!/usr/bin/env python3
"""Native CPU ASR preview using an explicitly provided local speech file, never a microphone.

Usage: native-live-preview-test.py /path/to/speech.ogg --offset 600
The original file and real archive are read-only. Requires the existing speech models,
FFmpeg, a desktop session and a native-review debug build. Transcript text stays local.
"""
import argparse
import json
import os
import pathlib
import subprocess

args = argparse.ArgumentParser()
args.add_argument("audio", type=pathlib.Path)
args.add_argument("--offset", default=0, type=float)
args = args.parse_args()
assert args.audio.is_file(), "Provide a local recording containing speech"
repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(subprocess.check_output(["python3", str(pathlib.Path(__file__).with_name("prepare-health-review.py"))], text=True).strip())
audio = root / "speech-input.wav"
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(args.offset), "-i", str(args.audio), "-t", "25", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio)], check=True)
(root / "fences.md").write_text("# Code fence fixture\n\n```c++ title=example\nint main() { return 0; }\n```\n\n~~~~sh\necho safe\n~~~~\n\nRenderer reached the final paragraph.\n")
env = dict(os.environ, CONCORD_NEXT_DATA=str(root), CONCORD_NEXT_TEST_RECORDING="health-good", CONCORD_NEXT_TEST_CAPTURE_AUDIO=str(audio), CONCORD_NEXT_TEST_SCRIPT=str(repo / "desktop/scripts/native-live-preview-smoke.js"), GST_PLUGIN_PATH=str(repo / "build/binaries/gstreamer"))
with open(root / "live-preview.log", "w") as log:
    result = subprocess.run([str(repo / "desktop/src-tauri/target/debug/concord-next")], env=env, stdout=log, stderr=log, timeout=420)
report = json.loads((root / "native-test-result.json").read_text())
assert result.returncode == 0 and report["ok"], (root, report)
first = report
recovery = root / "recover-preview.js"
recovery.write_text('''const invoke=(cmd,args)=>window.__TAURI_INTERNALS__.invoke(cmd,args);
const s=await invoke('tools_state');
const draft=s.recorder.sessions.find(s=>s.preview?.length);
if(!draft||s.recorder.active||s.liveTranscript.running)throw Error('Preview and stopped capture were not retained across restart');
const saved=await invoke('recorder_save',{id:draft.id,title:'Saved preview fixture',category:'personal',transcribe:false,device:'cpu'});
const recording=await invoke('recording',{id:saved.id});
if(recording.transcript?.length)throw Error('Partial preview was published as a final transcript');
return {passed:['preview and audio survive restart, and Save does not publish partial text as a final transcript'],sections:draft.preview.length};
''')
env["CONCORD_NEXT_TEST_SCRIPT"] = str(recovery)
with open(root / "live-recovery.log", "w") as log:
    result = subprocess.run([str(repo / "desktop/src-tauri/target/debug/concord-next")], env=env, stdout=log, stderr=log, timeout=45)
report = json.loads((root / "native-test-result.json").read_text())
assert result.returncode == 0 and report["ok"], (root, report)
print(json.dumps({"root":str(root), "preview":first, "recovery":report}, indent=2))
