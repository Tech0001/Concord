// Engine-agnostic merge of speaker diarization spans onto transcription
// segments + words. The Mac wrapper (FluidAudio) and the Linux wrapper
// (pyannote, when it lands) both produce per-engine raw shapes; convert
// to the canonical SpeakerSpan via the engine-specific extractor below,
// then call mergeSpeakers — guarantees identical merge semantics across
// engines.

export interface SpeakerSpan {
  start: number;
  end: number;
  speaker: string;
}

export interface TimedThing {
  start: number;
  end: number;
}

export interface TimedWithSpeaker extends TimedThing {
  speaker?: string | null;
}

// FluidAudio process JSON shape (camelCase, 1-indexed speakerId like "1", "2").
export interface FluidAudioRawSpan {
  speakerId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
}

// pyannote JSON shape (snake_case-ish, label like "SPEAKER_00", "SPEAKER_01").
export interface PyannoteRawSpan {
  speaker: string;
  start: number;
  end: number;
}

/**
 * Convert FluidAudio's `1`/`2` speaker ids into our 0-indexed `S0`/`S1`
 * convention. Leaves room for `S?` (no-confidence) without colliding.
 */
export function normalizeFluidAudioSpeakerId(raw: string): string {
  const m = String(raw).match(/(\d+)/);
  if (!m) return "S?";
  return `S${parseInt(m[1], 10) - 1}`;
}

/**
 * pyannote labels are typically `SPEAKER_00`, `SPEAKER_01`. Strip the
 * prefix and re-emit as `S0`, `S1` so downstream code (FTS, UI) doesn't
 * have to know which engine produced the labels.
 */
export function normalizePyannoteSpeakerId(raw: string): string {
  const m = String(raw).match(/(\d+)/);
  if (!m) return "S?";
  // pyannote is already 0-indexed, no offset.
  return `S${parseInt(m[1], 10)}`;
}

export function spansFromFluidAudio(raw: FluidAudioRawSpan[]): SpeakerSpan[] {
  return (raw || []).map((s) => ({
    start: s.startTimeSeconds,
    end: s.endTimeSeconds,
    speaker: normalizeFluidAudioSpeakerId(s.speakerId),
  }));
}

export function spansFromPyannote(raw: PyannoteRawSpan[]): SpeakerSpan[] {
  return (raw || []).map((s) => ({
    start: s.start,
    end: s.end,
    speaker: normalizePyannoteSpeakerId(s.speaker),
  }));
}

/**
 * Pick the speaker whose diarization span overlaps [start, end] the most.
 * Falls back to the nearest span by midpoint distance when there's no
 * overlap (audio boundaries, silence between turns).
 *
 * Returns null only when `spans` is empty — every transcription chunk in
 * a diarized file gets *some* speaker assignment.
 */
export function assignSpeaker(start: number, end: number, spans: SpeakerSpan[]): string | null {
  if (spans.length === 0) return null;

  let best = spans[0];
  let bestOverlap = -Infinity;
  for (const span of spans) {
    const overlap = Math.max(0, Math.min(end, span.end) - Math.max(start, span.start));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = span;
    }
  }
  if (bestOverlap > 0) return best.speaker;

  const mid = (start + end) / 2;
  let nearest = spans[0];
  let nearestDist = Infinity;
  for (const span of spans) {
    const spanMid = (span.start + span.end) / 2;
    const dist = Math.abs(mid - spanMid);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = span;
    }
  }
  return nearest.speaker;
}

/**
 * Apply speaker assignments to a list of words and a list of segments
 * in one pass. Mutates inputs in place AND returns them for fluency.
 *
 * Both lists use the same canonical SpeakerSpan source so a word and
 * the segment containing it never disagree about who's speaking unless
 * the word genuinely straddles a turn boundary (rare but happens).
 */
export function mergeSpeakers<W extends TimedWithSpeaker, S extends TimedWithSpeaker>(
  words: W[],
  segments: S[],
  spans: SpeakerSpan[],
): { words: W[]; segments: S[]; speakerCount: number } {
  if (spans.length === 0) {
    for (const w of words) w.speaker = null;
    for (const s of segments) s.speaker = null;
    return { words, segments, speakerCount: 0 };
  }
  for (const w of words) {
    w.speaker = assignSpeaker(w.start, w.end, spans);
  }
  for (const s of segments) {
    s.speaker = assignSpeaker(s.start, s.end, spans);
  }
  const speakerCount = new Set(spans.map((s) => s.speaker)).size;
  return { words, segments, speakerCount };
}

/**
 * Cut multi-speaker segments into single-speaker pieces using word-level
 * speaker labels. ASR engines emit segments based on prosody / pauses,
 * which can easily span a speaker turn; the resulting "30-second chunk
 * with two voices in it" muddies the per-chunk speaker assignment UI
 * AND the voice fingerprint trained from that audio.
 *
 * Algorithm: for each input segment, group its words into same-speaker
 * runs, absorb any run shorter than `minLengthSeconds` into the longer
 * adjacent run, then re-merge adjacent same-speaker runs (created by
 * absorption) and emit one segment per surviving run.
 *
 * Generic-over-segment so callers keep their richer shape (text, etc.).
 * Run mergeSpeakers FIRST so words have their per-word speaker labels.
 */
export function splitSegmentsByTurn<
  S extends TimedWithSpeaker & { text: string },
  W extends TimedWithSpeaker & { text: string },
>(
  segments: S[],
  words: W[],
  minLengthSeconds = 1.5,
): S[] {
  if (segments.length === 0 || words.length === 0) return segments;

  const sortedWords = [...words].sort((a, b) => a.start - b.start);
  const result: S[] = [];

  for (const seg of segments) {
    const segWords = sortedWords.filter(w => w.end > seg.start && w.start < seg.end);
    if (segWords.length === 0) {
      result.push(seg);
      continue;
    }

    type Run = { speaker: string | null; words: W[]; start: number; end: number };
    const runs: Run[] = [];
    for (const w of segWords) {
      const sp = w.speaker ?? null;
      const last = runs[runs.length - 1];
      if (last && last.speaker === sp) {
        last.words.push(w);
        last.end = w.end;
      } else {
        runs.push({ speaker: sp, words: [w], start: w.start, end: w.end });
      }
    }

    // Absorb short runs into the longer adjacent run so we don't emit
    // half-second crumbs. Multiple passes because absorbing can leave
    // another short run newly-isolated.
    let changed = true;
    while (changed && runs.length > 1) {
      changed = false;
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (run.end - run.start >= minLengthSeconds) continue;
        const prev = i > 0 ? runs[i - 1] : null;
        const next = i + 1 < runs.length ? runs[i + 1] : null;
        const prevDur = prev ? prev.end - prev.start : -1;
        const nextDur = next ? next.end - next.start : -1;
        if (prev && (!next || prevDur >= nextDur)) {
          prev.words.push(...run.words);
          prev.end = run.end;
          runs.splice(i, 1);
        } else if (next) {
          next.words.unshift(...run.words);
          next.start = run.start;
          runs.splice(i, 1);
        } else {
          continue;
        }
        changed = true;
        break;
      }
    }

    // Re-merge adjacent same-speaker runs created by the absorption pass.
    const merged: Run[] = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last && last.speaker === run.speaker) {
        last.words.push(...run.words);
        last.end = run.end;
      } else {
        merged.push(run);
      }
    }

    for (const run of merged) {
      result.push({
        ...seg,
        start: run.start,
        end: run.end,
        text: run.words.map(w => w.text).join(" ").replace(/\s+/g, " ").trim(),
        speaker: run.speaker,
      });
    }
  }

  return result;
}
