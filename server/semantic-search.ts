import { embed, formatEmbeddingQuery } from "./llm";
import {
  getDb,
  normalizeVector,
  type TranscriptSearchResult,
  type TranscriptSearchFilters,
} from "./db";

// Semantic search powered by sqlite-vec's vec0 virtual table. Replaces an
// earlier pure-JS in-memory cosine implementation that didn't scale past
// ~50K segments. vec0 handles indexing internally — no manual cache, no
// counter, queries hit SQL directly and return top-K in milliseconds.

function normalizeDateFilter(value: string): string {
  return value.replaceAll("-", "");
}

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export interface SemanticSearchArgs {
  query: string;
  model: string;
  /** Top-K cap. Lower defaults than FTS because semantic returns
   *  scored-by-similarity — beyond a few dozen, signal-to-noise tanks. */
  limit?: number;
  /** Cosine threshold (similarity, not distance). Anything below this is
   *  filtered out — keeps the result list focused on actually-relevant
   *  matches. Tuned for typical sentence-embedding models in the
   *  [0, 0.85] relevant-content range. */
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
  searchDurationMs: number;
  vectorsScanned: number;
  minScore: number;
  model: string;
}

interface VecKnnRow {
  video_id: string;
  channel_id: string;
  segment_index: number;
  model: string;
  text: string;
  start_seconds: number;
  end_seconds: number;
  speaker: string | null;
  distance: number;
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
  category: string;
}

function loadVideoMeta(): Map<string, VideoMetaRow> {
  const rows = getDb().prepare(`
    SELECT q.video_id, q.channel_id, c.name AS channel_name, q.title, q.url,
           q.upload_date, q.status, q.is_live, q.video_path, q.md_path, q.word_count,
           q.category
    FROM video_queue q
    LEFT JOIN channels c ON c.id = q.channel_id
  `).all() as VideoMetaRow[];
  return new Map(rows.map((r) => [`${r.video_id}|${r.channel_id}`, r]));
}

/**
 * Build a function that answers "does this (video, channel) have at
 * least one clip matching every requested tag?" Used to filter semantic
 * search results by tag scope. Hierarchical: "religion" matches clips
 * tagged "religion" or "religion.<anything>" — same semantics as FTS.
 */
function buildTagPassFn(tags: string[]): (videoId: string, channelId: string) => boolean {
  // For each tag, get the set of (videoId, channelId) keys with at least
  // one matching clip. Pass = key is in EVERY tag's set (intersection).
  const sets: Set<string>[] = tags.map((tag) => {
    const rows = getDb().prepare(`
      SELECT DISTINCT tc.video_id, tc.channel_id
      FROM transcript_clips tc
      JOIN clip_tags ct ON ct.clip_id = tc.id
      WHERE ct.tag = ? OR ct.tag LIKE ? || '.%'
    `).all(tag, tag) as { video_id: string; channel_id: string }[];
    return new Set(rows.map(r => `${r.video_id}|${r.channel_id}`));
  });
  return (videoId, channelId) => {
    const key = `${videoId}|${channelId}`;
    return sets.every(s => s.has(key));
  };
}

