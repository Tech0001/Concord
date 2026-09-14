import {
  execFileSync,
  spawnSync,
  type ChildProcess,
} from "child_process";

interface ManagedChild {
  child: ChildProcess;
  label: string;
  pid: number;
}

export interface ManagedChildShutdownReport {
  requested: number;
  forced: number;
  remaining: number;
  labels: string[];
}

const managedChildren = new Map<ChildProcess, ManagedChild>();
let shuttingDown = false;

/**
 * Register a child that must not outlive Concord. The original child object is
 * returned so callers keep its precise stdout/stderr/event typings.
 */
export function trackChildProcess<T extends ChildProcess>(child: T, label: string): T {
  const pid = child.pid;
  if (!pid) return child;

  const entry: ManagedChild = { child, label, pid };
  managedChildren.set(child, entry);
  const forget = () => managedChildren.delete(child);
  child.once("exit", forget);
  child.once("error", forget);

  // A shutdown can race a late async task that was already preparing to
  // spawn. Refuse to let that new process escape the shutdown boundary.
  if (shuttingDown) {
    queueMicrotask(() => terminateProcessTrees([pid], "SIGTERM"));
  }
  return child;
}

export function activeManagedChildCount(): number {
  return managedChildren.size;
}

/**
 * Stop every registered tool and its descendants. yt-dlp launches ffmpeg of
 * its own, so killing only the direct child is insufficient; on POSIX we take
 * a process-table snapshot and signal the whole descendant tree. Windows uses
 * taskkill /T for the equivalent behavior.
 */
export async function shutdownManagedChildProcesses(
  options: { graceMs?: number; forceWaitMs?: number } = {},
): Promise<ManagedChildShutdownReport> {
  shuttingDown = true;
  const graceMs = options.graceMs ?? 5_000;
  const forceWaitMs = options.forceWaitMs ?? 1_000;
  const initial = Array.from(managedChildren.values());
  const labels = Array.from(new Set(initial.map(entry => entry.label))).sort();
  const knownPids = collectProcessTrees(initial.map(entry => entry.pid));

  if (knownPids.size === 0) {
    return { requested: 0, forced: 0, remaining: 0, labels };
  }

  terminateProcessTrees(Array.from(knownPids), "SIGTERM", false);
  await waitForExit(knownPids, graceMs);

  // Include any late child registered while the graceful wait was running.
  const remainingRoots = Array.from(managedChildren.values()).map(entry => entry.pid);
  const remainingPids = collectProcessTrees([
    ...Array.from(knownPids).filter(isProcessAlive),
    ...remainingRoots,
  ]);
  const forced = remainingPids.size;
  if (forced > 0) {
    terminateProcessTrees(Array.from(remainingPids), "SIGKILL", false);
    await waitForExit(remainingPids, forceWaitMs);
  }

  const remaining = Array.from(new Set([
    ...Array.from(knownPids),
    ...Array.from(remainingPids),
  ])).filter(isProcessAlive).length;

  return {
    requested: knownPids.size,
    forced,
    remaining,
    labels,
  };
}

function collectProcessTrees(roots: number[]): Set<number> {
  const validRoots = Array.from(new Set(roots.filter(pid => pid > 0 && pid !== process.pid)));
  if (validRoots.length === 0) return new Set();
  if (process.platform === "win32") return new Set(validRoots);

  const childrenByParent = readPosixProcessTable();
  const collected = new Set<number>();
  const visit = (pid: number) => {
    if (collected.has(pid) || pid === process.pid) return;
    collected.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
  };
  for (const root of validRoots) visit(root);
  return collected;
}

function readPosixProcessTable(): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>();
  try {
    const output = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const siblings = childrenByParent.get(ppid) ?? [];
      siblings.push(pid);
      childrenByParent.set(ppid, siblings);
    }
  } catch (error) {
    console.warn("[shutdown] Could not inspect descendant processes:", error);
  }
  return childrenByParent;
}

function terminateProcessTrees(
  roots: number[],
  signal: NodeJS.Signals,
  expandTrees = true,
): void {
  const targets = expandTrees ? collectProcessTrees(roots) : new Set(roots);
  if (process.platform === "win32") {
    for (const pid of Array.from(targets)) {
      const args = ["/PID", String(pid), "/T"];
      if (signal === "SIGKILL") args.push("/F");
      spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
    }
    return;
  }

  // Descendants first prevents a parent from exiting and re-parenting a tool
  // before that tool receives the same signal.
  for (const pid of Array.from(targets).reverse()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") console.warn(`[shutdown] Could not signal pid ${pid}:`, error);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pids: Set<number>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (Array.from(pids).every(pid => !isProcessAlive(pid))) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
