import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoices, groupVoices } from "./voices.ts";
import type { Assignment } from "../lib/types.ts";

const voice = (local_id: string, speaker_id: string | null, name: string | null, airtime: number): Assignment => ({
  local_id,
  speaker_id,
  name,
  airtime,
  color: null,
});

test("one person with three fingerprints is one speaker without losing local voices", () => {
  const voices = buildVoices([voice("S0", "ada", "Ada", 60), voice("S1", "ada", "Ada", 10), voice("S2", "ada", "Ada", 30)], []);
  const people = groupVoices(voices);
  assert.equal(people.length, 1);
  assert.equal(people[0].airtime, 100);
  assert.deepEqual(people[0].locals.sort(), ["S0", "S1", "S2"]);
  assert.equal(voices.size, 3);
  assert.deepEqual(voices.get("S0")?.locals, ["S0"]);
});

test("people with the same name and unnamed voices stay distinct", () => {
  const voices = buildVoices(
    [voice("S0", "a", "Alex", 5), voice("S1", "b", "Alex", 8), voice("S2", null, null, 0)],
    [
      { start: 0, end: 10, speaker: "S2", text: "Hello" },
      { start: 10, end: 15, speaker: "S3", text: "Reply" },
    ],
  );
  const people = groupVoices(voices);
  assert.equal(people.length, 4);
  assert.equal(people[0].airtime, 10);
  assert.equal(people[0].name, "Speaker 3");
});

test("voices merge assignments with speakers found only in the transcript", () => {
  const voices = buildVoices(
    [{ local_id: "S0", speaker_id: "s", name: "Ada", color: "#112233", airtime: 30 }],
    [
      { start: 0, end: 5, text: "a", speaker: "S0" },
      { start: 5, end: 65, text: "b", speaker: "S4" },
      { start: 65, end: 66, text: "c" },
    ],
  );
  assert.deepEqual([...voices.keys()], ["S4", "S0"]);
  assert.equal(voices.get("S0")!.name, "Ada");
  assert.equal(voices.get("S0")!.color, "#112233");
  assert.equal(voices.get("S0")!.airtime, 30);
  assert.equal(voices.get("S4")!.name, "Speaker 5");
  assert.equal(voices.get("S4")!.named, false);
  assert.equal(voices.get("S4")!.airtime, 60);
});
