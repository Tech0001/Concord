import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { firstRunConfigRepairs } from "./first-run-config";

const legacy = {
  videoSaveDir: "/media/pc/Maac/YouTube/saved_videos",
  transcriptDir: "/media/pc/Maac/YouTube/transcripts",
  "transcription.model": "nvidia/parakeet-tdt-0.6b-v3",
  "transcription.device": "cuda",
  "transcription.computeType": "float16",
};

test("unfinished empty profiles discard unavailable historical defaults, preserving real settings", () => {
  const repairs = firstRunConfigRepairs(legacy, false, () => false, false);
  assert.equal(repairs.videoSaveDir, "");
  assert.equal(repairs.transcriptDir, "");
  assert.equal(repairs["transcription.model"], "");
  assert.deepEqual(firstRunConfigRepairs(legacy, true, () => false, false), {});
  assert.deepEqual(firstRunConfigRepairs({ ...legacy, "pipeline.setupCompleted": "true" }, false, () => false, false), {});
  assert.deepEqual(firstRunConfigRepairs(legacy, false, () => true, true), {});
  const custom = firstRunConfigRepairs({ ...legacy, videoSaveDir: "/my/offline/disk/videos", "transcription.engine": "whisper" }, false, () => false, true);
  assert.equal(custom.videoSaveDir, undefined);
  assert.equal(custom["transcription.model"], undefined);
});

// Exercise the actual database, Pipeline defaults, hardware probes and HTTP
// routes in separate processes. A fresh XDG profile and fake nvidia-smi keep
// these tests independent of the developer's GPU, library and Python installs.
for (const scenario of ["cpu", "5090", "small-gpu", "upgrade", "existing"] as const) {
  test(`first-run HTTP configuration: ${scenario}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-first-run-"));
    try {
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      const gpu = scenario === "5090" || scenario === "existing" ? "NVIDIA GeForce RTX 5090, 32768" : scenario === "small-gpu" ? "NVIDIA test GPU, 4096" : "";
      fs.writeFileSync(path.join(bin, "nvidia-smi"), gpu ? `#!/bin/sh\nprintf '%s\\n' '${gpu}'\n` : "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { createServer } from 'node:http';
        import express from ${JSON.stringify(import.meta.resolve("express"))};
        import { getDb, setConfigValues, closeDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).href)};
        import { Pipeline } from ${JSON.stringify(new URL("./pipeline.ts", import.meta.url).href)};
        import { getSetupStatus } from ${JSON.stringify(new URL("./transcription-setup.ts", import.meta.url).href)};
        import { registerSystemRoutes } from ${JSON.stringify(new URL("./routes-system.ts", import.meta.url).href)};
        const scenario = ${JSON.stringify(scenario)};
        if (scenario === 'upgrade') setConfigValues(${JSON.stringify(legacy)});
        if (scenario === 'existing') setConfigValues({videoSaveDir: '/my/archive/videos', transcriptDir: '/my/archive/text', 'pipeline.setupCompleted': true, 'transcription.engine': 'whisper', 'transcription.model': 'medium', 'transcription.device': 'cpu', 'transcription.computeType': 'float32'});
        const pipeline = new Pipeline();
        const app = express(); app.use(express.json());
        const server = createServer(app);
        const calls = [];
        registerSystemRoutes(app, pipeline, server, async (kind, opts) => {
          calls.push({kind, opts});
          return kind === 'directory' ? {path: '/chosen/folder'} : {cancelled: true};
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        try {
          const config = await fetch(base + '/api/pipeline/config').then(r => r.json());
          const status = getSetupStatus();
          if (scenario === 'existing') {
            assert.equal(config.videoSaveDir, '/my/archive/videos');
            assert.equal(config.transcription.model, 'medium');
            assert.equal(config.transcription.device, 'cpu');
            assert.equal(config.transcription.computeType, 'float32');
          } else {
            assert.equal(config.videoSaveDir, ''); assert.equal(config.transcriptDir, '');
            assert.equal(status.installed, false);
            assert.equal(config.transcription.model, status.recommendedSettings.model);
            assert.equal(config.transcription.device, status.recommendedSettings.device);
            assert.equal(config.transcription.computeType, status.recommendedSettings.computeType);
            assert.equal(status.recommendedEngine, 'nemo');
            assert.equal(config.transcription.model, 'nvidia/nemotron-3.5-asr-streaming-0.6b');
            assert.equal(config.transcription.device, 'auto');
            assert.equal(config.processing.diarizationEnabled, true);
            const setup = await fetch(base + '/api/pipeline/setup').then(r => r.json());
            assert.equal(setup.ready, false);
            const finish = await fetch(base + '/api/pipeline/setup/complete', {method: 'POST'});
            assert.equal(finish.status, 409);
            if (scenario === 'cpu') {
              pipeline.updateConfig({transcription: {...config.transcription, device: 'cuda'}});
              assert.match(pipeline.getSetupStatus().checks[2].detail, /Install Nemotron/);
            }
          }
          const folder = await fetch(base + '/api/dialog/pick-folder', {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({prompt:'Save videos', defaultPath:'/missing/parent'})});
          assert.equal(folder.status, 200);
          assert.deepEqual(await folder.json(), {path:'/chosen/folder'});
          const file = await fetch(base + '/api/dialog/pick-file', {method:'POST'});
          assert.deepEqual(await file.json(), {cancelled:true});
          assert.deepEqual(calls.map(c=>c.kind), ['directory','file']);
          assert.equal(calls[0].opts.defaultPath, '/missing/parent');
        } finally {
          server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
          pipeline.stop(); closeDb();
        }
      `;
      const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
        cwd: root,
        env: { ...process.env, XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        encoding: "utf8", timeout: 40_000,
      });
      assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
