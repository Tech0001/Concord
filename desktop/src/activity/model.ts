import type { PipelineOverview, QueueJob } from "../pipeline/types.ts";

/** The first percentage in a progress message, rounded down. */
export function percent(message: string | null | undefined): number | null {
  const match = /(\d+(?:\.\d+)?)\s*%/.exec(message ?? "");
  return match ? Math.min(100, Math.floor(Number(match[1]))) : null;
}

function inTime(seconds: number): string {
  if (seconds < 60) return "shortly";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** What a queue item is doing or waiting for. */
export function jobLine(j: Pick<QueueJob, "status" | "kind" | "path" | "message" | "retry_at">, now = Date.now() / 1000): { label: string; pct: number | null } {
  const downloading = j.kind === "download" && !j.path;
  const pct = percent(j.message);
  switch (j.status) {
    case "running": {
      const verb = downloading ? "Downloading" : "Transcribing";
      return { label: pct == null ? verb : `${verb} · ${pct}%`, pct };
    }
    case "retry":
      return { label: `Retrying ${inTime(j.retry_at - now)}`, pct: null };
    case "waiting_live":
      return { label: "Waiting for the live stream to end", pct: null };
    default:
      if (/speech engine/i.test(j.message)) return { label: "Waiting for the speech engine", pct: null };
      return { label: downloading ? "Waiting to download" : "Waiting to transcribe", pct: null };
  }
}

export function activityHeadline(q: PipelineOverview): string {
  if (!q.running) return "Paused · nothing new starts until you resume";
  const next = q.queued + q.retry + q.waitingLive;
  const parts = [
    q.active ? `${q.active} running` : "",
    next ? `${next} up next` : "",
    q.failed ? `${q.failed} ${q.failed === 1 ? "needs" : "need"} attention` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing to do right now";
}
