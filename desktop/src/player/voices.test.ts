import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoices } from "./voices.ts";

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
