import test from "node:test";
import assert from "node:assert/strict";
import { compatibleModelSelection } from "./transcription-models";

test("transcription selectors follow setup on first use and when engines change", () => {
  assert.equal(compatibleModelSelection("", "small"), "small");
  assert.equal(compatibleModelSelection("nvidia/parakeet-tdt-0.6b-v3", "small"), "small");
  assert.equal(compatibleModelSelection("large-v3", "nvidia/parakeet-tdt-0.6b-v3"), "nvidia/parakeet-tdt-0.6b-v3");
  assert.equal(compatibleModelSelection("large-v3", "fluid-parakeet-tdt-v3"), "fluid-parakeet-tdt-v3");
  assert.equal(compatibleModelSelection("tiny", "small"), "tiny");
});
