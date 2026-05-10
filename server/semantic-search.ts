import { embed, formatEmbeddingQuery } from "./llm";
import {
  getAllEmbeddings,
  getEmbeddingWriteCounter,
  getDb,
  type SegmentEmbedding,
  type TranscriptSearchResult,
  type TranscriptSearchFilters,
} from "./db";
import { isMeaningfulSegment } from "./embed-segments";

// In-memory cache of every stored embedding for a single model. Reloaded
// from disk only when the write-counter has changed since the snapshot —
// so a 100k-vector library reloads at most once per write batch (e.g.
// after a backfill or a single auto-embed completes), and queries within
// a steady-state corpus pay zero IO.
let cache: { model: string; counter: number; vectors: SegmentEmbedding[] } | null = null;

function loadVectors(model: string): SegmentEmbedding[] {
  const counter = getEmbeddingWriteCounter();
  if (cache && cache.model === model && cache.counter === counter) {
    return cache.vectors;
  }
  const vectors = getAllEmbeddings(model);
  cache = { model, counter, vectors };
  return vectors;
}

/**
 * Cosine similarity. Range [-1, 1] where 1 is identical direction. Values
 * for query/segment text from common embedding models are typically in
 * [0.0, 0.85] for related content; use a per-app threshold to filter
 * "obviously irrelevant" matches if needed.
 *
 * Pure-JS, optimized for Float32Array. Per the handoff: ~50ms for 100k
 * vectors of 768-1024 dim on M-series. No native deps, no sqlite-vec.
 */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function normalizeDateFilter(value: string): string {
  return value.replaceAll("-", "");
}

interface VideoMetaRow {
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string;
  url: string;
  upload_date: string | null;
  status: string;
  is_live: number;
  video_path: string | null;
  md_path: string | null;
  word_count: number;
}

function loadVideoMeta(): Map<string, VideoMetaRow> {
  const rows = getDb().prepare(`
    SELECT q.video_id, q.channel_id, c.name AS channel_name, q.title, q.url,
           q.upload_date, q.status, q.is_live, q.video_path, q.md_path, q.word_count
    FROM video_queue q
    LEFT JOIN channels c ON c.id = q.channel_id
  `).all() as VideoMetaRow[];
  return new Map(rows.map((r) => [`${r.video_id}|${r.channel_id}`, r]));
}

export interface SemanticSearchArgs {
  query: string;
  model: string;
  /** Top-K cap. Lower defaults than FTS because semantic returns
   *  scored-by-similarity — beyond a few dozen, signal-to-noise tanks. */
  limit?: number;
  /** Cosine threshold. Anything below this is filtered out — keeps the
   *  result list focused on actually-relevant matches instead of letting
   *  trivia like "Um" / "so" / "What?" leak in. Tuned for typical
   *  sentence-embedding models in the [0, 0.85] relevant-content range. */
  minScore?: number;
  filters?: TranscriptSearchFilters;
}

export interface SemanticSearchResult extends TranscriptSearchResult {
  /** Cosine similarity in [-1, 1]. >0.7 = strong, 0.5-0.7 = good,
   *  0.4-0.5 = weak. Below minScore is filtered server-side. */
  score: number;
}

export interface SemanticSearchResponse {
  results: SemanticSearchResult[];
  queryEmbedDurationMs: number;
  cosineDurationMs: number;
  vectorsScanned: number;
  vectorsAboveThreshold: number;
  minScore: number;
  model: string;
}

export async function searchSemantic(args: SemanticSearchArgs): Promise<SemanticSearchResponse> {
  const { query, model, filters = {} } = args;
  const limit = Math.max(1, Math.min(args.limit ?? 30, 200));
  const minScore = args.minScore ?? 0.4;

  const t0 = Date.now();
  const [queryVec] = await embed({ texts: [formatEmbeddingQuery(query, model)], model });
  const queryEmbedDurationMs = Date.now() - t0;

  const vectors = loadVectors(model);

  const t1 = Date.now();
  // Score everything that passes the meaningful-segment filter, threshold,
  // then sort. Filtering trivial segments (single words, sub-second
  // turns) here means existing embeddings get cleaned up at query time
  // without requiring a re-embed of the whole library.
  const scored: { v: SegmentEmbedding; score: number }[] = [];
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!isMeaningfulSegment({ text: v.text, start: v.start_seconds, end: v.end_seconds })) continue;
    const s = cosine(queryVec, v.embedding);
    if (s >= minScore) scored.push({ v, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const cosineDurationMs = Date.now() - t1;
  const vectorsAboveThreshold = scored.length;

  // Join with queue/channel meta. video_queue is small (≤ thousands) so
  // load it all into a Map once per call rather than per-row queries.
  const meta = loadVideoMeta();

  const results: SemanticSearchResult[] = [];
  const dateFrom = filters.dateFrom ? normalizeDateFilter(filters.dateFrom) : null;
  const dateTo = filters.dateTo ? normalizeDateFilter(filters.dateTo) : null;

  for (const { v, score } of scored) {
    if (results.length >= limit) break;
    const m = meta.get(`${v.video_id}|${v.channel_id}`);
    if (!m) continue;

    if (filters.channelId && filters.channelId !== "all" && m.channel_id !== filters.channelId) continue;
    if (filters.status && filters.status !== "all" && m.status !== filters.status) continue;
    if (filters.isLive !== undefined && m.is_live !== (filters.isLive ? 1 : 0)) continue;
    if (dateFrom && (!m.upload_date || m.upload_date < dateFrom)) continue;
    if (dateTo && (!m.upload_date || m.upload_date > dateTo)) continue;

    results.push({
      video_id: v.video_id,
      channel_id: v.channel_id,
      channel_name: m.channel_name,
      title: m.title,
      url: m.url,
      upload_date: m.upload_date,
      status: m.status,
      is_live: m.is_live,
      video_path: m.video_path,
      md_path: m.md_path,
      word_count: m.word_count,
      segment_index: v.segment_index,
      start_seconds: v.start_seconds,
      end_seconds: v.end_seconds,
      speaker: v.speaker,
      text: v.text,
      // Mirror FTS's "lower is better" convention so the existing UI sort
      // works without changes. Negate cosine: max similarity 1 → rank -1.
      rank: -score,
      score,
    });
  }

  return {
    results,
    queryEmbedDurationMs,
    cosineDurationMs,
    vectorsScanned: vectors.length,
    vectorsAboveThreshold,
    minScore,
    model,
  };
}
