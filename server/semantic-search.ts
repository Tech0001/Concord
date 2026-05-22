import { embed, formatEmbeddingQuery } from "./llm";
import {
  getDb,
  normalizeVector,
  videoKind,
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
  /** Source discriminator. "video" = video transcript segment;
   *  "doc" = markdown doc chunk (with the doc-specific fields below
   *  populated). Default "video" for back-compat with existing
   *  callers that ignore the field. */
  source?: "video" | "doc";
  /** Doc-source fields — populated when source === "doc". */
  document_id?: string;
  doc_rel_path?: string;
  doc_title?: string;
  doc_heading_path?: string;
  doc_start_char?: number;
  doc_end_char?: number;
  doc_chunk_index?: number;
  doc_category?: string;
  /** Which root the doc lives under. Routes that fetch the file
   *  need this when more than one root is configured — without it
   *  the server falls back to the first root and a doc that lives
   *  in another root 404s. Empty string for the legacy root. */
  doc_root_id?: string;
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

interface DocMetaRow {
  id: string;
  rel_path: string;
  title: string;
  category: string;
  root_id: string;
}

function loadDocMeta(): Map<string, DocMetaRow> {
  // COALESCE handles legacy rows from before the root_id column —
  // those belong to the empty-id "legacy" root.
  const rows = getDb()
    .prepare("SELECT id, rel_path, title, category, COALESCE(root_id, '') AS root_id FROM documents")
    .all() as DocMetaRow[];
  return new Map(rows.map((r) => [r.id, r]));
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

  // Source-kind filter — when the caller passes filters.sources, we
  // skip whole pools whose source isn't selected. Per-row audio-vs-
  // video filtering happens further down using videoKind() on the
  // resolved file path.
  const sources = filters.sources && filters.sources.length > 0
    ? new Set(filters.sources)
    : null;
  const wantsVideoPool = !sources || sources.has("video") || sources.has("audio");
  const wantsDocPool = !sources || sources.has("doc");

  // STAGE 1: pure KNN against vec_segments. vec0's WHERE during MATCH is
  // strict — even straightforward shapes like `WITH top_k AS (...) SELECT
  // ... WHERE t.distance <= ?` trip its query planner ("illegal WHERE"
  // error). Keep this query exactly to vec0's blessed shape and apply
  // every other filter in JS.
  const knnRows = wantsVideoPool
    ? getDb().prepare(`
        SELECT video_id, channel_id, segment_index, model, text,
               start_seconds, end_seconds, speaker, distance
        FROM vec_segments
        WHERE embedding MATCH ?
          AND k = ?
      `).all(float32ToBuffer(queryVec), k) as VecKnnRow[]
    : [];

  // Parallel KNN against doc chunks. Same dim, same model gate. Both
  // pools are merged below by distance — vec0's distance is metric so
  // doc and video hits are directly comparable.
  interface VecDocKnnRow {
    document_id: string;
    chunk_index: number;
    model: string;
    text: string;
    heading_path: string | null;
    start_char: number;
    end_char: number;
    distance: number;
  }
  const docKnnRows = wantsDocPool
    ? getDb().prepare(`
        SELECT document_id, chunk_index, model, text, heading_path,
               start_char, end_char, distance
        FROM vec_docs
        WHERE embedding MATCH ?
          AND k = ?
      `).all(float32ToBuffer(queryVec), k) as VecDocKnnRow[]
    : [];

  // Filter to the requested model + distance threshold, then sort.
  const candidates = knnRows
    .filter((r) => r.model === model && r.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);

  const docCandidates = docKnnRows
    .filter((r) => r.model === model && r.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);

  // STAGE 2: load video + doc metadata for filtering + result shape.
  // Both tables are small (≤ thousands of rows in practice), so a
  // one-shot Map per call is cheaper than per-row queries or
  // dynamic IN-clauses.
  const meta = candidates.length > 0 ? loadVideoMeta() : new Map<string, VideoMetaRow>();
  const docMeta = docCandidates.length > 0 ? loadDocMeta() : new Map<string, DocMetaRow>();
  const searchDurationMs = Date.now() - t1;

  const dateFrom = filters.dateFrom ? normalizeDateFilter(filters.dateFrom) : null;
  const dateTo = filters.dateTo ? normalizeDateFilter(filters.dateTo) : null;
  const tagFilter = (filters.tags ?? [])
    .map(t => t.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean);
  const tagPassFn = tagFilter.length > 0 ? buildTagPassFn(tagFilter) : null;

  // Build per-source result lists with their filters applied, then
  // interleave by distance (lower = better) and cap at the limit.
  const videoResults: SemanticSearchResult[] = [];
  for (const row of candidates) {
    const m = meta.get(`${row.video_id}|${row.channel_id}`);
    if (!m) continue;
    if (filters.channelId && filters.channelId !== "all" && m.channel_id !== filters.channelId) continue;
    if (filters.status && filters.status !== "all" && m.status !== filters.status) continue;
    if (filters.isLive !== undefined && m.is_live !== (filters.isLive ? 1 : 0)) continue;
    if (dateFrom && (!m.upload_date || m.upload_date < dateFrom)) continue;
    if (dateTo && (!m.upload_date || m.upload_date > dateTo)) continue;
    if ((filters.category === "personal" || filters.category === "work") && m.category !== filters.category) continue;
    if (tagPassFn && !tagPassFn(m.video_id, m.channel_id)) continue;
    if (sources) {
      // Drop video-pool hits whose audio/video kind isn't selected.
      // "unknown" (path missing or unrecognized ext) passes through
      // — better to surface than to silently drop.
      const kind = videoKind(m.video_path);
      if (kind === "video" && !sources.has("video")) continue;
      if (kind === "audio" && !sources.has("audio")) continue;
    }

    const score = 1 - (row.distance * row.distance) / 2;
    videoResults.push({
      source: "video",
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
      rank: row.distance,
      score,
    });
  }

  const docResults: SemanticSearchResult[] = [];
  for (const row of docCandidates) {
    const d = docMeta.get(row.document_id);
    if (!d) continue;
    if ((filters.category === "personal" || filters.category === "work") && d.category !== filters.category) continue;

    const score = 1 - (row.distance * row.distance) / 2;
    // Doc hits use the TranscriptSearchResult shape with placeholder
    // video fields — the source/doc_* discriminators tell consumers
    // to render the doc citation path instead of channel @ timestamp.
    docResults.push({
      source: "doc",
      video_id: "",
      channel_id: "",
      channel_name: null,
      title: d.title,
      url: "",
      upload_date: null,
      status: "doc",
      is_live: 0,
      video_path: null,
      md_path: null,
      word_count: 0,
      segment_index: row.chunk_index,
      start_seconds: 0,
      end_seconds: 0,
      speaker: null,
      text: row.text,
      rank: row.distance,
      score,
      document_id: row.document_id,
      doc_root_id: d.root_id,
      doc_rel_path: d.rel_path,
      doc_title: d.title,
      doc_heading_path: row.heading_path ?? "",
      doc_start_char: row.start_char,
      doc_end_char: row.end_char,
      doc_chunk_index: row.chunk_index,
      doc_category: d.category,
    });
  }

  // Merge + interleave by ascending distance (lower = better). Cap at
  // the caller's requested limit so one source can't crowd the other
  // out entirely.
  const results = [...videoResults, ...docResults]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);

  return {
    results,
    queryEmbedDurationMs,
    searchDurationMs,
    vectorsScanned: knnRows.length + docKnnRows.length,
    minScore,
    model,
  };
}
