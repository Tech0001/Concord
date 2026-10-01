import type { Note, NoteAnchor } from "../lib/types.ts";
export const LINK_KINDS = [
  { value: "same_claim", label: "Same claim" }, { value: "contradicts", label: "Contradicts" },
  { value: "same_topic", label: "Same topic" }, { value: "follow_up", label: "Follow-up" },
  { value: "context", label: "Context" }, { value: "related", label: "Related" },
];
export function anchorsOf(note: Note): NoteAnchor[] {
  return note.anchors ?? (note.media_id ? [{ media_id: note.media_id, start: note.start ?? 0, end: note.end, quote: note.quote ?? "", title: note.media_title }] : []);
}
export function tagList(text: string): string[] { return [...new Set(text.split(",").map(s => s.trim().toLowerCase().replace(/\s+/g," ")).filter(Boolean))]; }
