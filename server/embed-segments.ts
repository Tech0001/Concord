import {
  getDb,
  getTranscriptSegmentsForVideo,
  replaceVideoEmbeddings,
  type EmbeddingInput,
} from "./db";
import {
  embed,
  LlmConfigError,
  LlmUnreachableError,
  LlmHttpError,
} from "./llm";

/** Resolve every (local speaker → global name) mapping for one video
 *  in a single query. Returns a Map keyed by the LOCAL label
 *  (e.g. "S0") so the per-segment loop below is O(1) per row. Local
 *  speakers without a global assignment are absent from the map. */
function loadSpeakerNamesForVideo(videoId: string, channelId: string): Map<string, string> {
  const rows = getDb().prepare(`
    SELECT vsa.local_speaker, sp.name
    FROM video_speaker_assignments vsa
    JOIN speakers sp ON sp.id = vsa.speaker_id
    WHERE vsa.video_id = ? AND vsa.channel_id = ?
  `).all(videoId, channelId) as { local_speaker: string; name: string }[];
  return new Map(rows.map((r) => [r.local_speaker, r.name]));
}

export interface EmbedSegmentsResult {
  videoId: string;
  channelId: string;
  model: string;
  segmentCount: number;
  skipped?: string;
}

// Per-call batch size. Keeps payloads < ~50 KB and lets the LLM server
// pipeline batches efficiently. Tunable; oMLX/Ollama are both happy at 50.
const BATCH_SIZE = 50;

const MIN_WORDS = 3;
const MIN_DURATION_SEC = 1.0;

/**
 * Heuristic: a segment is worth embedding only if it carries more than
 * a filler word's worth of content. Catches things like "Um", "so",
 * "What?" — semantically meaningless, but their embeddings still score
 * mid-range against arbitrary queries due to short-text bias.
 *
 * Exported so the search path can apply the same filter to ALREADY
 * stored embeddings — no re-embed required to clean up existing data.
 */
export function isMeaningfulSegment(seg: { text: string; start: number; end: number }): boolean {
  const text = (seg.text || "").trim();
  if (!text) return false;
  const wordCount = text.split(/\s+/).length;
  if (wordCount < MIN_WORDS) return false;
  if ((seg.end - seg.start) < MIN_DURATION_SEC) return false;
  return true;
}

/**
 * Embed every segment of one transcribed video and store the vectors.
 * Best-effort by design — caller should not fail their flow on errors:
 *   - No embedding model configured → returns {skipped: "..."} (no throw)
 *   - LLM unreachable → returns {skipped: "..."} (no throw)
 *   - HTTP error from LLM → returns {skipped: "..."} (no throw)
 *   - Anything else → throws
 *
 * Existing embeddings for (videoId, channelId, model) are atomically
 * replaced — re-running on the same video is safe and idempotent.
 */
export async function embedSegmentsForVideo(
  videoId: string,
  channelId: string,
  model: string,
): Promise<EmbedSegmentsResult> {
  if (!model) {
    return { videoId, channelId, model: "", segmentCount: 0, skipped: "no embedding model configured" };
  }

  const allSegments = getTranscriptSegmentsForVideo(videoId, channelId);
  // Skip trivial segments — single words like "Um" / "so" / "What?" produce
  // embeddings that match almost everything (short-text bias) and pollute
  // semantic search results. Diarization splits sometimes emit these as
  // 1-word "turns"; filter them at the source.
  const segments = allSegments.filter(isMeaningfulSegment);
  if (segments.length === 0) {
    return { videoId, channelId, model, segmentCount: 0, skipped: "no meaningful segments to embed" };
  }

  const rows: EmbeddingInput[] = [];

  // Resolve local speaker labels → global names once. When a segment's
  // speaker has been labeled, we prefix the EMBED INPUT with the name
  // (e.g. "Brandon Biggs: I saw crypto being used at Starbucks") so
  // questions that mention the speaker by name vector-match their
  // first-person content. The stored segment.text is unchanged so the
  // displayed quote stays as the speaker actually said it. Unlabeled
  // speakers (null or unmapped local label) embed raw — no prefix.
  const speakerNames = loadSpeakerNamesForVideo(videoId, channelId);

  try {
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE);
      const texts = batch.map((s) => {
        const name = s.speaker ? speakerNames.get(s.speaker) : null;
        return name ? `${name}: ${s.text}` : s.text;
      });
      const vectors = await embed({ texts, model });

      if (vectors.length !== batch.length) {
        throw new Error(
          `Embedding response had ${vectors.length} vectors for ${batch.length} inputs`,
        );
      }

      batch.forEach((seg, j) => {
        rows.push({
          segmentIndex: i + j,
          embedding: vectors[j],
          text: seg.text,
          start: seg.start,
          end: seg.end,
          speaker: seg.speaker ?? null,
        });
      });
    }
  } catch (err) {
    if (err instanceof LlmConfigError || err instanceof LlmUnreachableError) {
      return { videoId, channelId, model, segmentCount: 0, skipped: err.message };
    }
    if (err instanceof LlmHttpError && err.status === 401) {
      return { videoId, channelId, model, segmentCount: 0, skipped: "LLM auth failed (set API key on AI page)" };
    }
    throw err;
  }

  replaceVideoEmbeddings({ videoId, channelId, model, rows });
  return { videoId, channelId, model, segmentCount: rows.length };
}
