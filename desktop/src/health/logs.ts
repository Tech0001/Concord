import type { LogEntry } from "./types.ts";

// Preserve activity even when a verbose job fills the debug ring. Used for both
// visible and paused entries; switching modes never changes the IPC cursor.
export function retainLogs(entries: LogEntry[]): LogEntry[] {
  let activity = 0,
    debug = 0;
  return entries
    .slice()
    .reverse()
    .filter((entry) =>
      entry.level === "debug" ? ++debug <= 2000 : ++activity <= 2000,
    )
    .reverse();
}
