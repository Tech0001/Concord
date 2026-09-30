export type Range = { start: number; end: number };
export type Timed = { start: number; end: number };
export type Line = Timed & { text: string; speaker?: string | null };
export type Turn = { start: number; end: number; speaker: string };
export type Part = { text: string; mark: boolean };
export const MIN_RANGE = 0.5;

/** The line playing at time t: the last line that starts at or before t, or -1. */
export function indexAt(lines: Timed[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function spanRange(lines: Timed[], a: number, b: number): Range {
  const [i, j] = a <= b ? [a, b] : [b, a];
  return { start: lines[i].start, end: lines[j].end };
}

export function overlaps(line: Timed, r: Range): boolean {
  return line.end > r.start && line.start < r.end;
}

export function linesIn(lines: Timed[], r: Range): [number, number] | null {
  let first = -1;
  let last = -1;
  for (let i = Math.max(0, indexAt(lines, r.start) - 1); i < lines.length && lines[i].start < r.end; i++) {
    if (overlaps(lines[i], r)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : [first, last];
}

export function clampRange(r: Range, duration: number, min = MIN_RANGE): Range {
  const lo = Math.min(r.start, r.end);
  const hi = Math.max(r.start, r.end);
  const max = duration > 0 ? duration : hi;
  let start = Math.min(Math.max(0, lo), max);
  let end = Math.min(Math.max(0, hi), max);
  if (end - start < min) {
    end = Math.min(max, start + min);
    start = Math.max(0, end - min);
  }
  return { start, end };
}

export function setIn(r: Range | null, t: number, lines: Timed[], duration: number): Range {
  let end: number;
  if (r && r.end > t + MIN_RANGE) end = r.end;
  else {
    const i = indexAt(lines, t);
    end = i >= 0 && lines[i].end > t + MIN_RANGE ? lines[i].end : t + 10;
  }
  return clampRange({ start: t, end }, duration);
}

export function setOut(r: Range | null, t: number, lines: Timed[], duration: number): Range {
  let start: number;
  if (r && r.start < t - MIN_RANGE) start = r.start;
  else {
    const i = indexAt(lines, t);
    start = i >= 0 && lines[i].start < t - MIN_RANGE ? lines[i].start : Math.max(0, t - 10);
  }
  return clampRange({ start, end: t }, duration);
}

export function speakerTurns(lines: Line[], gap = 2): Turn[] {
  const turns: Turn[] = [];
  for (const line of lines) {
    if (!line.speaker) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === line.speaker && line.start - last.end <= gap) last.end = Math.max(last.end, line.end);
    else turns.push({ start: line.start, end: line.end, speaker: line.speaker });
  }
  return turns;
}

export function findMatches(lines: { text: string }[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return lines.flatMap((l, i) => (l.text.toLowerCase().includes(q) ? [i] : []));
}

export function markParts(text: string, query: string): Part[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, mark: false }];
  const lower = text.toLowerCase();
  const parts: Part[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
    if (i > at) parts.push({ text: text.slice(at, i), mark: false });
    parts.push({ text: text.slice(i, i + needle.length), mark: true });
    at = i + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}
