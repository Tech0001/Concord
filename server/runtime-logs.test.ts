import assert from "node:assert/strict";
import {
  clearRuntimeLogs,
  getRuntimeLogs,
  installRuntimeLogCapture,
  subscribeRuntimeLogs,
} from "./runtime-logs";

clearRuntimeLogs();
installRuntimeLogCapture();
installRuntimeLogCapture();

const seen: number[] = [];
const unsubscribe = subscribeRuntimeLogs(entry => seen.push(entry.id));
console.log("[runtime-log-test]", { captured: true });
console.warn("[runtime-log-test] warning");
unsubscribe();

const entries = getRuntimeLogs();
assert.equal(entries.length, 2, "installing twice must not duplicate captured lines");
assert.match(entries[0].message, /captured: true/);
assert.equal(entries[1].level, "warn");
assert.deepEqual(seen, entries.map(entry => entry.id));
assert.deepEqual(getRuntimeLogs(entries[0].id), [entries[1]]);

clearRuntimeLogs();
assert.deepEqual(getRuntimeLogs(), []);
