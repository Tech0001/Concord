import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { NEMO_MODEL, NEMO_ARTIFACTS, verifyNemoArtifact } from "./nemo-runtime";
import { transcriptionDefaults } from "./transcription-config";
import { compatibleModelSelection, visibleModels } from "../client/src/lib/transcription-models";

test("native selection replaces a remembered legacy model without assuming CUDA", () => {
  for (const gpu of [true,false]) {
    const settings = transcriptionDefaults("nemo", gpu, "/managed/voice");
    assert.equal(settings.model, NEMO_MODEL);
    assert.equal(settings.device, "auto");
    assert.equal(settings.computeType, "q8_0");
  }
  assert.equal(compatibleModelSelection("nvidia/parakeet-tdt-0.6b-v3", NEMO_MODEL), NEMO_MODEL);
  assert.deepEqual(visibleModels("linux", NEMO_MODEL, "nemo").map(m => m.value), [NEMO_MODEL]);
});

test("model verification rejects corruption even when file size matches", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-model-test-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const file = path.join(root,"model.gguf");
  const data = Buffer.from("correct weights");
  fs.writeFileSync(file,data);
  const artifact = { ...NEMO_ARTIFACTS[0], size:data.length, sha256:createHash("sha256").update(data).digest("hex") } as typeof NEMO_ARTIFACTS[number];
  assert.equal(await verifyNemoArtifact(file,artifact),true);
  fs.writeFileSync(file,Buffer.alloc(data.length));
  assert.equal(await verifyNemoArtifact(file,artifact),false);
  assert.equal(await verifyNemoArtifact(path.join(root,"missing"),artifact),false);
});

test("staged retranscription replaces old speaker labels without pruning new ones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-staged-speakers-"));
  const { getDb, closeDb } = await import("./db");
  try {
    const db = getDb(path.join(root, "test.db"));
    const { postProcess } = await import("./transcribe-parakeet");
    const oldMd = path.join(root, "old.md");
    fs.writeFileSync(oldMd.replace(".md", ".json"), JSON.stringify({ segments: [{start:0,end:1,text:"Old",speaker:"S0"}] }));
    db.prepare("INSERT INTO video_queue (video_id,channel_id,title,url,md_path) VALUES ('v','c','Test','local',?)").run(oldMd);
    db.prepare("INSERT INTO speakers (id,name) VALUES ('saved','Saved voice')").run();
    db.prepare("INSERT INTO video_speaker_assignments (video_id,channel_id,local_speaker,centroid) VALUES ('v','c','S0',?)").run(Buffer.alloc(192 * 4));
    const jsonPath = path.join(root, "new.json");
    const diarPath = path.join(root, "new.diar.json");
    const words = [{start:0,end:1,text:"New."}];
    fs.writeFileSync(jsonPath, JSON.stringify({schema_version:2,model:NEMO_MODEL,words,segments:words,text:"New.",word_count:1,duration_seconds:1,realtime_factor:1}));
    fs.writeFileSync(diarPath, JSON.stringify({
      segments:[{speakerId:"13",startTimeSeconds:0,endTimeSeconds:1,qualityScore:1}],
      speakerProfiles:[{localSpeaker:"S12",centroid:Array(192).fill(1 / Math.sqrt(192)),airtimeSeconds:1,sampleStart:0,sampleEnd:1}],
    }));
    postProcess({ jsonPath, diarPath, outputMdPath:path.join(root,"new.md"), audioPath:"test.wav", model:NEMO_MODEL, diarize:true, videoId:"v", channelId:"c" });
    assert.deepEqual(db.prepare("SELECT local_speaker FROM video_speaker_assignments WHERE video_id='v'").all(), [{local_speaker:"S12"}]);
    assert.deepEqual(db.prepare("SELECT id,name FROM speakers").all(), [{id:"saved",name:"Saved voice"}]);
  } finally {
    closeDb();
    fs.rmSync(root, {recursive:true,force:true});
  }
});
