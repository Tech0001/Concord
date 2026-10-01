import { test } from "node:test";
import assert from "node:assert/strict";
import { isTypingTarget, isInteractiveTarget, matches } from "./shortcuts.ts";

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

test("typing targets block shortcuts", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "range" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("buttons and menu items own Space and Enter", () => {
  assert.equal(isInteractiveTarget({ tagName: "BUTTON" }), true);
  assert.equal(isInteractiveTarget({ tagName: "A" }), true);
  assert.equal(isInteractiveTarget({ tagName: "DIV", role: "slider" }), true);
  assert.equal(isInteractiveTarget({ tagName: "DIV" }), false);
});

test("matches respects modifiers", () => {
  const run = () => {};
  assert.equal(matches(key("k", { ctrlKey: true }), { key: "k", mod: true, run }), true);
  assert.equal(matches(key("k", { metaKey: true }), { key: "k", mod: true, run }), true);
  assert.equal(matches(key("k"), { key: "k", mod: true, run }), false);
  assert.equal(matches(key("ArrowLeft", { shiftKey: true }), { key: "ArrowLeft", shift: false, run }), false);
  assert.equal(matches(key("ArrowLeft", { shiftKey: true }), { key: "ArrowLeft", shift: true, run }), true);
  assert.equal(matches(key("I", { shiftKey: true }), { key: "i", run }), true);
  assert.equal(matches(key("<", { shiftKey: true }), { key: "<", run }), true);
  assert.equal(matches(key("i", { altKey: true }), { key: "i", run }), false);
});
