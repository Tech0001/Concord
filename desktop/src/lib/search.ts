import type { SearchHit } from "./types.ts";
import type { Part } from "./range.ts";

export type HitGroup = { id: string; title: string; channel: string; date: string; hits: SearchHit[] };

export function groupHits(hits: SearchHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const hit of hits) {
    let g = groups.get(hit.id);
    if (!g) {
      g = { id: hit.id, title: hit.title, channel: hit.channel, date: hit.date, hits: [] };
      groups.set(hit.id, g);
    }
    g.hits.push(hit);
  }
  return [...groups.values()];
}

/** SQLite highlight() wraps matches in \u0002…\u0003. */
export function highlightParts(marked: string): Part[] {
  const parts: Part[] = [];
  let mark = false;
  let text = "";
  for (const ch of marked) {
    if (ch === "\u0002" || ch === "\u0003") {
      if (text) parts.push({ text, mark });
      text = "";
      mark = ch === "\u0002";
    } else text += ch;
  }
  if (text) parts.push({ text, mark });
  return parts;
}