export async function searchSemantic(args: SemanticSearchArgs): Promise<SemanticSearchResponse> {
  const { query, model, filters = {} } = args;
  const limit = Math.max(1, Math.min(args.limit ?? 30, 200));
  const minScore = args.minScore ?? 0.4;

  const t0 = Date.now();
  const [queryVecRaw] = await embed({ texts: [formatEmbeddingQuery(query, model)], model });
  // Normalize to match the unit-norm storage so L2 ranking == cosine ranking.
  const queryVec = normalizeVector(queryVecRaw);
  const queryEmbedDurationMs = Date.now() - t0;

  // For unit-norm vectors, L2 distance squared = 2·(1 − cos_sim), so:
  //   cos_sim = 1 − d²/2
  //   d² ≤ 2·(1 − minScore)
  //   d  ≤ √(2·(1 − minScore))
  // vec0's `distance` column is L2 (NOT squared), so we filter on the
  // square-root form. minScore=0.4 → maxDistance ≈ 1.0954.
  const maxDistance = Math.sqrt(2 * (1 - minScore));

  // Pull more candidates than we need so post-filter losses (model,
  // distance threshold, channel/status/date/tags) still leave us with
  // a full top-K. Capped at 1000 — beyond that the filter is doing
  // too much work and we should narrow the query.
  const k = Math.min(Math.max(limit * 4, 50), 1000);

  const t1 = Date.now();

  // STAGE 1: pure KNN against vec_segments. vec0's WHERE during MATCH is
  // strict — even straightforward shapes like `WITH top_k AS (...) SELECT
  // ... WHERE t.distance <= ?` trip its query planner ("illegal WHERE"
  // error). Keep this query exactly to vec0's blessed shape and apply
  // every other filter in JS.
  const knnRows = getDb().prepare(`
    SELECT video_id, channel_id, segment_index, model, text,
           start_seconds, end_seconds, speaker, distance
    FROM vec_segments
    WHERE embedding MATCH ?
      AND k = ?
  `).all(float32ToBuffer(queryVec), k) as VecKnnRow[];

  // Filter to the requested model + distance threshold, then sort.
  const candidates = knnRows
    .filter((r) => r.model === model && r.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);

  // STAGE 2: load video metadata for filtering + result shape. video_queue
  // is small (≤ thousands), so loading all rows into a Map once is faster
  // than per-row queries or building dynamic IN clauses.
  const meta = candidates.length > 0 ? loadVideoMeta() : new Map<string, VideoMetaRow>();
  const searchDurationMs = Date.now() - t1;

  const dateFrom = filters.dateFrom ? normalizeDateFilter(filters.dateFrom) : null;
  const dateTo = filters.dateTo ? normalizeDateFilter(filters.dateTo) : null;
  const tagFilter = (filters.tags ?? [])
    .map(t => t.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean);
  const tagPassFn = tagFilter.length > 0 ? buildTagPassFn(tagFilter) : null;

  const results: SemanticSearchResult[] = [];
  for (const row of candidates) {
    if (results.length >= limit) break;
    const m = meta.get(`${row.video_id}|${row.channel_id}`);
    if (!m) continue;
    if (filters.channelId && filters.channelId !== "all" && m.channel_id !== filters.channelId) continue;
    if (filters.status && filters.status !== "all" && m.status !== filters.status) continue;
    if (filters.isLive !== undefined && m.is_live !== (filters.isLive ? 1 : 0)) continue;
    if (dateFrom && (!m.upload_date || m.upload_date < dateFrom)) continue;
    if (dateTo && (!m.upload_date || m.upload_date > dateTo)) continue;
    if ((filters.category === "personal" || filters.category === "work") && m.category !== filters.category) continue;
    if (tagPassFn && !tagPassFn(m.video_id, m.channel_id)) continue;

    // L2 distance d, unit-norm vectors: cos_sim = 1 − d²/2. Score is in
    // [-1, 1] in theory; for relevant content typically [0, 0.85].
    const score = 1 - (row.distance * row.distance) / 2;
    results.push({
      video_id: row.video_id,
      channel_id: row.channel_id,
      channel_name: m.channel_name,
      title: m.title,
      url: m.url,
      upload_date: m.upload_date,
      status: m.status,
      is_live: m.is_live,
      video_path: m.video_path,
      md_path: m.md_path,
      word_count: m.word_count,
      segment_index: row.segment_index,
      start_seconds: row.start_seconds,
      end_seconds: row.end_seconds,
      speaker: row.speaker,
      text: row.text,
      // Mirror FTS's "lower is better" convention.
      rank: row.distance,
      score,
    });
  }

  return {
    results,
    queryEmbedDurationMs,
    searchDurationMs,
    vectorsScanned: knnRows.length,
    minScore,
    model,
  };
}
