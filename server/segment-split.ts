// Engine-agnostic, sentence-aware grouping of word-level timings into
// transcript segments. Both the Mac wrapper (FluidAudio) and the Linux
// pyannote+Parakeet wrapper consume word arrays with identical {start,
// end, text} shape; they share this splitter so segment boundaries — and
// therefore search/clip UX — are byte-identical across machines.
//
// Defaults tuned against spoken-word podcasts/sermons/interviews. Hard
// silence/duration caps prevent runaway segments; soft sentence-end snap
// keeps reads from chopping mid-thought.

export interface Word {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

export interface GroupOptions {
  /** Hard break on silence ≥ this many seconds. Always splits regardless
   *  of sentence state — silence is the cleanest natural turn boundary. */
  maxGap?: number;
  /** Don't soft-break sentences shorter than this. Avoids tiny-segment
   *  noise from rapid-fire short sentences. */
  softMin?: number;
  /** Once a segment grows past this duration we look for the next
   *  sentence-ending punctuation and split there. Sentences longer than
   *  this just keep going until the next period/question/exclamation. */
  softMax?: number;
  /** Absolute duration cap. Forces a split even mid-sentence if the
   *  speaker hasn't paused or punctuated. Prevents one giant 5-minute
   *  segment from a fast monologue. */
  hardMax?: number;
}

// Sentence-end detection. Parakeet emits punctuation attached to the word
// ("Mac.", "good!", "really?"). Trailing closing quotes/brackets allowed.
// Avoids false positives on common abbreviations: "Mr.", "Dr.", "U.S.", "e.g.".
export const SENTENCE_END = /[.!?…]['")\]}]?$/;

export const SENTENCE_END_FALSE_POSITIVES = new Set([
  "Mr.", "Mrs.", "Ms.", "Dr.", "Sr.", "Jr.", "St.", "Prof.",
  "vs.", "etc.", "e.g.", "i.e.", "a.m.", "p.m.", "U.S.", "U.K.",
]);

export function endsSentence(text: string): boolean {
  if (!SENTENCE_END.test(text)) return false;
  if (SENTENCE_END_FALSE_POSITIVES.has(text)) return false;
  // Bare initial like "J." or "A." — likely an abbreviation, not a sentence end.
  if (/^[A-Z]\.$/.test(text)) return false;
  return true;
}

/**
 * Group word-level timings into reader-friendly segments. Breaks on:
 *   - Silence longer than `maxGap` (always — natural turn boundary).
 *   - Sentence-ending punctuation, once segment is at least `softMin` long
 *     and the segment has approached or exceeded `softMax`.
 *   - Hard time cap `hardMax` (fallback for runaway no-pause speech).
 *
 * Result: segments tend to be one-or-a-few sentences and rarely break
 * mid-thought, which both reads better and keeps embedding chunks
 * semantically coherent for downstream similarity search.
 *
 * Pure function — no side effects, deterministic, identical inputs give
 * identical outputs. Safe to share across engines.
 */
export function groupWordsIntoSegments<W extends Word>(
  words: W[],
  options: GroupOptions = {},
): Segment[] {
  const { maxGap = 1.2, softMin = 5, softMax = 15, hardMax = 30 } = options;
  const segments: Segment[] = [];
  let current: W[] = [];

  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.text).join(" "),
    });
    current = [];
  };

  for (const word of words) {
    if (current.length === 0) {
      current = [word];
      continue;
    }
    const gap = word.start - current[current.length - 1].end;
    const durationIfAdded = word.end - current[0].start;

    // Hard breaks (don't include the new word in the old segment).
    if (gap > maxGap || durationIfAdded > hardMax) {
      flush();
      current = [word];
      continue;
    }

    // Soft break: include this word, then close if it ended a sentence
    // and the segment has length we're comfortable with.
    current.push(word);
    const finishedDuration = word.end - current[0].start;
    if (finishedDuration >= softMin && endsSentence(word.text) && finishedDuration >= softMax * 0.5) {
      // Once we're past softMax, ANY sentence end is good enough to flush.
      // Between softMin and softMax, we still flush on sentence ends so
      // natural reading rhythm is preserved on shorter monologues.
      flush();
    }
  }
  flush();
  return segments;
}
