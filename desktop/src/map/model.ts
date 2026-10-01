import type { MapPosition, Note, NoteAnchor, NoteLink } from "../lib/types.ts";
import { anchorsOf } from "../notes/model.ts";

export type Layout = "videos" | "cards" | "arc" | "cluster";
export type ArcOrder = "tag" | "date" | "collection" | "title" | "connections";
export type MapFilter = {
  query: string;
  collection: string;
  tags: string[];
  limit: number;
};
export type Entry = { note: Note; anchor?: NoteAnchor };
export type MapItem = {
  id: string;
  title: string;
  subtitle: string;
  recording?: string;
  entries: Entry[];
  compact?: boolean;
};
export type ConnectionKind = "manual" | "shared_tag" | "same_recording";
export type GraphLink = {
  id: string;
  source: string;
  target: string;
  kind: ConnectionKind;
  label: string;
  link?: NoteLink;
};
export const COLORS: Record<string, string> = {
  same_claim: "#10b981",
  contradicts: "#ef4444",
  same_topic: "#3b82f6",
  follow_up: "#8b5cf6",
  context: "#f59e0b",
  related: "#94a3b8",
};
export const SIDES = ["left", "right", "top", "bottom"] as const;
export type Side = (typeof SIDES)[number];
export const noteKey = (id: string) => `note:${encodeURIComponent(id)}`;
export const recordingKey = (id: string) =>
  `recording:${encodeURIComponent(id)}`;
export const linkKey = (l: NoteLink) =>
  encodeURIComponent(
    JSON.stringify([
      l.source,
      l.target,
      l.kind,
      l.source_anchor || "",
      l.target_anchor || "",
    ]),
  );
export const handleKey = (note: string, anchor = "", side: Side = "right") =>
  encodeURIComponent(JSON.stringify([note, anchor, side]));
