import {
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

  try {
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE);
      const texts = batch.map((s) => s.text);
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
