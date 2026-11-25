import test from "node:test";
import assert from "node:assert/strict";
import { retainLogs } from "./logs.ts";

test("verbose diagnostics never evict activity, including while paused", () => {
  const entry = (id: number, level: string) => ({ id, level, timestamp: id, message: String(id) });
  const activity = [entry(1, "info"), entry(2, "error")];
  const verbose = Array.from({ length: 2500 }, (_, i) => entry(i + 3, "debug"));
  const paused = retainLogs(verbose);
  const retained = retainLogs([...activity, ...paused]);
  assert.equal(retained.length, 2002);
  assert.deepEqual(retained.filter(e => e.level !== "debug"), activity);
  assert.equal(retained[2].id, 503);
  assert.equal(retained.at(-1)?.id, 2502);
});
