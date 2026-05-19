import fs from "fs";
import { getDb } from "./db";

// ---------------------------------------------------------------
// Video queue + transcript index + FTS5 transcript search
//
// One table cluster: video_queue holds every video Concord knows about
// (pending / downloading / transcribing / complete / failed), and
// transcript_index + transcript_segments_fts give us FTS5 keyword search
// over the produced markdown transcripts.
//
// getTranscriptSegmentsForVideo and parseTranscriptSegments are the
// two file-IO functions everyone else uses to read a transcript's
// timestamped segments back; they live here because the queue is the
// source of truth for "which video, what md_path."
// ---------------------------------------------------------------

export interface QueueEntry {
  video_id: string;
  channel_id: string;
  title: string;
  url: string;
  duration: number | null;
  is_live: number;
  is_shorts: number;
  upload_date: string | null;
  status: string;
  video_path: string | null;
  /** Optional playback sidecar — set when video_path is in a container/codec
   *  Firefox/Safari can't decode (e.g. Ogg-Speex). Server prefers this for
   *  the /stream endpoint when present. Transcription still uses the
   *  original. */
  playback_path: string | null;
  md_path: string | null;
  word_count: number;
  error: string | null;
  retries: number;
  notes: string | null;
  /** Auto-generated 2-3 sentence summary. Distinct from `notes` so the
   *  user's own observations and the AI's derived summary never overwrite
   *  each other. Regenerable from any chat model — the model id is
   *  recorded alongside so the UI can flag stale summaries. */
  ai_summary: string | null;
  ai_summary_model: string | null;
  /** User-toggled star flag. 1 = important / crucial reference; 0 = default. */
  starred: number;
  created_at: string;
  updated_at: string;
}

export interface QueueListFilters {
  limit?: number;
  offset?: number;
  status?: string;
  channelId?: string;
  type?: string;
  hasTranscript?: string;
  /** "yes" to limit to starred rows; anything else is no-op. */
  starred?: string;
  q?: string;
  sort?: string;
}

export interface QueueListResult {
  rows: QueueEntry[];
  total: number;
  counts: Record<string, number>;
}

export interface TranscriptSearchFilters {
  channelId?: string;
  status?: string;
  isLive?: boolean;
  dateFrom?: string;
  dateTo?: string;
  tags?: string[];
  /** Filter to segments spoken by a specific global speaker. Resolves
   *  the local "S0"/"S1" labels to the global speaker via
   *  video_speaker_assignments. */
  speakerId?: string;
  limit?: number;
}

