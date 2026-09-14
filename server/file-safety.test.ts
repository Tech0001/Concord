import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDistinctOutputPath, pathsReferToSameFile, unlinkDerivedFile } from "./file-safety";
import { copyAudioTrack, extractAudio } from "./audio";

test("file identity recognizes equivalent paths and hard links", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "concord-file-safety-"));
  const source = path.join(folder, "recording.m4a");
  const hardLink = path.join(folder, "same-bytes.m4a");
  fs.writeFileSync(source, "source media must survive");
  fs.linkSync(source, hardLink);

  assert.equal(pathsReferToSameFile(source, path.join(folder, ".", "recording.m4a")), true);
  assert.equal(pathsReferToSameFile(source, hardLink), true);
  assert.throws(() => assertDistinctOutputPath(source, hardLink, "test extraction"), /same file/);
});

test("derived cleanup refuses a source alias but removes an actual scratch file", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "concord-safe-unlink-"));
  const source = path.join(folder, "recording.wav");
  const scratch = path.join(folder, "recording.retranscribe.wav");
  fs.writeFileSync(source, "source media must survive");
  fs.writeFileSync(scratch, "temporary data");

  assert.equal(unlinkDerivedFile(source, [source], "test cleanup"), false);
  assert.equal(fs.existsSync(source), true);
  assert.equal(unlinkDerivedFile(scratch, [source], "test cleanup"), true);
  assert.equal(fs.existsSync(scratch), false);
});

test("ffmpeg wrappers reject same-file output before spawning", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "concord-audio-output-"));
  const source = path.join(folder, "recording.m4a");
  fs.writeFileSync(source, "source media must survive");

  assert.throws(() => extractAudio(source, source), /same file/);
  await assert.rejects(copyAudioTrack(source, source), /same file/);
  assert.equal(fs.readFileSync(source, "utf8"), "source media must survive");
});
