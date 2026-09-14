import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PipelineConfig } from "./pipeline-types";
import { outputFolderError, pipelineSetupStatus, setRuntimeInstalling } from "./pipeline-readiness";
import { pipelineSetupGate, requiresPipelineSetup } from "./pipeline-setup-gate";
import { resolveTranscriptionPython, transcriptionDefaults } from "./transcription-config";

const config = (): PipelineConfig => ({
  videoSaveDir: "/archive/videos", transcriptDir: "/archive/transcripts",
  videoQuality: "1080", videoCodec: "any", youtubeSpeedPreset: "conservative",
  checkIntervalMinutes: 1440, dailyDownloadCap: 200,
  transcription: { ...transcriptionDefaults("whisper", false, "/runtime"), language: "en", beamSize: 5 },
} as PipelineConfig);
const probes = { folder: () => null, runtime: () => null };

test("first use requires explicit completion even with valid settings", () => {
  const setup = pipelineSetupStatus(config(), false, probes);
  assert.equal(setup.requirementsMet, true);
  assert.equal(setup.ready, false);
  assert.equal(pipelineSetupStatus(config(), true, probes).ready, true);
});

test("completion does not bypass missing folders or a broken engine", () => {
  const missingDisk = pipelineSetupStatus(config(), true, { ...probes, folder: value => value.endsWith("videos") ? "Drive unavailable" : null });
  assert.equal(missingDisk.ready, false);
  assert.equal(missingDisk.checks[0].detail, "Drive unavailable");
  const interruptedInstall = pipelineSetupStatus(config(), true, { ...probes, runtime: () => "Packages missing" });
  assert.equal(interruptedInstall.ready, false);
  assert.equal(interruptedInstall.checks[2].detail, "Packages missing");
});

test("invalid schedules and download limits cannot finish setup", () => {
  for (const updates of [{ checkIntervalMinutes: 0 }, { checkIntervalMinutes: NaN }, { dailyDownloadCap: -1 }, { dailyDownloadCap: 1.5 }, { videoQuality: "invalid" }]) {
    assert.equal(pipelineSetupStatus({ ...config(), ...updates }, true, probes).ready, false);
  }
  assert.equal(pipelineSetupStatus({ ...config(), dailyDownloadCap: 0 }, true, probes).ready, true);
});

test("a running installation cannot be marked ready using packages from the previous engine", () => {
  setRuntimeInstalling(true);
  try {
    const status = pipelineSetupStatus(config(), true, probes);
    assert.equal(status.requirementsMet, false);
    assert.match(status.checks[2].detail, /installation/);
  } finally { setRuntimeInstalling(false); }
});

test("storage inspection allows creating subfolders but rejects files and relative paths", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "concord-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "file"), "content");
  assert.equal(outputFolderError(path.join(dir, "new", "transcripts")), null);
  assert.equal(fs.existsSync(path.join(dir, "new")), false);
  assert.match(outputFolderError(path.join(dir, "file", "child"))!, /file/);
  assert.match(outputFolderError("~/videos")!, /absolute/);
  assert.match(outputFolderError("")!, /Choose/);
});

test("CPU and NVIDIA installation defaults select matching model, device and Python", () => {
  const cpu = transcriptionDefaults("whisper", false, "/installed/venv");
  assert.equal(cpu.model, "small");
  assert.equal(cpu.device, "cpu");
  assert.equal(cpu.computeType, "int8");
  assert.equal(cpu.pythonVenv, "/installed/venv/bin/python");
  const gpu = transcriptionDefaults("parakeet", true, "/installed/venv");
  assert.equal(gpu.model, "nvidia/parakeet-tdt-0.6b-v3");
  assert.equal(gpu.device, "cuda");
});

test("wizard runtime takes precedence over a stale legacy Whisper override", () => {
  assert.equal(resolveTranscriptionPython({ engine: "whisper", venvPath: "/installed/venv", pythonVenv: "/old/venv/bin/python" }, false), "/installed/venv/bin/python");
});

test("a managed environment without its success marker cannot finish setup", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "concord-incomplete-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  try {
    const c = config();
    c.transcription = { ...c.transcription, ...transcriptionDefaults("whisper", false, path.join(dir, "concord/venv")) };
    const status = pipelineSetupStatus(c, true, { folder: () => null, platform: "linux" });
    assert.equal(status.ready, false);
    assert.match(status.checks[2].detail, /Finish installing/);
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("CPU float16 is rejected before an engine process is started", () => {
  const c = config();
  c.transcription.computeType = "float16";
  const status = pipelineSetupStatus(c, true, { folder: () => null, platform: "linux" });
  assert.equal(status.ready, false);
  assert.match(status.checks[2].detail, /CPU transcription needs/);
});

test("processing endpoints are gated while setup, stop and cancellation remain available", () => {
  for (const route of ["/api/pipeline/start", "/api/videos/download", "/api/pipeline/retranscribe", "/api/voice-notes/start", "/api/voice-notes/id/chunk", "/api/voice-notes/id/finalize"]) {
    assert.equal(requiresPipelineSetup("POST", route), true, route);
  }
  for (const route of ["/api/pipeline/setup/complete", "/api/pipeline/config", "/api/transcription/install", "/api/pipeline/stop", "/api/voice-notes/id/cancel"]) {
    assert.equal(requiresPipelineSetup("POST", route), false, route);
  }
  assert.equal(requiresPipelineSetup("GET", "/api/pipeline/start"), false);
});

test("setup middleware returns actionable 409 before any work is accepted", () => {
  const setup = pipelineSetupStatus(config(), false, probes);
  let nextCalled = false;
  let status = 0;
  let body: any;
  const response = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; } };
  pipelineSetupGate(() => setup)({ method: "POST", path: "/api/videos/download" } as any, response as any, () => { nextCalled = true; });
  assert.equal(status, 409);
  assert.equal(body.setupUrl, "/pipeline/setup");
  assert.equal(nextCalled, false);
  pipelineSetupGate(() => ({ ...setup, ready: true }))({ method: "POST", path: "/api/videos/download" } as any, response as any, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
