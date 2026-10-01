import type { Category, LibraryFilter, Media } from "../lib/types.ts";

export const DEFAULT_FILTER: LibraryFilter = {
  query: "", channel: "", category: "", status: "", kind: "", transcribed: "",
  starred: false, review: "", sort: "newest", offset: 0, limit: 60,
};
export const STATUS_OPTIONS = [
  { value: "", label: "Any status" }, { value: "complete", label: "Transcribed" },
  { value: "ready", label: "Not transcribed" }, { value: "pending", label: "Queued / retrying" },
  { value: "processing", label: "Processing" }, { value: "live", label: "Waiting for live stream" },
  { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" },
  { value: "archived", label: "Media removed" },
];
export const isCategory = (v: unknown): v is Category => v === "" || v === "personal" || v === "work";
export function normalizeFilter(value: unknown): LibraryFilter {
  const f = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => allowed.includes(f[key] as T) ? f[key] as T : fallback;
  return {
    query: typeof f.query === "string" ? f.query : "", channel: typeof f.channel === "string" ? f.channel : "",
    category: isCategory(f.category) ? f.category : "", status: oneOf("status", STATUS_OPTIONS.map(s => s.value), ""),
    kind: oneOf("kind", ["", "audio", "video"], ""), transcribed: oneOf("transcribed", ["", "yes", "no"], ""),
    starred: f.starred === true, review: oneOf("review", ["", "unreviewed", "in_review", "reviewed"], ""),
    sort: oneOf("sort", ["newest", "oldest", "opened", "words", "title", "longest"], "newest"),
    offset: Number.isInteger(f.offset) && Number(f.offset) >= 0 ? Math.min(Number(f.offset), 1_000_000) : 0,
    limit: [60, 120, 240].includes(Number(f.limit)) ? Number(f.limit) as LibraryFilter["limit"] : 60,
  };
}
export type SavedView = { id: string; name: string; filter: LibraryFilter; layout: "grid" | "list" };
export function readViews(value: unknown): SavedView[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(v => {
    if (!v || typeof v.id !== "string" || seen.has(v.id) || typeof v.name !== "string" || !v.name.trim()) return [];
    seen.add(v.id);
    return [{ id: v.id, name: v.name.trim().slice(0, 80), filter: { ...normalizeFilter(v.filter), offset: 0 }, layout: v.layout === "list" ? "list" as const : "grid" as const }];
  }).slice(0, 100);
}
export const viewKey = (f: LibraryFilter, layout: string) => JSON.stringify([normalizeFilter({ ...f, offset: 0 }), layout]);
export function processingStatus(m: Media): string {
  return m.processing_status || (m.status === "failed" ? "failed" : m.status === "archived" ? "archived" : m.transcript ? "complete" : ["pending", "queued"].includes(m.status) ? "pending" : m.status === "cancelled" ? "cancelled" : "ready");
}
