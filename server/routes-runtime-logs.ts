import type { Express, Response } from "express";
import {
  clearRuntimeLogs,
  getRuntimeLogs,
  subscribeRuntimeLogs,
  type RuntimeLogEntry,
} from "./runtime-logs";

function numericId(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function writeEntry(res: Response, entry: RuntimeLogEntry): void {
  res.write(`id: ${entry.id}\n`);
  res.write("event: log\n");
  res.write(`data: ${JSON.stringify(entry)}\n\n`);
}

/** Read-only live view of the output emitted by the embedded server. */
export function registerRuntimeLogRoutes(app: Express): void {
  app.get("/api/runtime-logs", (req, res) => {
    const afterId = numericId(req.query.after);
    const entries = getRuntimeLogs(afterId);
    res.json({ entries, lastId: entries.at(-1)?.id ?? afterId });
  });

  app.get("/api/runtime-logs/events", (req, res) => {
    const afterId = numericId(req.get("Last-Event-ID") || req.query.after);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for (const entry of getRuntimeLogs(afterId)) writeEntry(res, entry);

    const unsubscribe = subscribeRuntimeLogs(entry => writeEntry(res, entry));
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    req.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // This clears only the in-memory screen buffer. It does not delete files,
  // stop work, or affect stdout/stderr.
  app.delete("/api/runtime-logs", (_req, res) => {
    clearRuntimeLogs();
    res.status(204).end();
  });
}
