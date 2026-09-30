import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimeStore } from "./timeStore.ts";

test("time store notifies on change only and stops after unsubscribe", () => {
  const store = createTimeStore(1);
  let calls = 0;
  const stop = store.subscribe(() => calls++);
  store.set(1);
  store.set(2);
  assert.equal(store.get(), 2);
  assert.equal(calls, 1);
  stop();
  store.set(3);
  assert.equal(calls, 1);
});
