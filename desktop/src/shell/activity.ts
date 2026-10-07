import type { PipelineOverview } from "../pipeline/types.ts";

export type QueueOverview = PipelineOverview & { activeKind?: string | null };
export type ActivityTone = "busy" | "wait" | "paused" | "bad" | "idle";

/** What the queue is doing, in a few words for the sidebar and the Activity header. */
export function activitySummary(q: QueueOverview | undefined): { detail: string; tone: ActivityTone } {
  if (!q) return { detail: "", tone: "idle" };
  const waiting = q.queued + q.retry + q.waitingLive;
  const more = waiting ? ` · ${waiting} waiting` : "";
  if (q.active > 0) return { detail: (q.activeKind === "download" ? "Downloading" : "Transcribing") + more, tone: "busy" };
  if (!q.running) return { detail: "Paused" + more, tone: "paused" };
  if (waiting) return { detail: `${waiting} waiting`, tone: "wait" };
  if (q.failed) return { detail: `${q.failed} ${q.failed === 1 ? "needs" : "need"} attention`, tone: "bad" };
  return { detail: "Up to date", tone: "idle" };
}
