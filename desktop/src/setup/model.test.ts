import assert from "node:assert/strict";
import test from "node:test";
import { checklist, formatBytes, nextStep, previousStep, privacyLines, speechPercent, stepState, stepSummary } from "./model.ts";
import type { SetupStatus } from "./types.ts";

const fresh = (): SetupStatus => ({
  progress: { step: "library", furthest: "library", completed: false, skipped: [], checklistHidden: false },
  library: { started: false, imported: false, media: 0, docs: 0, notes: 0, dataRoot: "/home/you/.local/share/concord-next" },
  legacy: null,
  speech: { installed: false, managed: false, device: "auto", setup: { status: "", message: "", phase: "", done: 0, total: 0 } },
  sources: { sources: 0, documentFolders: 0 },
  search: { kind: "builtin", enabled: true, modelReady: false, download: { status: "", message: "", done: 0, total: 639150592 } },
  chat: { kind: "local", enabled: false, model: "", connected: false },
});

test("steps run in order and stop at the ends", () => {
  assert.equal(nextStep("library"), "speech");
  assert.equal(nextStep("look"), "ready");
  assert.equal(nextStep("ready"), "ready");
  assert.equal(previousStep("speech"), "library");
  assert.equal(previousStep("library"), null);
});

test("speech progress is a percentage only while models download", () => {
  assert.equal(speechPercent({ status: "running", message: "", phase: "models", done: 608e6, total: 950e6 }), 64);
  assert.equal(speechPercent({ status: "running", message: "", phase: "runtime", done: 0, total: 0 }), null);
  assert.equal(speechPercent({ status: "complete", message: "", phase: "runtime", done: 0, total: 0 }), null);
});

test("rail states follow readiness, skips, and how far setup got", () => {
  const s = fresh();
  assert.equal(stepState(s, "library", "library"), "current");
  assert.equal(stepState(s, "speech", "library"), "todo");
  s.library.started = true;
  s.progress = { ...s.progress, step: "ai", furthest: "ai", skipped: ["recordings"] };
  s.speech.setup = { status: "running", message: "", phase: "models", done: 1, total: 2 };
  assert.equal(stepState(s, "library", "ai"), "done");
  assert.equal(stepState(s, "speech", "ai"), "running");
  assert.equal(stepState(s, "recordings", "ai"), "skipped");
  assert.equal(stepState(s, "look", "ai"), "todo");
  s.speech.setup = { status: "failed", message: "Disk full", phase: "models", done: 1, total: 2 };
  assert.equal(stepState(s, "speech", "ai"), "failed");
  s.speech.setup = { status: "cancelled", message: "Setup cancelled", phase: "models", done: 1, total: 2 };
  assert.equal(stepState(s, "speech", "ai"), "todo");
  assert.equal(stepSummary(s, "speech"), "Paused · resume to finish");
  s.sources.sources = 1;
  assert.equal(stepState(s, "recordings", "ai"), "done");
  s.progress.furthest = "ready";
  assert.equal(stepState(s, "look", "ready"), "done");
});

test("summaries describe each step in a few words", () => {
  const s = fresh();
  assert.equal(stepSummary(s, "library"), "Start or import");
  assert.equal(stepSummary(s, "speech"), "Recommended");
  assert.equal(stepSummary(s, "recordings"), "Optional");
  s.progress.furthest = "ai";
  assert.equal(stepSummary(s, "recordings"), "Nothing added");
  s.progress.furthest = "library";
  s.library.started = true;
  s.speech.setup = { status: "running", message: "", phase: "models", done: 380, total: 1000 };
  assert.equal(stepSummary(s, "library"), "New library");
  assert.equal(stepSummary(s, "speech"), "Installing · 38%");
  s.sources = { sources: 1, documentFolders: 1 };
  assert.equal(stepSummary(s, "recordings"), "1 source · 1 document folder");
  s.progress.furthest = "look";
  s.chat = { kind: "openrouter", enabled: true, model: "m", connected: true };
  assert.equal(stepSummary(s, "ai"), "Local search · OpenRouter chat");
  s.search.enabled = false;
  s.chat.connected = false;
  assert.equal(stepSummary(s, "ai"), "Exact-word search");
  assert.equal(stepSummary(s, "look", "Concord · Dark"), "Optional");
  s.progress.furthest = "ready";
  assert.equal(stepSummary(s, "look", "Concord · Dark"), "Concord · Dark");
});

test("the checklist counts what is done and what is still running", () => {
  const s = fresh();
  s.library.started = true;
  s.speech.setup = { status: "running", message: "", phase: "models", done: 64, total: 100 };
  s.search.download = { status: "waiting", message: "", done: 0, total: 639150592 };
  const items = checklist(s);
  assert.deepEqual(items.map((i) => [i.id, i.state]), [
    ["library", "done"],
    ["speech", "running"],
    ["recordings", "todo"],
    ["search", "running"],
    ["chat", "todo"],
  ]);
  assert.equal(items.filter((i) => i.state === "done").length, 1);
  assert.equal(items[1].detail, "Installing · 64%");
  s.speech.setup = { status: "interrupted", message: "", phase: "models", done: 87e6, total: 950e6 };
  assert.equal(checklist(s)[1].state, "todo");
  assert.equal(checklist(s)[1].detail, "Paused at 87 of 950 MB · resume any time");
  s.speech.setup = { status: "failed", message: "Disk full", phase: "models", done: 1, total: 2 };
  assert.equal(checklist(s)[1].state, "failed");
});

test("privacy lines say what leaves the computer for each choice", () => {
  assert.deepEqual(privacyLines("builtin", "off"), ["Search runs on this computer.", "No chat provider is connected."]);
  assert.deepEqual(privacyLines("openrouter", "chatgpt"), [
    "Search sends transcript text to OpenRouter to build its index.",
    "Chat sends your question and the matching passages to OpenAI.",
  ]);
});

test("sizes read the way people say them", () => {
  assert.equal(formatBytes(950_182_240), "950 MB");
  assert.equal(formatBytes(2_200_000_000), "2.2 GB");
  assert.equal(formatBytes(186_400_000_000), "186 GB");
  assert.equal(formatBytes(639_150_592), "639 MB");
});
