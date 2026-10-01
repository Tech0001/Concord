export type SpeechInterval = { start: number; end: number };

/** Diarization can overlap. Merge coverage first so another voice never looks like a gap. */
export function speechIntervals(lines: SpeechInterval[]): SpeechInterval[] {
  const merged: SpeechInterval[] = [];
  for (const line of lines
    .filter(
      (s) =>
        Number.isFinite(s.start) &&
        Number.isFinite(s.end) &&
        s.end > Math.max(0, s.start),
    )
    .sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && line.start <= last.end) last.end = Math.max(last.end, line.end);
    else merged.push({ start: Math.max(0, line.start), end: line.end });
  }
  return merged;
}
export function nextAfterGap(
  intervals: SpeechInterval[],
  seconds: number,
): number | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  let lo = 0,
    hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid].end <= seconds) lo = mid + 1;
    else hi = mid;
  }
  const next = intervals[lo];
  return next && next.start - seconds > 1.25 ? next.start : null;
}
