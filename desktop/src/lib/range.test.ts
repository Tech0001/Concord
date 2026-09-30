import { test } from "node:test";
import assert from "node:assert/strict";
import { indexAt, spanRange, linesIn, clampRange, setIn, setOut, speakerTurns, findMatches, markParts } from "./range.ts";

const lines = [
  { start: 0, end: 4, text: "Hello there", speaker: "S0" },
  { start: 5, end: 9, text: "hello again", speaker: "S0" },
  { start: 9, end: 15, text: "Different voice", speaker: "S1" },
  { start: 18, end: 20, text: "Back again", speaker: "S0" },
];

test("indexAt finds the line playing at a time", () => {
  assert.equal(indexAt(lines, -1), -1);
  assert.equal(indexAt(lines, 0), 0);
  assert.equal(indexAt(lines, 4.5), 0);
  assert.equal(indexAt(lines, 9), 2);
  assert.equal(indexAt(lines, 100), 3);
  assert.equal(indexAt([], 3), -1);
});

test("spanRange covers lines in either order", () => {
  assert.deepEqual(spanRange(lines, 2, 0), { start: 0, end: 15 });
  assert.deepEqual(spanRange(lines, 1, 1), { start: 5, end: 9 });
});

test("linesIn returns overlapping line bounds or null", () => {
  assert.deepEqual(linesIn(lines, { start: 3, end: 10 }), [0, 2]);
  assert.deepEqual(linesIn(lines, { start: 5, end: 9 }), [1, 1]);
  assert.equal(linesIn(lines, { start: 15.5, end: 17 }), null);
  assert.equal(linesIn([], { start: 0, end: 1 }), null);
});

test("clampRange orders, bounds, and enforces a minimum length", () => {
  assert.deepEqual(clampRange({ start: 10, end: 5 }, 100), { start: 5, end: 10 });
  assert.deepEqual(clampRange({ start: -3, end: 2 }, 100), { start: 0, end: 2 });
  assert.deepEqual(clampRange({ start: 99.8, end: 140 }, 100), { start: 99.5, end: 100 });
  assert.deepEqual(clampRange({ start: 4, end: 4 }, 100), { start: 4, end: 4.5 });
  assert.deepEqual(clampRange({ start: 4, end: 30 }, 0), { start: 4, end: 30 });
});

test("setIn keeps a later end or extends to the line end", () => {
  assert.deepEqual(setIn(null, 5.5, lines, 100), { start: 5.5, end: 9 });
  assert.deepEqual(setIn({ start: 2, end: 20 }, 5.5, lines, 100), { start: 5.5, end: 20 });
  assert.deepEqual(setIn({ start: 2, end: 5.8 }, 5.5, lines, 100), { start: 5.5, end: 9 });
  assert.deepEqual(setIn(null, 16, lines, 100), { start: 16, end: 26 });
  assert.deepEqual(setIn(null, 95, [], 100), { start: 95, end: 100 });
});

test("setOut keeps an earlier start or starts at the line start", () => {
  assert.deepEqual(setOut(null, 12, lines, 100), { start: 9, end: 12 });
  assert.deepEqual(setOut({ start: 3, end: 20 }, 12, lines, 100), { start: 3, end: 12 });
  assert.deepEqual(setOut(null, 3, [], 100), { start: 0, end: 3 });
});

test("speakerTurns merges short gaps and skips unlabelled lines", () => {
  assert.deepEqual(speakerTurns([...lines, { start: 21, end: 22, text: "x" }]), [
    { start: 0, end: 9, speaker: "S0" },
    { start: 9, end: 15, speaker: "S1" },
    { start: 18, end: 20, speaker: "S0" },
  ]);
  assert.deepEqual(speakerTurns([]), []);
});

test("find and mark are case-insensitive", () => {
  assert.deepEqual(findMatches(lines, "HELLO"), [0, 1]);
  assert.deepEqual(findMatches(lines, "  "), []);
  assert.deepEqual(markParts("Hello hello!", "hello"), [
    { text: "Hello", mark: true },
    { text: " ", mark: false },
    { text: "hello", mark: true },
    { text: "!", mark: false },
  ]);
  assert.deepEqual(markParts("abc", ""), [{ text: "abc", mark: false }]);
});
