import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  activeManagedChildCount,
  shutdownManagedChildProcesses,
  trackChildProcess,
} from "./child-process-registry";

test("managed shutdown terminates a tool and its descendant process", async () => {
  const parentScript = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
  const parent = trackChildProcess(
    spawn(process.execPath, ["-e", parentScript], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "registry test tool",
  );
  const descendantPid = Number(await readFirstLine(parent.stdout));
  assert.ok(parent.pid && parent.pid > 0);
  assert.ok(descendantPid > 0);
  assert.equal(activeManagedChildCount(), 1);

  const report = await shutdownManagedChildProcesses({ graceMs: 2_000, forceWaitMs: 1_000 });
  assert.ok(report.requested >= 2, `expected parent + descendant, got ${report.requested}`);
  assert.equal(report.remaining, 0);
  assert.equal(activeManagedChildCount(), 0);
  assert.equal(isAlive(parent.pid!), false);
  assert.equal(isAlive(descendantPid), false);
});

function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => reject(new Error("child pid was not reported")), 5_000);
    stream.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      resolve(buffered.slice(0, newline).trim());
    });
    stream.once("error", reject);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
