import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clock,
  clockPrecise,
  humanDuration,
  prettyDate,
  count,
  rangeLabel,
  safeFileName,
  exportName,
  parseClock,
  initials,
  extension,
} from "./format.ts";

test("clock formats minutes and hours and tolerates bad input", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(65.9), "1:05");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(clock(Number.NaN), "0:00");
  assert.equal(clock(-4), "0:00");
  assert.equal(clockPrecise(65.47), "1:05.4");
});

test("human durations and dates", () => {
  assert.equal(humanDuration(42), "42s");
  assert.equal(humanDuration(720), "12m");
  assert.equal(humanDuration(6420), "1h 47m");
  assert.equal(prettyDate("20251022"), "2025-10-22");
  assert.equal(prettyDate("2025-10-22"), "2025-10-22");
  assert.equal(prettyDate(""), "Undated");
});

test("counts pluralise with grouping", () => {
  assert.equal(count(1, "recording"), "1 recording");
  assert.equal(count(2020, "recording"), "2,020 recordings");
  assert.equal(count(3, "match", "matches"), "3 matches");
});

test("range labels are file-name friendly", () => {
  assert.equal(rangeLabel(723, 850), "12m03s–14m10s");
  assert.equal(rangeLabel(3723, 3730), "1h02m03s–1h02m10s");
});

test("safe file names strip separators, bound length, keep emoji whole", () => {
  assert.equal(safeFileName('A/B: "C"?'), "A B C");
  assert.equal(safeFileName("..."), "Recording");
  assert.equal(safeFileName("   "), "Recording");
  const emoji = safeFileName("🎙".repeat(200));
  assert.equal(Array.from(emoji).length, 120);
  assert.ok(!emoji.includes("�"));
  assert.equal(Array.from(safeFileName("x".repeat(300))).length, 120);
  assert.equal(exportName("Oct 7 / meeting", 723, 850, "m4a"), "Oct 7 meeting — 12m03s–14m10s.m4a");
});

test("parseClock accepts s, m:ss, h:mm:ss and fractions", () => {
  assert.equal(parseClock("45"), 45);
  assert.equal(parseClock("12:03"), 723);
  assert.equal(parseClock("1:02:03"), 3723);
  assert.equal(parseClock("1:05.5"), 65.5);
  assert.equal(parseClock(" 0:07 "), 7);
  assert.equal(parseClock("1:75"), null);
  assert.equal(parseClock("abc"), null);
  assert.equal(parseClock(""), null);
});

test("initials and extensions", () => {
  assert.equal(initials("Ellen McFarlane"), "EM");
  assert.equal(initials("  cher "), "C");
  assert.equal(extension("/a/b.OGG"), "ogg");
  assert.equal(extension(null), "");
});
