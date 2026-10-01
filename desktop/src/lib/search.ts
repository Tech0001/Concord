import type { SearchHit } from "./types.ts";
import type { Part } from "./range.ts";

type Groupable = { id: string; kind?: string; title: string; channel: string; date: string };
export type HitGroup<T = SearchHit> = { key: string; id: string; title: string; channel: string; date: string; hits: T[] };

export function groupHits<T extends Groupable>(hits: T[]): HitGroup<T>[] {
  const groups = new Map<string, HitGroup<T>>();
  for (const hit of hits) {
    const key = `${hit.kind ?? "recording"}\0${hit.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, id: hit.id, title: hit.title, channel: hit.channel, date: hit.date, hits: [] };
      groups.set(key, g);
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
