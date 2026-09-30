import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEAKER_COLORS, speakerColor, voiceLabel } from "./speakers.ts";

test("stored colors win; missing or invalid colors get a stable palette color", () => {
  assert.equal(speakerColor("#ff0000", "S0"), "#ff0000");
  const a = speakerColor(null, "S2");
  assert.ok((SPEAKER_COLORS as readonly string[]).includes(a));
  assert.equal(speakerColor(undefined, "S2"), a);
  assert.ok((SPEAKER_COLORS as readonly string[]).includes(speakerColor("red", "S2")));
});

test("unnamed local voices read as numbered speakers", () => {
  assert.equal(voiceLabel("S0"), "Speaker 1");
  assert.equal(voiceLabel("S11"), "Speaker 12");
  assert.equal(voiceLabel("guest"), "guest");
  assert.equal(voiceLabel(""), "Unknown speaker");
});