export function readHandle(
  value: string | null | undefined,
): { note: string; anchor: string; side: Side } | undefined {
  try {
    const [note, anchor, side] = JSON.parse(decodeURIComponent(value || ""));
    if (
      typeof note === "string" &&
      typeof anchor === "string" &&
      SIDES.includes(side)
    )
      return { note, anchor, side };
  } catch {
    /* Incomplete drag. */
  }
}
export function viewKey(mode: Layout, filter: MapFilter, order: ArcOrder) {
  return JSON.stringify([
    mode,
    filter.query.trim().toLowerCase(),
    filter.collection,
    [...filter.tags].sort(),
    filter.limit,
    mode === "arc" ? order : "",
  ]);
}
export function filterNotes(notes: Note[], f: MapFilter) {
  const q = f.query.trim().toLowerCase();
  return notes
    .filter(
      (n) =>
        (!q ||
          [
            n.title,
            n.body,
            ...(n.tags || []),
            ...anchorsOf(n).map((a) => `${a.title || ""} ${a.quote}`),
          ].some((s) => s.toLowerCase().includes(q))) &&
        (!f.collection ||
          anchorsOf(n).some((a) => a.channel === f.collection)) &&
        f.tags.every((t) => n.tags?.includes(t)),
    )
    .slice(0, f.limit);
}
export function mapItems(notes: Note[], mode: Layout): MapItem[] {
  if (mode !== "videos")
    return notes.map((n) => ({
      id: noteKey(n.id!),
      title: n.title,
      subtitle: n.tags?.join(" · ") || "Research note",
      entries: [{ note: n }],
      compact: mode === "arc" || mode === "cluster",
    }));
  const recordings = new Map<string, MapItem>();
  const free: MapItem[] = [];
  for (const note of notes) {
    const videoAnchors = anchorsOf(note).filter((a) => a.media_id);
    if (!videoAnchors.length)
      free.push({
        id: noteKey(note.id!),
        title: note.title,
        subtitle: anchorsOf(note).length
          ? "Document evidence"
          : "Standalone note",
        entries: [{ note }],
      });
    for (const anchor of videoAnchors) {
      const key = recordingKey(anchor.media_id!);
      if (!recordings.has(key))
        recordings.set(key, {
          id: key,
          recording: anchor.media_id!,
          title: anchor.title || "Recording",
          subtitle: [anchor.channel, anchor.date].filter(Boolean).join(" · "),
          entries: [],
        });
      recordings.get(key)!.entries.push({ note, anchor });
    }
  }
  for (const item of recordings.values())
    item.entries.sort(
      (a, b) => (a.anchor?.start || 0) - (b.anchor?.start || 0),
    );
  return [...recordings.values(), ...free];
}
export function graphLinks(
  notes: Note[],
  manual: NoteLink[],
  kinds: ConnectionKind[],
): GraphLink[] {
  const ids = new Set(notes.map((n) => n.id!));
  const links: GraphLink[] = [];
  if (kinds.includes("manual"))
    for (const l of manual)
      if (ids.has(l.source) && ids.has(l.target))
        links.push({
          id: linkKey(l),
          source: l.source,
          target: l.target,
          kind: "manual",
          label: l.kind.replaceAll("_", " "),
          link: l,
        });
  // Suggestions are computed, never written as if the user connected the notes.
  for (let i = 0; i < notes.length; i++)
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i],
        b = notes[j];
      if (kinds.includes("shared_tag")) {
        const shared = (a.tags || []).filter((t) => b.tags?.includes(t));
        if (shared.length)
          links.push({
            id: `tag:${a.id}:${b.id}`,
            source: a.id!,
            target: b.id!,
            kind: "shared_tag",
            label: shared.join(", "),
          });
      }
      if (
        kinds.includes("same_recording") &&
        anchorsOf(a).some(
          (x) =>
            x.media_id && anchorsOf(b).some((y) => x.media_id === y.media_id),
        )
      )
        links.push({
          id: `recording:${a.id}:${b.id}`,
          source: a.id!,
          target: b.id!,
          kind: "same_recording",
          label: "Same recording",
        });
    }
  return links;
}
// One anchor can be a document even when its note also occurs in a video container.
// Use that note's first visible row for a non-video endpoint, while retaining the exact
// document anchor on the stored link. Do not silently replace the saved anchor.
export function endpoint(
  note: Note,
  anchorId: string | undefined,
  side: Side,
  mode: Layout,
) {
  const anchors = anchorsOf(note);
  if (mode !== "videos")
    return {
      node: noteKey(note.id!),
      handle: handleKey(note.id!, mode === "cards" ? anchorId || "" : "", side),
    };
  const explicit = anchors.find((a) => a.id === anchorId);
  const a = explicit?.media_id ? explicit : anchors.find((a) => a.media_id);
  return {
    node: a ? recordingKey(a.media_id!) : noteKey(note.id!),
    handle: handleKey(note.id!, a?.id || explicit?.id || "", side),
  };
}
export function savedPosition(
  positions: MapPosition[],
  view: string,
  node: string,
) {
  return positions.find((p) => p.view === view && p.node === node);
}
export function arcSort(notes: Note[], order: ArcOrder, links: GraphLink[]) {
  const degree = new Map<string, number>();
  for (const l of links)
    for (const id of [l.source, l.target])
      degree.set(id, (degree.get(id) || 0) + 1);
  const value = (n: Note) =>
    order === "tag"
      ? n.tags?.[0] || "\uffff"
      : order === "date"
        ? anchorsOf(n)[0]?.date || n.created_at || ""
        : order === "collection"
          ? anchorsOf(n)[0]?.channel || "\uffff"
          : n.title;
  return [...notes].sort((a, b) =>
    order === "connections"
      ? (degree.get(b.id!) || 0) - (degree.get(a.id!) || 0) ||
        a.title.localeCompare(b.title)
      : value(a).localeCompare(value(b)) || a.title.localeCompare(b.title),
  );
}
