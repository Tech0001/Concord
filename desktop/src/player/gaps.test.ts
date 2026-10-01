import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAfterGap, speechIntervals } from "./gaps.ts";

test("gap skipping respects overlapping speakers, short gaps, and the recording tail", () => {
  const input = [
    { start: 10, end: 12 },
    { start: 2, end: 8 },
    { start: 3, end: 4 },
    { start: 14, end: 20 },
    { start: 7, end: 9 },
  ];
  const intervals = speechIntervals(input);
  assert.deepEqual(intervals, [
    { start: 2, end: 9 },
    { start: 10, end: 12 },
    { start: 14, end: 20 },
  ]);
  assert.equal(nextAfterGap(intervals, 0), 2);
  assert.equal(nextAfterGap(intervals, 5), null);
  assert.equal(nextAfterGap(intervals, 9), null);
  assert.equal(nextAfterGap(intervals, 12), 14);
  assert.equal(nextAfterGap(intervals, 20), null);
  assert.equal(input[1].end, 8);
});
