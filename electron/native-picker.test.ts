import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativePicker } from "./native-picker";

test("desktop folder picker uses the native dialog, resolves missing output folders and preserves spaces", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "concord folder "));
  try {
    const picker = createNativePicker(async options => {
      assert.deepEqual(options.properties, ["openDirectory", "createDirectory"]);
      assert.equal(options.defaultPath, parent);
      assert.equal(options.title, "Choose storage");
      return { canceled: false, filePaths: [path.join(parent, "My videos")] };
    });
    assert.deepEqual(await picker("directory", { prompt: "Choose storage", defaultPath: path.join(parent, "new/subfolder") }), { path: path.join(parent, "My videos") });
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("native file selection and cancellation use the same response as the existing picker API", async () => {
  const picker = createNativePicker(async options => {
    assert.deepEqual(options.properties, ["openFile"]);
    assert.equal(options.defaultPath, undefined);
    return { canceled: true, filePaths: [] };
  });
  assert.deepEqual(await picker("file", { prompt: "Cookies", defaultPath: "relative/file" }), { cancelled: true });
  const empty = createNativePicker(async () => ({ canceled: false, filePaths: [] }));
  assert.deepEqual(await empty("directory", { prompt: "Storage" }), { cancelled: true });
});
