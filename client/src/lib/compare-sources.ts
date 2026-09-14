export type CompareSource =
  | { kind: "video"; videoId: string; channelId: string; title: string }
  | { kind: "doc"; documentId: string; rootId: string; relPath: string; title: string }
  | { kind: "note"; noteId: string; title: string };

const KEY = "concord-compare-sources-v1";

export function loadCompareSources(storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.localStorage): CompareSource[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(source => source && ["video", "doc", "note"].includes(source.kind)).slice(0, 2) : [];
  } catch { return []; }
}

export function saveCompareSources(sources: CompareSource[], storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.localStorage): void {
  storage?.setItem(KEY, JSON.stringify(sources.slice(0, 2)));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("concord:compare-updated"));
}

export function pinCompareSource(source: CompareSource): CompareSource[] {
  const current = loadCompareSources();
  const identity = (item: CompareSource) => item.kind === "video"
    ? `video:${item.channelId}:${item.videoId}`
    : item.kind === "doc" ? `doc:${item.documentId}` : `note:${item.noteId}`;
  const without = current.filter(item => identity(item) !== identity(source));
  const next = [...without, source].slice(-2);
  saveCompareSources(next);
  return next;
}

export function removeCompareSource(index: number): CompareSource[] {
  const next = loadCompareSources().filter((_, itemIndex) => itemIndex !== index);
  saveCompareSources(next);
  return next;
}

declare global {
  interface WindowEventMap { "concord:compare-updated": Event }
}
