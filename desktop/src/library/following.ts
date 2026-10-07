import type { Source } from "../pipeline/types.ts";

/** Followed channels and watched folders: the sources that add new recordings by themselves. */
export const isFollowed = (s: Source) => s.kind !== "collection" && s.enabled === 1 && (s.since ?? 0) > 0;

const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
/** "checked 2 hours ago" from unix seconds. */
export function checkedAgo(at: number, now = Date.now() / 1000): string {
  if (!at) return "not checked yet";
  const s = Math.max(0, now - at);
  if (s < 60) return "checked just now";
  if (s < 3600) return `checked ${ago(Math.floor(s / 60), "minute")}`;
  if (s < 86400) return `checked ${ago(Math.floor(s / 3600), "hour")}`;
  return `checked ${ago(Math.floor(s / 86400), "day")}`;
}

export const sourceKind = (s: Source) => (s.kind === "folder" ? "Folder" : /[?&]list=/.test(s.url) ? "Playlist" : "Channel");

export function followingMeta(s: Source, now = Date.now() / 1000): string {
  const check =
    s.check_status === "checking"
      ? "checking now"
      : s.check_status && !["complete", "interrupted"].includes(s.check_status)
        ? `last check failed${s.check_message ? `: ${s.check_message}` : ""}`
        : checkedAgo(s.last_check, now);
  return [sourceKind(s), s.category === "work" ? "Work" : "Personal", s.diarize ? "speakers identified" : "", check].filter(Boolean).join(" · ");
}

export function followingNote(s: Source, now = Date.now() / 1000): string {
  const since = new Date((s.since ?? 0) * 1000);
  const sameYear = since.getFullYear() === new Date(now * 1000).getFullYear();
  const date = since.toLocaleDateString("en-US", { month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  return s.kind === "folder"
    ? `Recordings saved in this folder are added while Concord is open. Watching since ${date}.`
    : `New videos are added while Concord is open. Following since ${date}.`;
}
