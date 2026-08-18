import { getDb, EMBEDDING_DIM } from "./db";
import { assertEmbeddingVectorDimensions } from "./embedding-dimensions";

// ---------------------------------------------------------------
// Segment embeddings — semantic search via sqlite-vec
//
// Storage: vec0 virtual table `vec_segments` (created in db.ts getDb).
// sqlite-vec handles indexing internally — no manual cache, no write
// counter. Queries use `WHERE embedding MATCH ? AND model = ? AND k = ?`
// for KNN search, with auxiliary columns (text, speaker, etc.) returned
// inline so we don't need a join back to a side table.
// ---------------------------------------------------------------

export interface EmbeddingInput {
  segmentIndex: number;
  embedding: Float32Array;
  text: string;
  start: number;
  end: number;
  speaker: string | null;
}

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Unit-normalize a vector. vec0 only supports L2 distance; for unit-norm
 * vectors L2 ranking is identical to cosine ranking (d² = 2 - 2·cos),
 * so normalizing at insert + query gives us cosine semantics for free.
 *
 * Idempotent on already-normalized input. Returns the input untouched
 * if its norm is zero (degenerate empty vector — can't happen in
 * practice but guard against div-by-zero).
 */
export function normalizeVector(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Replace all embeddings for one (video, channel, model) in vec_segments.
 *  Throws on dimension mismatch — the caller (embed-segments.ts) catches
 *  config errors and returns a "skipped" result, so this surfaces a clear
 *  message to the user instead of silently storing corrupt data. */
export function replaceVideoEmbeddings(args: {
  videoId: string;
  channelId: string;
  model: string;
  rows: EmbeddingInput[];
}): void {
  const { videoId, channelId, model, rows } = args;
  // Last-line dim check — fail loudly before touching the DB even when a
  // caller did not use llm.embed's expectedDimensions validation.
  assertEmbeddingVectorDimensions(
    rows.map((row) => row.embedding),
    model,
    EMBEDDING_DIM,
  );
  const d = getDb();
  const clear = d.prepare(
    "DELETE FROM vec_segments WHERE video_id = ? AND channel_id = ? AND model = ?",
  );
  const insert = d.prepare(`
    INSERT INTO vec_segments
      (embedding, video_id, channel_id, segment_index, model, text, start_seconds, end_seconds, speaker)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = d.transaction(() => {
    clear.run(videoId, channelId, model);
    for (const row of rows) {
      // Normalize at insert so L2 ranking == cosine ranking later.
      const normalized = normalizeVector(row.embedding);
      insert.run(
        float32ToBuffer(normalized),
        videoId, channelId,
        // BigInt forces INTEGER binding — better-sqlite3 binds plain JS
        // numbers as REAL/FLOAT by default, which vec0 strictly rejects
        // for INTEGER aux columns ("type mismatch" error).
        BigInt(row.segmentIndex),
        model,
        row.text, row.start, row.end, row.speaker,
      );
    }
  });
  tx();
}

export function clearVideoEmbeddings(videoId: string, channelId: string, model?: string): number {
  const d = getDb();
  return model
    ? d.prepare("DELETE FROM vec_segments WHERE video_id = ? AND channel_id = ? AND model = ?").run(videoId, channelId, model).changes
    : d.prepare("DELETE FROM vec_segments WHERE video_id = ? AND channel_id = ?").run(videoId, channelId).changes;
}

export function clearAllEmbeddings(model?: string): number {
  const d = getDb();
  return model
    ? d.prepare("DELETE FROM vec_segments WHERE model = ?").run(model).changes
    : d.prepare("DELETE FROM vec_segments").run().changes;
}

export interface EmbeddingStats {
  models: { model: string; videos: number; segments: number }[];
  totalSegments: number;
  totalVideos: number;
}

export function getEmbeddingStats(): EmbeddingStats {
  const rows = getDb().prepare(`
    SELECT model,
           COUNT(DISTINCT video_id || ':' || channel_id) AS videos,
           COUNT(*) AS segments
    FROM vec_segments
    GROUP BY model
    ORDER BY model
  `).all() as { model: string; videos: number; segments: number }[];
  const totalSegments = rows.reduce((s, r) => s + r.segments, 0);
  const totalVideos = rows.reduce((s, r) => Math.max(s, r.videos), 0);
  return { models: rows, totalSegments, totalVideos };
}

/** Cheap "have we already embedded this video at this model" check —
 *  used by the auto-embed hook to avoid re-running on retranscribe. */
export function hasVideoEmbeddings(videoId: string, channelId: string, model: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM vec_segments
    WHERE video_id = ? AND channel_id = ? AND model = ?
    LIMIT 1
  `).get(videoId, channelId, model);
  return !!row;
}

/** Bulk variant of hasVideoEmbeddings — returns the full distinct list of
 *  (videoId, channelId) pairs that have any embeddings for this model.
 *  Used by the reindex endpoint so it doesn't pay N round-trips when
 *  filtering "which videos still need embedding" across hundreds of rows. */
export function getCoveredVideoKeysForModel(model: string): Array<{ videoId: string; channelId: string }> {
  const rows = getDb().prepare(`
    SELECT DISTINCT video_id, channel_id
    FROM vec_segments WHERE model = ?
  `).all(model) as Array<{ video_id: string; channel_id: string }>;
  return rows.map((r) => ({ videoId: r.video_id, channelId: r.channel_id }));
}
