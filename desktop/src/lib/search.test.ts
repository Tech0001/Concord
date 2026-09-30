import { test } from "node:test";
import assert from "node:assert/strict";
import { groupHits, highlightParts } from "./search.ts";
import type { SearchHit } from "./types.ts";

const hit = (id: string, start: number): SearchHit => ({
  id,
  title: `T${id}`,
  channel: "C",
  date: "20250101",
  text: "x",
  marked: "x",
  start,
  speaker: null,
  speaker_name: null,
  speaker_color: null,
});

test("groups keep first-seen order and collect every hit", () => {
  const groups = groupHits([hit("b", 1), hit("a", 2), hit("b", 3)]);
  assert.deepEqual(
    groups.map((g) => g.id),
    ["b", "a"],
  );
  assert.deepEqual(
    groups[0].hits.map((h) => h.start),
    [1, 3],
  );
});

test("highlight markers become parts; stray markers are tolerated", () => {
  assert.deepEqual(highlightParts("We met at the \u0002harbour\u0003 today"), [
    { text: "We met at the ", mark: false },
    { text: "harbour", mark: true },
    { text: " today", mark: false },
  ]);
  assert.deepEqual(highlightParts("\u0002x"), [{ text: "x", mark: true }]);
  assert.deepEqual(highlightParts("plain"), [{ text: "plain", mark: false }]);
});
