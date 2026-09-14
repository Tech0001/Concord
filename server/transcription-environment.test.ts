import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectPython, prepareTranscriptionEnvironment, TranscriptionSetupError, venvDir, type InstallProgress } from "./transcription-setup";

// XDG isolates the managed environment on Linux. Never point these tests at
// the user's actual venv, and never download packages or models in this suite.
const python = process.platform === "linux" ? detectPython() : null;
const skip = !python?.ok ? "Requires Linux and Python 3.10–3.13 with ensurepip" : false;

function isolatedEnvironment(t: { after: (fn: () => void) => void }) {
  const previous = process.env.XDG_DATA_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-venv-test-"));
  process.env.XDG_DATA_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "concord"));
  const library = path.join(root, "concord/pipeline.db");
  fs.writeFileSync(library, "library sentinel");
  return { dir: venvDir(), library };
}

test("repairs a real reused Python environment with no pip, preserving its files and the library", { skip }, async t => {
  const { dir, library } = isolatedEnvironment(t);
  const created = spawnSync(python!.path, ["-m", "venv", "--without-pip", dir], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const py = path.join(dir, "bin/python");
  const missing = spawnSync(py, ["-m", "pip", "--version"], { encoding: "utf8" });
  assert.match(missing.stderr, /No module named pip/);
  const sentinel = path.join(dir, "existing-package-sentinel");
  fs.writeFileSync(sentinel, "preserve me");
  fs.writeFileSync(path.join(dir, "concord-engine.txt"), "whisper\n");
  const progress: InstallProgress[] = [];
  assert.equal(await prepareTranscriptionEnvironment(python!, event => progress.push(event)), py);
  const pip = spawnSync(py, ["-m", "pip", "--version"], { encoding: "utf8" });
  assert.equal(pip.status, 0, pip.stderr);
  assert.ok(pip.stdout.includes(dir), "pip must come from the managed venv");
  assert.ok(progress.some(event => event.line.includes("Restoring pip")));
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve me");
  assert.equal(fs.readFileSync(library, "utf8"), "library sentinel");
  assert.equal(fs.existsSync(path.join(dir, "concord-engine.txt")), false, "only the engine import check may mark success");
  progress.length = 0;
  await prepareTranscriptionEnvironment(python!, event => progress.push(event));
  assert.equal(progress.some(event => event.line.includes("Restoring pip") || event.line.includes("rebuilding")), false);
});

test("rebuilds an environment whose Python reports a version but cannot bootstrap pip", { skip }, async t => {
  const { dir, library } = isolatedEnvironment(t);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin/python"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.12.14"; exit 0; fi\necho "No module named ensurepip" >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "concord-engine.txt"), "parakeet\n");
  const progress: InstallProgress[] = [];
  const py = await prepareTranscriptionEnvironment(python!, event => progress.push(event));
  assert.ok(progress.some(event => event.line.includes("recreating it with the detected Python")));
  assert.equal(spawnSync(py, ["-m", "pip", "--version"]).status, 0);
  assert.equal(fs.readFileSync(library, "utf8"), "library sentinel");
  assert.equal(fs.existsSync(path.join(dir, "concord-engine.txt")), false);
});

test("unsupported Python reports prerequisite guidance before touching the environment", { skip }, async t => {
  const { dir } = isolatedEnvironment(t);
  fs.mkdirSync(dir);
  const marker = path.join(dir, "concord-engine.txt");
  fs.writeFileSync(marker, "whisper\n");
  await assert.rejects(prepareTranscriptionEnvironment({ ...python!, ok: false, error: "Python 3.14 is unsupported" }, () => {}), error => {
    assert.ok(error instanceof TranscriptionSetupError);
    assert.match(error.hint, /Python 3.10–3.13/);
    assert.doesNotMatch(error.hint, /Parakeet/);
    return true;
  });
  assert.equal(fs.readFileSync(marker, "utf8"), "whisper\n");
});