export interface TranscriptSearchResult {
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
  segment_index: number;
  start_seconds: number;
  end_seconds: number;
  speaker: string | null;
  text: string;
  rank: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

// ---- Single-row reads ----

export function getQueueEntryByVideoId(videoId: string): QueueEntry | undefined {
  return getDb().prepare(
    "SELECT * FROM video_queue WHERE video_id = ? ORDER BY updated_at DESC LIMIT 1"
  ).get(videoId) as QueueEntry | undefined;
}

export function getQueueEntry(videoId: string, channelId: string): QueueEntry | undefined {
  return getDb().prepare(
    "SELECT * FROM video_queue WHERE video_id = ? AND channel_id = ? LIMIT 1"
  ).get(videoId, channelId) as QueueEntry | undefined;
}

export function videoExists(videoId: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM video_queue WHERE video_id = ? LIMIT 1").get(videoId);
  return !!row;
}

export function countChannelQueueEntries(channelId: string): number {
  const row = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM video_queue WHERE channel_id = ?"
  ).get(channelId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

// ---- Enqueue ----

/** Insert a video into the queue. Skips if already present. Returns true if inserted. */
export function enqueueVideo(v: {
  videoId: string;
  channelId: string;
  title: string;
  url: string;
  duration?: number | null;
  isLive?: boolean;
  isShorts?: boolean;
  uploadDate?: string | null;
}): boolean {
  const d = getDb();
  const existing = d.prepare("SELECT 1 FROM video_queue WHERE video_id = ? LIMIT 1").get(v.videoId);
  if (existing) return false;

  d.prepare(`
    INSERT INTO video_queue (video_id, channel_id, title, url, duration, is_live, is_shorts, upload_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    v.videoId,
    v.channelId,
    v.title,
    v.url,
    v.duration ?? null,
    v.isLive ? 1 : 0,
    v.isShorts ? 1 : 0,
    v.uploadDate ?? null,
  );
  return true;
}

/** Bulk enqueue many videos. Returns count of newly inserted. */
export function enqueueVideos(
  videos: { videoId: string; channelId: string; title: string; url: string; duration?: number | null; isLive?: boolean; isShorts?: boolean; uploadDate?: string | null }[]
): number {
  let count = 0;
  const exists = getDb().prepare("SELECT 1 FROM video_queue WHERE video_id = ? LIMIT 1");
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO video_queue (video_id, channel_id, title, url, duration, is_live, is_shorts, upload_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);

  const tx = getDb().transaction(() => {
    for (const v of videos) {
      if (exists.get(v.videoId)) continue;
      const result = insert.run(
        v.videoId, v.channelId, v.title, v.url,
        v.duration ?? null, v.isLive ? 1 : 0, v.isShorts ? 1 : 0, v.uploadDate ?? null,
      );
      if (result.changes > 0) count++;
    }
  });

  tx();
  return count;
}

// ---- Pipeline picker queries ----

/** Get the next pending video to process (oldest first, skipping shorts). */
export function getNextPending(channelId?: string): QueueEntry | undefined {
  let sql = "SELECT * FROM video_queue WHERE status = 'pending' AND is_shorts = 0";
  const params: any[] = [];
  if (channelId) {
    sql += " AND channel_id = ?";
    params.push(channelId);
  }
  sql += " ORDER BY upload_date ASC NULLS LAST, created_at ASC LIMIT 1";

  return getDb().prepare(sql).get(...params) as QueueEntry | undefined;
}

/** Get the newest pending video (for monitoring mode). */
export function getNewestPending(channelId?: string): QueueEntry | undefined {
  let sql = "SELECT * FROM video_queue WHERE status = 'pending' AND is_shorts = 0";
  const params: any[] = [];
  if (channelId) {
    sql += " AND channel_id = ?";
    params.push(channelId);
  }
  sql += " ORDER BY upload_date DESC NULLS LAST, created_at DESC LIMIT 1";

  return getDb().prepare(sql).get(...params) as QueueEntry | undefined;
}

// ---- Status updates ----

/** Update status of a queued video. */
export function updateQueueStatus(
  videoId: string,
  channelId: string,
  updates: {
    status?: string;
    videoPath?: string | null;
    playbackPath?: string | null;
    mdPath?: string | null;
    wordCount?: number;
    error?: string | null;
    retries?: number;
  }
): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: any[] = [];

  if (updates.status !== undefined)  { sets.push("status = ?"); params.push(updates.status); }
  if (updates.videoPath !== undefined) { sets.push("video_path = ?"); params.push(updates.videoPath); }
  if (updates.playbackPath !== undefined) { sets.push("playback_path = ?"); params.push(updates.playbackPath); }
  if (updates.mdPath !== undefined)   { sets.push("md_path = ?"); params.push(updates.mdPath); }
  if (updates.wordCount !== undefined) { sets.push("word_count = ?"); params.push(updates.wordCount); }
  if (updates.error !== undefined)     { sets.push("error = ?"); params.push(updates.error); }
  if (updates.retries !== undefined)   { sets.push("retries = ?"); params.push(updates.retries); }

  params.push(videoId, channelId);
  getDb().prepare(`UPDATE video_queue SET ${sets.join(", ")} WHERE video_id = ? AND channel_id = ?`).run(...params);
}

/** Count by status for a channel (or all). */
export function countByStatus(channelId?: string): Record<string, number> {
  let sql = "SELECT status, COUNT(*) as cnt FROM video_queue WHERE is_shorts = 0";
  const params: any[] = [];
  if (channelId) { sql += " AND channel_id = ?"; params.push(channelId); }
  sql += " GROUP BY status";

  const rows = getDb().prepare(sql).all(...params) as { status: string; cnt: number }[];
  const result: Record<string, number> = {};
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

/** Total completed count. */
export function getTotalCompleted(): number {
  const row = getDb().prepare("SELECT COUNT(*) as cnt FROM video_queue WHERE status = 'complete'").get() as any;
  return row?.cnt ?? 0;
}

// ---- List queries ----

/** Get queue entries for a channel. */
export function getChannelQueue(channelId: string, limit: number = 100): QueueEntry[] {
  return getDb().prepare(
    "SELECT * FROM video_queue WHERE channel_id = ? ORDER BY upload_date DESC, created_at DESC LIMIT ?"
  ).all(channelId, limit) as QueueEntry[];
}

/** Get all queue entries (paginated). */
export function getAllQueue(limit: number = 100): QueueEntry[] {
  return getDb().prepare(
    "SELECT * FROM video_queue ORDER BY updated_at DESC LIMIT ?"
  ).all(limit) as QueueEntry[];
}

export function getQueueList(filters: QueueListFilters = {}): QueueListResult {
  const where: string[] = ["q.is_shorts = 0"];
  const params: any[] = [];

  if (filters.status && filters.status !== "all") {
    where.push("q.status = ?");
    params.push(filters.status);
  }
  if (filters.channelId && filters.channelId !== "all") {
    where.push("q.channel_id = ?");
    params.push(filters.channelId);
  }
  if (filters.type === "live") {
    where.push("q.is_live = 1");
  } else if (filters.type === "video") {
    where.push("q.is_live = 0");
  }
  if (filters.hasTranscript === "yes") {
    where.push("q.md_path IS NOT NULL AND q.md_path != ''");
  } else if (filters.hasTranscript === "no") {
    where.push("(q.md_path IS NULL OR q.md_path = '')");
  }
  if (filters.starred === "yes") {
    where.push("q.starred = 1");
  }
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim()}%`;
    where.push(`(
      q.title LIKE ?
      OR q.video_id LIKE ?
      OR q.channel_id LIKE ?
      OR COALESCE(c.name, '') LIKE ?
      OR q.upload_date LIKE ?
      OR q.status LIKE ?
      OR COALESCE(q.md_path, '') LIKE ?
      OR COALESCE(q.video_path, '') LIKE ?
    )`);
    params.push(like, like, like, like, like, like, like, like);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const orderSql = queueOrderSql(filters.sort);
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 100), 1), 100000);
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);

  const fromSql = "FROM video_queue q LEFT JOIN channels c ON c.id = q.channel_id";
  const totalRow = getDb().prepare(`SELECT COUNT(*) as count ${fromSql} ${whereSql}`).get(...params) as { count: number } | undefined;
  const rows = getDb().prepare(`
    SELECT q.*
    ${fromSql}
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as QueueEntry[];

  return { rows, total: totalRow?.count ?? 0, counts: countByStatus() };
}

function queueOrderSql(sort?: string): string {
  switch (sort) {
    case "upload_asc":
      return "ORDER BY q.upload_date ASC NULLS LAST, q.created_at ASC";
    case "updated_desc":
      return "ORDER BY q.updated_at DESC, q.upload_date DESC NULLS LAST";
    case "words_desc":
      return "ORDER BY q.word_count DESC, q.upload_date DESC NULLS LAST";
    case "title":
      return "ORDER BY q.title COLLATE NOCASE ASC";
    case "upload_desc":
    default:
      return "ORDER BY q.upload_date DESC NULLS LAST, q.created_at DESC";
  }
}

// ---- Per-video user notes + AI summary (kept on the queue row) ----

export function setVideoStarred(videoId: string, channelId: string, starred: boolean): void {
  getDb().prepare(`
    UPDATE video_queue
    SET starred = ?, updated_at = datetime('now')
    WHERE video_id = ? AND channel_id = ?
  `).run(starred ? 1 : 0, videoId, channelId);
}

export function setVideoNotes(videoId: string, channelId: string, notes: string | null): void {
  const trimmed = notes?.trim() ? notes.trim() : null;
  getDb().prepare(`
    UPDATE video_queue
    SET notes = ?, updated_at = datetime('now')
    WHERE video_id = ? AND channel_id = ?
  `).run(trimmed, videoId, channelId);
}

export function setVideoAiSummary(
  videoId: string,
  channelId: string,
  summary: string | null,
  model: string | null,
): void {
  const trimmed = summary?.trim() ? summary.trim() : null;
  getDb().prepare(`
    UPDATE video_queue
    SET ai_summary = ?, ai_summary_model = ?, updated_at = datetime('now')
    WHERE video_id = ? AND channel_id = ?
  `).run(trimmed, trimmed ? model : null, videoId, channelId);
}

// ---- Transcript index + FTS5 search ----

export function getTranscriptSearchIndexStats(): { files: number; segments: number } {
  const files = getDb().prepare("SELECT COUNT(*) as count FROM transcript_index").get() as { count: number } | undefined;
  const segments = getDb().prepare("SELECT COUNT(*) as count FROM transcript_segments_fts").get() as { count: number } | undefined;
  return { files: files?.count ?? 0, segments: segments?.count ?? 0 };
}

export function refreshTranscriptSearchIndex(): { indexed: number; skipped: number; segments: number; totalFiles: number; totalSegments: number } {
  const rows = getDb().prepare(`
    SELECT video_id, channel_id, md_path
    FROM video_queue
    WHERE md_path IS NOT NULL AND md_path != ''
  `).all() as Pick<QueueEntry, "video_id" | "channel_id" | "md_path">[];

  let indexed = 0;
  let skipped = 0;
  let segments = 0;

  const current = getDb().prepare(`
    SELECT md_path, md_mtime_ms
    FROM transcript_index
    WHERE video_id = ? AND channel_id = ?
  `);
  const clearIndex = getDb().prepare("DELETE FROM transcript_index WHERE video_id = ? AND channel_id = ?");
  const clearSegments = getDb().prepare("DELETE FROM transcript_segments_fts WHERE video_id = ? AND channel_id = ?");
  const insertIndex = getDb().prepare(`
    INSERT INTO transcript_index (video_id, channel_id, md_path, md_mtime_ms, segment_count, indexed_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertSegment = getDb().prepare(`
    INSERT INTO transcript_segments_fts (video_id, channel_id, segment_index, start_seconds, end_seconds, speaker, text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = getDb().transaction((row: Pick<QueueEntry, "video_id" | "channel_id" | "md_path">, parsed: TranscriptSegment[], mtimeMs: number) => {
    clearIndex.run(row.video_id, row.channel_id);
    clearSegments.run(row.video_id, row.channel_id);
    insertIndex.run(row.video_id, row.channel_id, row.md_path, mtimeMs, parsed.length);
    parsed.forEach((seg, index) => {
      insertSegment.run(row.video_id, row.channel_id, index, seg.start, seg.end, seg.speaker ?? null, seg.text);
    });
  });

  for (const row of rows) {
    if (!row.md_path || !fs.existsSync(row.md_path)) {
      skipped++;
      continue;
    }

    const stat = fs.statSync(row.md_path);
    const existing = current.get(row.video_id, row.channel_id) as { md_path: string; md_mtime_ms: number } | undefined;
    if (existing && existing.md_path === row.md_path && existing.md_mtime_ms === stat.mtimeMs) {
      skipped++;
      continue;
    }

    const parsed = parseTranscriptSegments(row.md_path);
    if (!parsed.length) {
      skipped++;
      continue;
    }

    tx(row, parsed, stat.mtimeMs);
    indexed++;
    segments += parsed.length;
  }

  const stats = getTranscriptSearchIndexStats();
  return { indexed, skipped, segments, totalFiles: stats.files, totalSegments: stats.segments };
}

export function searchTranscriptSegments(query: string, filters: TranscriptSearchFilters = {}): TranscriptSearchResult[] {
  refreshTranscriptSearchIndex();

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const where: string[] = ["transcript_segments_fts MATCH ?"];
  const params: any[] = [ftsQuery];

  if (filters.channelId && filters.channelId !== "all") {
    where.push("q.channel_id = ?");
    params.push(filters.channelId);
  }
  if (filters.status && filters.status !== "all") {
    where.push("q.status = ?");
    params.push(filters.status);
  }
  if (filters.isLive !== undefined) {
    where.push("q.is_live = ?");
    params.push(filters.isLive ? 1 : 0);
  }
  if (filters.dateFrom) {
    where.push("q.upload_date >= ?");
    params.push(normalizeDateFilter(filters.dateFrom));
  }
  if (filters.dateTo) {
    where.push("q.upload_date <= ?");
    params.push(normalizeDateFilter(filters.dateTo));
  }

  // Speaker filter: only return segments whose (video_id, channel_id,
  // speaker) maps to the requested global speaker via video_speaker_assignments.
  if (filters.speakerId) {
    where.push(`EXISTS (
      SELECT 1 FROM video_speaker_assignments vsa
      WHERE vsa.video_id = q.video_id
        AND vsa.channel_id = q.channel_id
        AND vsa.local_speaker = s.speaker
        AND vsa.speaker_id = ?
    )`);
    params.push(filters.speakerId);
  }

  // Tag scope: only return segments from videos that have at least one clip
  // matching every requested tag. Hierarchical: "religion" matches clips
  // tagged "religion" or "religion.<anything>".
  const tagFilter = (filters.tags ?? [])
    .map(t => t.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean);
  for (const tag of tagFilter) {
    where.push(`EXISTS (
      SELECT 1
      FROM transcript_clips tc
      JOIN clip_tags ct ON ct.clip_id = tc.id
      WHERE tc.video_id = q.video_id AND tc.channel_id = q.channel_id
        AND (ct.tag = ? OR ct.tag LIKE ? || '.%')
    )`);
    params.push(tag, tag);
  }

  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 100), 1), 500);
  params.push(limit);

  return getDb().prepare(`
    SELECT
      q.video_id,
      q.channel_id,
      c.name AS channel_name,
      q.title,
      q.url,
      q.upload_date,
      q.status,
      q.is_live,
      q.video_path,
      q.md_path,
      q.word_count,
      CAST(s.segment_index AS INTEGER) AS segment_index,
      CAST(s.start_seconds AS REAL) AS start_seconds,
      CAST(s.end_seconds AS REAL) AS end_seconds,
      s.speaker,
      s.text,
      bm25(transcript_segments_fts) AS rank
    FROM transcript_segments_fts s
    JOIN video_queue q ON q.video_id = s.video_id AND q.channel_id = s.channel_id
    LEFT JOIN channels c ON c.id = q.channel_id
    WHERE ${where.join(" AND ")}
    ORDER BY rank ASC, q.upload_date DESC, s.start_seconds ASC
    LIMIT ?
  `).all(...params) as TranscriptSearchResult[];
}

export function getTranscriptSegmentsForVideo(videoId: string, channelId: string): TranscriptSegment[] {
  const entry = getQueueEntry(videoId, channelId);
  if (!entry?.md_path || !fs.existsSync(entry.md_path)) return [];
  return parseTranscriptSegments(entry.md_path);
}

// ---- Transcript file parsing ----

export function parseTranscriptSegments(mdPath: string): TranscriptSegment[] {
  const jsonPath = mdPath.replace(/\.md$/i, ".json");
  if (fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (Array.isArray(parsed?.segments)) {
        const segments = parsed.segments
          .map((seg: any) => ({
            start: Number(seg.start),
            end: Number(seg.end),
            text: String(seg.text || "").trim(),
            speaker: seg.speaker ?? null,
          }))
          .filter((seg: TranscriptSegment) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.text);
        if (segments.length) return segments;
      }
    } catch {}
  }

  return parseMarkdownTranscriptSegments(fs.readFileSync(mdPath, "utf8"));
}

function parseMarkdownTranscriptSegments(markdown: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const linePattern = /^-\s+\[(\d{2}:\d{2}(?::\d{2})?)\s*(?:→|->|-)\s*(\d{2}:\d{2}(?::\d{2})?)\]\s+(.+)$/;

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match) continue;

    const start = parseTimestampSeconds(match[1]);
    const end = parseTimestampSeconds(match[2]);
    const text = match[3].trim();
    if (Number.isFinite(start) && Number.isFinite(end) && text) {
      segments.push({ start, end, text });
    }
  }

  return segments;
}

function parseTimestampSeconds(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number.NaN;
}

function normalizeDateFilter(value: string): string {
  return value.replaceAll("-", "");
}

/**
 * Convert a user query into an FTS5 MATCH expression.
 *  - Quoted strings ("red heifer") become a single FTS phrase.
 *  - Unquoted words become individual phrase tokens.
 *  - All tokens are AND-ed together so every term must match.
 */
function buildFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  const tokens: string[] = [];
  const phrasePattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = phrasePattern.exec(trimmed)) !== null) {
    const phrase = match[1] ?? match[2] ?? "";
    const cleaned = phrase
      .split(/\s+/)
      .map(t => t.replace(/[^A-Za-z0-9_'-]/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (cleaned) tokens.push(`"${cleaned.replaceAll('"', '""')}"`);
    if (tokens.length >= 12) break;
  }

  return tokens.join(" AND ");
}
