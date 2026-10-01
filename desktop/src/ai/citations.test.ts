import { test } from "node:test";
import assert from "node:assert/strict";
import { citedNumbers } from "./citations.ts";
test("citation lists keep original numbering and omit unreferenced, invalid and code references", () => {
  assert.deepEqual(
    citedNumbers(
      "This is cited [3] and again [3], then [1]. Not [99] or [0]. `example [2]`\n```\n[4]\n```\n[2](https://example.com)",
      4,
    ),
    [3, 1],
  );
});
