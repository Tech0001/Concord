import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEmbeddingVectorDimensions,
  EmbeddingDimensionMismatchError,
} from "./embedding-dimensions";

test("accepts vectors that match the index width", () => {
  assert.doesNotThrow(() => {
    assertEmbeddingVectorDimensions(
      [new Float32Array(1024), new Float32Array(1024)],
      "Qwen3-Embedding-0.6B",
      1024,
    );
  });
});

test("reports the model, actual width, and expected width", () => {
  assert.throws(
    () => assertEmbeddingVectorDimensions(
      [new Float32Array(2560)],
      "Qwen3-Embedding-4B",
      1024,
    ),
    (err) => {
      assert.ok(err instanceof EmbeddingDimensionMismatchError);
      assert.equal(err.model, "Qwen3-Embedding-4B");
      assert.equal(err.actualDimensions, 2560);
      assert.equal(err.expectedDimensions, 1024);
      assert.match(err.message, /returns 2560-dimensional vectors/);
      assert.match(err.message, /requires 1024/);
      return true;
    },
  );
});

test("rejects a mismatched vector anywhere in a batch", () => {
  assert.throws(
    () => assertEmbeddingVectorDimensions(
      [new Float32Array(1024), new Float32Array(768)],
      "mixed-response-model",
      1024,
    ),
    EmbeddingDimensionMismatchError,
  );
});
