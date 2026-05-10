import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import os from "os";
import path from "path";

// Embedding dimension is hardcoded to match Qwen3-Embedding-0.6B (the
// recommended embedding model for Concord). If the user switches to a
// different-dim model (e.g. EmbeddingGemma at 768), the insert path
// throws with a clear "wipe + reindex required" message and they re-run
// the AI page reindex with the new model. We intentionally don't try
// to support mixed dimensions in one table — that gets complicated fast.
const EMBEDDING_DIM = 1024;

let db: Database.Database | null = null;

function defaultDbPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Concord", "pipeline.db");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Concord", "pipeline.db");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "concord", "pipeline.db");
}

// One-shot migration from the legacy in-repo path. Runs before opening the
// DB, so no connection is held — a plain rename is safe. Sidecar WAL/SHM
// files are migrated alongside if present.
function migrateLegacyDbIfPresent(target: string): void {
  const legacy = path.resolve("./pipeline.db");
  if (legacy === target) return;
  if (fs.existsSync(target)) return;
  if (!fs.existsSync(legacy)) return;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(legacy, target);
  for (const sidecar of ["-wal", "-shm"]) {
    const src = legacy + sidecar;
    if (fs.existsSync(src)) fs.renameSync(src, target + sidecar);
  }
  console.log(`[db] Migrated legacy ./pipeline.db → ${target}`);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL UNIQUE,
    enabled    INTEGER NOT NULL DEFAULT 1,
    diarize    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS video_queue (
    video_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    duration    REAL,
    is_live     INTEGER DEFAULT 0,
    is_shorts   INTEGER DEFAULT 0,
    upload_date TEXT,
    status      TEXT DEFAULT 'pending',
    video_path  TEXT,
    md_path     TEXT,
    word_count  INTEGER DEFAULT 0,
    error       TEXT,
    retries     INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, channel_id)
  );

  CREATE INDEX IF NOT EXISTS idx_queue_status  ON video_queue(channel_id, status);
  CREATE INDEX IF NOT EXISTS idx_queue_date    ON video_queue(channel_id, upload_date);
  CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled);

  CREATE TABLE IF NOT EXISTS transcript_index (
    video_id       TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    md_path        TEXT NOT NULL,
    md_mtime_ms    REAL NOT NULL,
    segment_count  INTEGER NOT NULL DEFAULT 0,
    indexed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, channel_id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts USING fts5(
    video_id UNINDEXED,
    channel_id UNINDEXED,
    segment_index UNINDEXED,
    start_seconds UNINDEXED,
    end_seconds UNINDEXED,
    speaker UNINDEXED,
    text,
    tokenize = 'unicode61'
  );

  CREATE TABLE IF NOT EXISTS transcript_clips (
    id            TEXT PRIMARY KEY,
    video_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    title         TEXT NOT NULL,
    channel_name  TEXT,
    upload_date   TEXT,
    start_seconds REAL NOT NULL,
    end_seconds   REAL NOT NULL,
    quote         TEXT NOT NULL,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_clips_video ON transcript_clips(video_id, channel_id);
  CREATE INDEX IF NOT EXISTS idx_clips_created ON transcript_clips(created_at);

  CREATE TABLE IF NOT EXISTS clip_tags (
    clip_id    TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (clip_id, tag)
  );

  CREATE INDEX IF NOT EXISTS idx_clip_tags_tag ON clip_tags(tag);

  CREATE TABLE IF NOT EXISTS clip_links (
    from_clip_id TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
    to_clip_id   TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (from_clip_id, to_clip_id, kind)
  );

  CREATE INDEX IF NOT EXISTS idx_clip_links_to ON clip_links(to_clip_id);

  CREATE TABLE IF NOT EXISTS clip_map_layouts (
    map_key    TEXT NOT NULL,
    node_id    TEXT NOT NULL,
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    width      REAL NOT NULL,
    height     REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (map_key, node_id)
  );

  -- ---- Voice profiles (cross-video speaker identity) ----
  --
  -- Each row = one named voice (e.g. "Joe Rogan"). Stays stable across
  -- the entire archive; per-video local labels (S0, S1, ...) get mapped
  -- to these via video_speaker_assignments below.
  CREATE TABLE IF NOT EXISTS speakers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    display_color TEXT,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Aggregated voice fingerprint per speaker. Updated incrementally each
  -- time the user labels a new video-local centroid as this speaker —
  -- count-weighted moving average so the centroid converges as more
  -- samples come in.
  CREATE TABLE IF NOT EXISTS speaker_embeddings (
    speaker_id   TEXT PRIMARY KEY,
    embedding    BLOB NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 1,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (speaker_id) REFERENCES speakers(id) ON DELETE CASCADE
  );

  -- For each (video, local_speaker) pair, the per-video centroid embedding
  -- + reference to a global speaker (if matched/labeled). speaker_id NULL
  -- means "unidentified — needs labeling." sample_start/end point to the
  -- longest turn for this local speaker in this video, used for the
  -- "play sample" UX.
  CREATE TABLE IF NOT EXISTS video_speaker_assignments (
    video_id        TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    local_speaker   TEXT NOT NULL,
    speaker_id      TEXT,
    centroid        BLOB NOT NULL,
    confidence      REAL,
    sample_start    REAL,
    sample_end      REAL,
    airtime_seconds REAL NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, channel_id, local_speaker),
    FOREIGN KEY (speaker_id) REFERENCES speakers(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_vsa_speaker_id ON video_speaker_assignments(speaker_id);
  CREATE INDEX IF NOT EXISTS idx_vsa_video ON video_speaker_assignments(video_id, channel_id);
`;

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
  created_at: string;
  updated_at: string;
}

export interface StoredChannel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** Run speaker diarization for files from this channel. Off when content
   *  is known to be single-speaker (saves the diarization wall-time cost).
   *  Optional in writes (undefined = default to true); always populated in
   *  reads. */
  diarize?: boolean;
}

export function getDb(dbPath?: string): Database.Database {
  if (!db) {
    const resolvedPath = dbPath ? path.resolve(dbPath) : defaultDbPath();
    if (!dbPath) migrateLegacyDbIfPresent(resolvedPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    // Load sqlite-vec extension (vector search). Must happen BEFORE we
    // create the vec_segments virtual table or run any migration that
    // touches it. The npm package ships prebuilt loadable libs for
    // darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / windows-x64.
    sqliteVec.load(db);

    db.exec(SCHEMA);

    // The vec0 virtual table for embeddings. Auxiliary columns (`+`)
    // are stored alongside the vector and queryable in WHERE clauses
    // without leaving the index. vec0 in 0.1.x supports TEXT / INTEGER /
    // FLOAT / DOUBLE / BLOB only — REAL throws a misleading "chunk_size"
    // error, so seconds use FLOAT. Distance is L2 by default; we
    // normalize vectors at insert/query time so L2 ranks identically
    // to cosine, then convert distance back to similarity for display.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_segments USING vec0(
        embedding float[${EMBEDDING_DIM}],
        +video_id TEXT,
        +channel_id TEXT,
        +segment_index INTEGER,
        +model TEXT,
        +text TEXT,
        +start_seconds FLOAT,
        +end_seconds FLOAT,
        +speaker TEXT
      )
    `);

    runMigrations(db);
    console.log(`[db] SQLite ready: ${resolvedPath} (sqlite-vec loaded, dim=${EMBEDDING_DIM})`);
  }
  return db;
}

/**
 * Idempotent column adds for existing databases. SQLite has no
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we read pragma_table_info
 * and skip columns that already exist.
 */
function runMigrations(database: Database.Database) {
  const ensureColumn = (table: string, column: string, definition: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some(c => c.name === column)) {
      database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  };
  ensureColumn("video_queue", "notes", "TEXT");
  ensureColumn("video_queue", "ai_summary", "TEXT");
  ensureColumn("video_queue", "ai_summary_model", "TEXT");
  ensureColumn("channels", "diarize", "INTEGER NOT NULL DEFAULT 1");

  // Renamed link kind: same_scripture → same_topic. Migrate any existing rows.
  database
    .prepare("UPDATE clip_links SET kind = 'same_topic' WHERE kind = 'same_scripture'")
    .run();

  // Add `speaker` column to transcript_segments_fts. FTS5 has no
  // ALTER TABLE — the only path is DROP + CREATE. Existing transcripts on
  // disk get re-indexed automatically on the next refreshTranscriptSearchIndex
  // call (the index is fully derivable from the .json/.md files).
  const ftsCols = database.prepare(`PRAGMA table_info(transcript_segments_fts)`).all() as { name: string }[];
  if (ftsCols.length > 0 && !ftsCols.some(c => c.name === "speaker")) {
    database.exec("DROP TABLE transcript_segments_fts");
    database.exec(`
      CREATE VIRTUAL TABLE transcript_segments_fts USING fts5(
        video_id UNINDEXED,
        channel_id UNINDEXED,
        segment_index UNINDEXED,
        start_seconds UNINDEXED,
        end_seconds UNINDEXED,
        speaker UNINDEXED,
        text,
        tokenize = 'unicode61'
      )
    `);
    // transcript_index uses md_mtime to skip "already indexed" files. Wipe it
    // so the next refresh re-indexes everything into the new FTS schema.
    database.exec("DELETE FROM transcript_index");
    console.log("[db] Migrated transcript_segments_fts to add speaker column (re-index on next search)");
  }

  // Migrate from the legacy `transcript_segment_embeddings` SQL table to
  // the new `vec_segments` vec0 virtual table (sqlite-vec). Pure-JS cosine
  // doesn't scale past ~50K segments; vec0 is built for this. One-shot
  // copy + drop, idempotent (the source table won't exist after the first
  // run). Skips rows whose embedding dim doesn't match EMBEDDING_DIM —
  // those would fail at insert anyway and would just bloat the new table.
  const oldExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_segment_embeddings'",
  ).get();
  if (oldExists) {
    type LegacyRow = {
      video_id: string;
      channel_id: string;
      segment_index: number;
      model: string;
      embedding: Buffer;
      text: string;
      start_seconds: number;
      end_seconds: number;
      speaker: string | null;
    };
    const rows = database.prepare(`
      SELECT video_id, channel_id, segment_index, model, embedding, text,
             start_seconds, end_seconds, speaker
      FROM transcript_segment_embeddings
    `).all() as LegacyRow[];

    let migrated = 0;
    let skippedDim = 0;
    if (rows.length > 0) {
      const insert = database.prepare(`
        INSERT INTO vec_segments
          (embedding, video_id, channel_id, segment_index, model, text, start_seconds, end_seconds, speaker)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = database.transaction(() => {
        for (const row of rows) {
          const dim = row.embedding.byteLength / 4;
          if (dim !== EMBEDDING_DIM) {
            skippedDim++;
            continue;
          }
          // Normalize during migration — old embeddings predate the
          // unit-norm-at-insert convention. vec0 uses L2 distance, which
          // ranks identically to cosine only for unit-norm vectors.
          const oldVec = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
          );
          const normalized = normalizeVector(oldVec);
          insert.run(
            float32ToBuffer(normalized),
            row.video_id, row.channel_id,
            BigInt(row.segment_index), // INTEGER aux column — see note in replaceVideoEmbeddings
            row.model,
            row.text, row.start_seconds, row.end_seconds, row.speaker,
          );
          migrated++;
        }
      });
      tx();
    }

    database.exec("DROP TABLE transcript_segment_embeddings");
    console.log(
      `[db] Migrated ${migrated} embeddings → sqlite-vec vec_segments`
      + (skippedDim > 0 ? ` (skipped ${skippedDim} with mismatched dim — re-embed via AI page reindex)` : ""),
    );
  }
}

// ---- Pipeline config operations ----

export function getConfigValues(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM app_config").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

export function setConfigValues(values: Record<string, string | number | boolean | null>): void {
  const setValue = getDb().prepare(`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  const tx = getDb().transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      setValue.run(key, value === null ? "" : String(value));
    }
  });

  tx();
}

type ChannelRow = { id: string; name: string; url: string; enabled: number; diarize: number };

function rowToChannel(row: ChannelRow): StoredChannel {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: !!row.enabled,
    diarize: !!row.diarize,
  };
}

export function getChannels(): StoredChannel[] {
  const rows = getDb().prepare(
    "SELECT id, name, url, enabled, diarize FROM channels ORDER BY created_at ASC, name ASC"
  ).all() as ChannelRow[];

  return rows.map(rowToChannel);
}

export function replaceChannels(channels: StoredChannel[]): void {
  const clear = getDb().prepare("DELETE FROM channels");
  const insert = getDb().prepare(`
    INSERT INTO channels (id, name, url, enabled, diarize, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const tx = getDb().transaction(() => {
    clear.run();
    for (const channel of channels) {
      insert.run(
        channel.id, channel.name, channel.url,
        channel.enabled ? 1 : 0,
        channel.diarize === false ? 0 : 1,
      );
    }
  });

  tx();
}

export function upsertChannel(channel: StoredChannel): void {
  getDb().prepare(`
    INSERT INTO channels (id, name, url, enabled, diarize, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      url = excluded.url,
      enabled = excluded.enabled,
      diarize = excluded.diarize,
      updated_at = datetime('now')
  `).run(
    channel.id, channel.name, channel.url,
    channel.enabled ? 1 : 0,
    channel.diarize === false ? 0 : 1,
  );
}

export function deleteChannel(channelId: string): boolean {
  return getDb().prepare("DELETE FROM channels WHERE id = ?").run(channelId).changes > 0;
}

export function updateChannelEnabled(channelId: string, enabled: boolean): StoredChannel | undefined {
  const d = getDb();
  const result = d.prepare(
    "UPDATE channels SET enabled = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(enabled ? 1 : 0, channelId);
  if (result.changes === 0) return undefined;

  const row = d.prepare("SELECT id, name, url, enabled, diarize FROM channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

export function updateChannelDiarize(channelId: string, diarize: boolean): StoredChannel | undefined {
  const d = getDb();
  const result = d.prepare(
    "UPDATE channels SET diarize = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(diarize ? 1 : 0, channelId);
  if (result.changes === 0) return undefined;

  const row = d.prepare("SELECT id, name, url, enabled, diarize FROM channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

export function getChannelById(channelId: string): StoredChannel | undefined {
  const row = getDb().prepare(
    "SELECT id, name, url, enabled, diarize FROM channels WHERE id = ?"
  ).get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

// ---- Queue operations ----

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

/** Update status of a queued video. */
export function updateQueueStatus(
  videoId: string,
  channelId: string,
  updates: {
    status?: string;
    videoPath?: string | null;
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

export interface QueueListFilters {
  limit?: number;
  offset?: number;
  status?: string;
  channelId?: string;
  type?: string;
  hasTranscript?: string;
  q?: string;
  sort?: string;
}

export interface QueueListResult {
  rows: QueueEntry[];
  total: number;
  counts: Record<string, number>;
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
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 100), 1), 250);
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

export interface TranscriptClip {
  id: string;
  video_id: string;
  channel_id: string;
  title: string;
  channel_name: string | null;
  upload_date: string | null;
  start_seconds: number;
  end_seconds: number;
  quote: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  video_path: string | null;
  md_path: string | null;
  word_count: number;
  is_live: number;
  duration: number | null;
  status: string;
  tags: string[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

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

// ---- Segment embeddings (semantic search via sqlite-vec) ----
//
// Storage: vec0 virtual table `vec_segments` (created in getDb).
// sqlite-vec handles indexing internally — no manual cache, no write
// counter. Queries use `WHERE embedding MATCH ? AND model = ? AND k = ?`
// for KNN search, with auxiliary columns (text, speaker, etc.) returned
// inline so we don't need a join back to a side table.

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
  // Dim sanity check — fail loudly before touching the DB.
  for (const row of rows) {
    if (row.embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding dim mismatch: model produced ${row.embedding.length}-dim vector, `
        + `vec_segments expects ${EMBEDDING_DIM}. Wipe + reindex required `
        + `(use the AI page Reindex button).`,
      );
    }
  }
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

/**
 * Tag normalization. Lowercase + trim, collapse internal whitespace, allow
 * dots for hierarchy (e.g. "religion.end-times.rapture"). Returns "" for
 * tags that aren't worth storing.
 */
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupe(strings: string[]): string[] {
  return Array.from(new Set(strings));
}

export function setClipTags(clipId: string, rawTags: string[]): string[] {
  const tags = dedupe(rawTags.map(normalizeTag).filter(t => t.length > 0));
  const db = getDb();
  const apply = db.transaction((nextTags: string[]) => {
    db.prepare("DELETE FROM clip_tags WHERE clip_id = ?").run(clipId);
    if (!nextTags.length) return;
    const insert = db.prepare("INSERT INTO clip_tags (clip_id, tag) VALUES (?, ?)");
    for (const tag of nextTags) insert.run(clipId, tag);
  });
  apply(tags);
  return tags;
}

export function getClipTags(clipId: string): string[] {
  return (
    getDb()
      .prepare("SELECT tag FROM clip_tags WHERE clip_id = ? ORDER BY tag")
      .all(clipId) as { tag: string }[]
  ).map(row => row.tag);
}

function attachTagsToClips<T extends { id: string }>(clips: T[]): (T & { tags: string[] })[] {
  if (!clips.length) return [] as (T & { tags: string[] })[];
  const ids = clips.map(c => c.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT clip_id, tag FROM clip_tags WHERE clip_id IN (${placeholders}) ORDER BY tag`)
    .all(...ids) as { clip_id: string; tag: string }[];

  const byClip = new Map<string, string[]>();
  for (const row of rows) {
    const list = byClip.get(row.clip_id);
    if (list) list.push(row.tag);
    else byClip.set(row.clip_id, [row.tag]);
  }
  return clips.map(clip => ({ ...clip, tags: byClip.get(clip.id) ?? [] }));
}

export function listAllClipTags(): TagCount[] {
  return getDb()
    .prepare(`
      SELECT tag, COUNT(*) AS count
      FROM clip_tags
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `)
    .all() as TagCount[];
}

/**
 * Rename or merge a tag. If `includeDescendants` is true, "religion" → "faith"
 * also moves "religion.foo" → "faith.foo". Returns counts so the UI can
 * report "renamed N, merged into existing M".
 */
export function renameClipTag(
  from: string,
  to: string,
  includeDescendants = false,
): { renamed: number; merged: number } {
  const fromN = normalizeTag(from);
  const toN = normalizeTag(to);
  if (!fromN || !toN || fromN === toN) return { renamed: 0, merged: 0 };

  const db = getDb();
  return db.transaction(() => {
    const sourceRows = (
      includeDescendants
        ? db
            .prepare("SELECT clip_id, tag FROM clip_tags WHERE tag = ? OR tag LIKE ? || '.%'")
            .all(fromN, fromN)
        : db.prepare("SELECT clip_id, tag FROM clip_tags WHERE tag = ?").all(fromN)
    ) as { clip_id: string; tag: string }[];

    const insertOrIgnore = db.prepare("INSERT OR IGNORE INTO clip_tags (clip_id, tag) VALUES (?, ?)");
    const deleteRow = db.prepare("DELETE FROM clip_tags WHERE clip_id = ? AND tag = ?");

    let renamed = 0;
    let merged = 0;
    for (const row of sourceRows) {
      const nextTag =
        includeDescendants && row.tag !== fromN
          ? toN + row.tag.slice(fromN.length)
          : toN;
      const result = insertOrIgnore.run(row.clip_id, nextTag);
      if (result.changes > 0) renamed += 1;
      else merged += 1;
      deleteRow.run(row.clip_id, row.tag);
    }
    return { renamed, merged };
  })();
}

/** Remove a tag globally. Optionally also removes hierarchical descendants. */
export function deleteClipTag(tag: string, includeDescendants = false): number {
  const tagN = normalizeTag(tag);
  if (!tagN) return 0;
  if (includeDescendants) {
    return getDb()
      .prepare("DELETE FROM clip_tags WHERE tag = ? OR tag LIKE ? || '.%'")
      .run(tagN, tagN).changes;
  }
  return getDb().prepare("DELETE FROM clip_tags WHERE tag = ?").run(tagN).changes;
}

export function createTranscriptClip(clip: {
  id: string;
  videoId: string;
  channelId: string;
  title: string;
  channelName?: string | null;
  uploadDate?: string | null;
  startSeconds: number;
  endSeconds: number;
  quote: string;
  note?: string | null;
  tags?: string[];
}): TranscriptClip {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO transcript_clips (
        id, video_id, channel_id, title, channel_name, upload_date,
        start_seconds, end_seconds, quote, note, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      clip.id,
      clip.videoId,
      clip.channelId,
      clip.title,
      clip.channelName ?? null,
      clip.uploadDate ?? null,
      clip.startSeconds,
      clip.endSeconds,
      clip.quote,
      clip.note?.trim() || null,
    );
    if (clip.tags?.length) setClipTags(clip.id, clip.tags);
  })();

  const created = getTranscriptClip(clip.id);
  if (!created) throw new Error("Clip was not created");
  return created;
}

export function getTranscriptClip(id: string): TranscriptClip | undefined {
  const row = getDb().prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
    WHERE clip.id = ?
  `).get(id) as Omit<TranscriptClip, "tags"> | undefined;
  if (!row) return undefined;
  return { ...row, tags: getClipTags(id) };
}

/**
 * Filter clips. `tags` is an intersect filter — every listed tag must match
 * the clip, where matching is hierarchical: "religion" matches clips tagged
 * "religion" OR "religion.<anything>".
 */
export function listTranscriptClips(filters: {
  q?: string;
  channelId?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
} = {}): { rows: TranscriptClip[]; total: number } {
  const where: string[] = [];
  const params: any[] = [];

  if (filters.channelId && filters.channelId !== "all") {
    where.push("clip.channel_id = ?");
    params.push(filters.channelId);
  }
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim()}%`;
    where.push(`(
      clip.title LIKE ?
      OR COALESCE(clip.channel_name, '') LIKE ?
      OR clip.quote LIKE ?
      OR COALESCE(clip.note, '') LIKE ?
      OR clip.upload_date LIKE ?
    )`);
    params.push(like, like, like, like, like);
  }

  const tagFilter = (filters.tags ?? [])
    .map(normalizeTag)
    .filter(t => t.length > 0);
  for (const tag of tagFilter) {
    where.push(`clip.id IN (
      SELECT clip_id FROM clip_tags WHERE tag = ? OR tag LIKE ? || '.%'
    )`);
    params.push(tag, tag);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 100), 1), 250);
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  const fromSql = `
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
  `;
  const totalRow = getDb()
    .prepare(`SELECT COUNT(*) as count ${fromSql} ${whereSql}`)
    .get(...params) as { count: number } | undefined;

  const rows = getDb().prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status
    ${fromSql}
    ${whereSql}
    ORDER BY clip.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Omit<TranscriptClip, "tags">[];

  return { rows: attachTagsToClips(rows), total: totalRow?.count ?? 0 };
}

/**
 * Related clips for a video: split into "byTags" (clips from OTHER videos
 * sharing ≥1 tag with clips of the source video, ranked by overlap) and
 * "sameVideo" (clips from this video, the legacy behavior). Both lists
 * include their tag arrays so the UI can show match chips.
 */
export function listRelatedTranscriptClips(
  videoId: string,
  channelId: string,
  excludeId?: string,
): { byTags: (TranscriptClip & { overlap: number })[]; sameVideo: TranscriptClip[] } {
  const db = getDb();

  const sameVideoParams: any[] = [videoId, channelId];
  let excludeSql = "";
  if (excludeId) {
    excludeSql = "AND clip.id != ?";
    sameVideoParams.push(excludeId);
  }
  const sameVideoRows = db.prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
    WHERE clip.video_id = ? AND clip.channel_id = ?
    ${excludeSql}
    ORDER BY clip.start_seconds ASC, clip.created_at DESC
    LIMIT 50
  `).all(...sameVideoParams) as Omit<TranscriptClip, "tags">[];
  const sameVideo = attachTagsToClips(sameVideoRows);

  const sourceTags = (db.prepare(`
    SELECT DISTINCT t.tag
    FROM clip_tags t
    JOIN transcript_clips c ON c.id = t.clip_id
    WHERE c.video_id = ? AND c.channel_id = ?
  `).all(videoId, channelId) as { tag: string }[]).map(r => r.tag);

  if (!sourceTags.length) {
    return { byTags: [], sameVideo };
  }

  const tagPlaceholders = sourceTags.map(() => "?").join(",");
  const byTagsRows = db.prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status,
      (
        SELECT COUNT(DISTINCT t.tag)
        FROM clip_tags t
        WHERE t.clip_id = clip.id AND t.tag IN (${tagPlaceholders})
      ) AS overlap
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
    WHERE NOT (clip.video_id = ? AND clip.channel_id = ?)
      AND EXISTS (
        SELECT 1 FROM clip_tags t
        WHERE t.clip_id = clip.id AND t.tag IN (${tagPlaceholders})
      )
    ORDER BY overlap DESC, clip.created_at DESC
    LIMIT 50
  `).all(...sourceTags, videoId, channelId, ...sourceTags) as (Omit<TranscriptClip, "tags"> & { overlap: number })[];

  return {
    byTags: attachTagsToClips(byTagsRows) as (TranscriptClip & { overlap: number })[],
    sameVideo,
  };
}

export function deleteTranscriptClip(id: string): boolean {
  return getDb().prepare("DELETE FROM transcript_clips WHERE id = ?").run(id).changes > 0;
}

// ---- Per-video notes ----

export function setVideoNotes(videoId: string, channelId: string, notes: string | null): void {
  const trimmed = notes?.trim() ? notes.trim() : null;
  getDb().prepare(`
    UPDATE video_queue
    SET notes = ?, updated_at = datetime('now')
    WHERE video_id = ? AND channel_id = ?
  `).run(trimmed, videoId, channelId);
}

// ---- Per-video AI summary (distinct from notes) ----

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

// ---- Clip links (manual, typed) ----

export const CLIP_LINK_KINDS = [
  "same_claim",
  "contradicts",
  "same_topic",
  "follow_up",
  "context",
] as const;

export type ClipLinkKind = (typeof CLIP_LINK_KINDS)[number];

const SYMMETRIC_LINK_KINDS = new Set<ClipLinkKind>(["same_claim", "contradicts", "same_topic"]);

export interface ClipLink {
  from_clip_id: string;
  to_clip_id: string;
  kind: ClipLinkKind;
  note: string | null;
  created_at: string;
}

export interface ClipLinkWithClip extends ClipLink {
  direction: "outgoing" | "incoming";
  other: TranscriptClip;
}

export function addClipLink(
  fromId: string,
  toId: string,
  kind: ClipLinkKind,
  note?: string | null,
): { inserted: number } {
  if (fromId === toId) throw new Error("A clip cannot link to itself");
  if (!CLIP_LINK_KINDS.includes(kind)) throw new Error(`Unknown link kind: ${kind}`);

  const cleanedNote = note?.trim() || null;
  const db = getDb();
  return db.transaction(() => {
    const main = db
      .prepare(`INSERT OR REPLACE INTO clip_links (from_clip_id, to_clip_id, kind, note) VALUES (?, ?, ?, ?)`)
      .run(fromId, toId, kind, cleanedNote);
    let inserted = main.changes;
    if (SYMMETRIC_LINK_KINDS.has(kind)) {
      const mirror = db
        .prepare(`INSERT OR REPLACE INTO clip_links (from_clip_id, to_clip_id, kind, note) VALUES (?, ?, ?, ?)`)
        .run(toId, fromId, kind, cleanedNote);
      inserted += mirror.changes;
    }
    return { inserted };
  })();
}

export function removeClipLink(fromId: string, toId: string, kind: ClipLinkKind): { removed: number } {
  const db = getDb();
  return db.transaction(() => {
    let removed = db
      .prepare("DELETE FROM clip_links WHERE from_clip_id = ? AND to_clip_id = ? AND kind = ?")
      .run(fromId, toId, kind).changes;
    if (SYMMETRIC_LINK_KINDS.has(kind)) {
      removed += db
        .prepare("DELETE FROM clip_links WHERE from_clip_id = ? AND to_clip_id = ? AND kind = ?")
        .run(toId, fromId, kind).changes;
    }
    return { removed };
  })();
}

/**
 * Returns links that involve the given clip, with the OTHER clip preloaded
 * (and its tags). Outgoing = `from_clip_id = clipId`. Incoming reverses the
 * pair. For symmetric kinds the `addClipLink` mirror means there's already
 * an outgoing row for the inverse, so the UI should only render outgoing
 * unless you explicitly want both — see `linkPanels` server-side helper.
 */
export function getClipLinks(clipId: string): ClipLinkWithClip[] {
  const db = getDb();
  const outgoing = db.prepare(`
    SELECT * FROM clip_links WHERE from_clip_id = ?
    ORDER BY kind, created_at DESC
  `).all(clipId) as ClipLink[];
  const incoming = db.prepare(`
    SELECT * FROM clip_links WHERE to_clip_id = ? AND from_clip_id != ?
    ORDER BY kind, created_at DESC
  `).all(clipId, clipId) as ClipLink[];

  const otherIds = new Set<string>();
  outgoing.forEach(l => otherIds.add(l.to_clip_id));
  incoming.forEach(l => otherIds.add(l.from_clip_id));

  if (otherIds.size === 0) return [];

  const ids = Array.from(otherIds);
  const placeholders = ids.map(() => "?").join(",");
  const otherClips = db.prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
    WHERE clip.id IN (${placeholders})
  `).all(...ids) as Omit<TranscriptClip, "tags">[];

  const withTags = attachTagsToClips(otherClips);
  const byId = new Map(withTags.map(c => [c.id, c]));

  const result: ClipLinkWithClip[] = [];
  for (const link of outgoing) {
    const other = byId.get(link.to_clip_id);
    if (other) result.push({ ...link, direction: "outgoing", other });
  }
  for (const link of incoming) {
    if (SYMMETRIC_LINK_KINDS.has(link.kind)) continue; // already counted via outgoing mirror
    const other = byId.get(link.from_clip_id);
    if (other) result.push({ ...link, direction: "incoming", other });
  }
  return result;
}

// ---- Clip graph (for /map) ----

export type GraphEdgeType = "manual" | "shared_tag" | "same_video";

export interface GraphNode {
  id: string;
  clipId: string;
  videoId: string;
  channelId: string;
  channelName: string | null;
  title: string;
  uploadDate: string | null;
  startSeconds: number;
  endSeconds: number;
  quote: string;
  note: string | null;
  tags: string[];
  videoPath: string | null;
  mdPath: string | null;
  status: string;
  isLive: number;
  duration: number | null;
  degree: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeType;
  label: string;
  weight: number;
  tags?: string[];
  manualKind?: ClipLinkKind;
  note?: string | null;
}

export interface ClipGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    tagCount: number;
    manualEdgeCount: number;
    sharedTagEdgeCount: number;
    sameVideoEdgeCount: number;
  };
}

export interface ClipMapLayoutNode {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const ALL_GRAPH_EDGE_TYPES: GraphEdgeType[] = ["manual", "shared_tag", "same_video"];

/** Tags whose membership exceeds this many candidate clips are skipped for
 *  shared-tag edges so dense tags don't produce O(N²) noise. */
const SHARED_TAG_DENSE_THRESHOLD = 20;
/** Hard cap on total shared-tag edges in a single response. */
const SHARED_TAG_MAX_EDGES = 1000;

/**
 * Layout-agnostic graph view of clips, tags, and links. Candidate clips are
 * the first `limit` clips matching the same filter set as the Clips page
 * (q, channelId, intersect tags with hierarchy). Edges are derived from:
 *
 *   - clip_links (manual, with kind label)
 *   - clip_tags  (shared-tag pairs, dense tags skipped, deduped by pair)
 *   - clip start_seconds within the same video (consecutive only)
 */
export function getClipGraph(filters: {
  q?: string;
  channelId?: string;
  tags?: string[];
  edgeTypes?: GraphEdgeType[];
  limit?: number;
} = {}): ClipGraph {
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 150), 1), 500);
  const requestedTypes = filters.edgeTypes && filters.edgeTypes.length
    ? filters.edgeTypes.filter((t): t is GraphEdgeType => ALL_GRAPH_EDGE_TYPES.includes(t))
    : ALL_GRAPH_EDGE_TYPES;
  const edgeTypes = new Set<GraphEdgeType>(requestedTypes);

  const { rows: clips } = listTranscriptClips({
    q: filters.q,
    channelId: filters.channelId,
    tags: filters.tags,
    limit,
    offset: 0,
  });

  if (!clips.length) {
    return {
      nodes: [],
      edges: [],
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        tagCount: 0,
        manualEdgeCount: 0,
        sharedTagEdgeCount: 0,
        sameVideoEdgeCount: 0,
      },
    };
  }

  const clipIds = clips.map(c => c.id);
  const placeholders = clipIds.map(() => "?").join(",");
  const db = getDb();
  const edges: GraphEdge[] = [];
  let manualEdgeCount = 0;
  let sharedTagEdgeCount = 0;
  let sameVideoEdgeCount = 0;

  // Manual edges from clip_links. Symmetric kinds were stored as mirrored
  // rows on insert, so we dedupe to one undirected edge per (pair, kind).
  // Asymmetric kinds (follow_up, context) keep their direction.
  if (edgeTypes.has("manual")) {
    const links = db.prepare(`
      SELECT * FROM clip_links
      WHERE from_clip_id IN (${placeholders})
        AND to_clip_id IN (${placeholders})
    `).all(...clipIds, ...clipIds) as ClipLink[];

    const seenSymmetric = new Set<string>();
    for (const link of links) {
      if (SYMMETRIC_LINK_KINDS.has(link.kind)) {
        const [a, b] = link.from_clip_id < link.to_clip_id
          ? [link.from_clip_id, link.to_clip_id]
          : [link.to_clip_id, link.from_clip_id];
        const key = `${a}|${b}|${link.kind}`;
        if (seenSymmetric.has(key)) continue;
        seenSymmetric.add(key);
        edges.push({
          id: `manual:${a}:${b}:${link.kind}`,
          source: a,
          target: b,
          kind: "manual",
          label: link.kind,
          weight: 1,
          manualKind: link.kind,
          note: link.note,
        });
      } else {
        edges.push({
          id: `manual:${link.from_clip_id}:${link.to_clip_id}:${link.kind}`,
          source: link.from_clip_id,
          target: link.to_clip_id,
          kind: "manual",
          label: link.kind,
          weight: 1,
          manualKind: link.kind,
          note: link.note,
        });
      }
      manualEdgeCount += 1;
    }
  }

  // Shared-tag edges. Group candidates by tag, generate undirected pairs,
  // skip tags that match too many candidates (dense → O(N²) explosion),
  // dedupe pairs across tags by accumulating tag set + weight.
  if (edgeTypes.has("shared_tag")) {
    const tagRows = db.prepare(`
      SELECT clip_id, tag FROM clip_tags WHERE clip_id IN (${placeholders})
    `).all(...clipIds) as { clip_id: string; tag: string }[];

    const clipsByTag = new Map<string, string[]>();
    for (const row of tagRows) {
      const list = clipsByTag.get(row.tag);
      if (list) list.push(row.clip_id);
      else clipsByTag.set(row.tag, [row.clip_id]);
    }

    const sharedByPair = new Map<string, { weight: number; tags: Set<string> }>();
    Array.from(clipsByTag.entries()).forEach(([tag, ids]) => {
      if (ids.length > SHARED_TAG_DENSE_THRESHOLD) return;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
          const key = `${a}|${b}`;
          const acc = sharedByPair.get(key);
          if (acc) {
            acc.weight += 1;
            acc.tags.add(tag);
          } else {
            sharedByPair.set(key, { weight: 1, tags: new Set([tag]) });
          }
        }
      }
    });

    const ranked = Array.from(sharedByPair.entries())
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, SHARED_TAG_MAX_EDGES);

    for (const [key, acc] of ranked) {
      const [source, target] = key.split("|");
      const tagList = Array.from(acc.tags).sort();
      const label = tagList.length === 1 ? tagList[0] : `${tagList.length} shared tags`;
      edges.push({
        id: `shared_tag:${source}:${target}`,
        source,
        target,
        kind: "shared_tag",
        label,
        weight: acc.weight,
        tags: tagList,
      });
      sharedTagEdgeCount += 1;
    }
  }

  // Same-video adjacency. Within each (channel_id, video_id) bucket of
  // candidate clips, sort by start time and connect consecutive pairs.
  if (edgeTypes.has("same_video")) {
    const byVideo = new Map<string, TranscriptClip[]>();
    for (const clip of clips) {
      const key = `${clip.channel_id}|${clip.video_id}`;
      const list = byVideo.get(key);
      if (list) list.push(clip);
      else byVideo.set(key, [clip]);
    }
    Array.from(byVideo.values()).forEach(list => {
      if (list.length < 2) return;
      list.sort((a, b) => a.start_seconds - b.start_seconds);
      for (let i = 0; i < list.length - 1; i += 1) {
        const a = list[i];
        const b = list[i + 1];
        edges.push({
          id: `same_video:${a.id}:${b.id}`,
          source: a.id,
          target: b.id,
          kind: "same_video",
          label: "same video",
          weight: 1,
        });
        sameVideoEdgeCount += 1;
      }
    });
  }

  const degreeByClip = new Map<string, number>();
  for (const edge of edges) {
    degreeByClip.set(edge.source, (degreeByClip.get(edge.source) ?? 0) + 1);
    degreeByClip.set(edge.target, (degreeByClip.get(edge.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = clips.map(c => ({
    id: c.id,
    clipId: c.id,
    videoId: c.video_id,
    channelId: c.channel_id,
    channelName: c.channel_name,
    title: c.title,
    uploadDate: c.upload_date,
    startSeconds: c.start_seconds,
    endSeconds: c.end_seconds,
    quote: c.quote,
    note: c.note,
    tags: c.tags,
    videoPath: c.video_path,
    mdPath: c.md_path,
    status: c.status,
    isLive: c.is_live,
    duration: c.duration,
    degree: degreeByClip.get(c.id) ?? 0,
  }));

  const tagSet = new Set<string>();
  for (const node of nodes) {
    for (const tag of node.tags) tagSet.add(tag);
  }

  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      tagCount: tagSet.size,
      manualEdgeCount,
      sharedTagEdgeCount,
      sameVideoEdgeCount,
    },
  };
}

export function getClipMapLayout(mapKey: string): ClipMapLayoutNode[] {
  const rows = getDb().prepare(`
    SELECT node_id, x, y, width, height
    FROM clip_map_layouts
    WHERE map_key = ?
  `).all(mapKey) as { node_id: string; x: number; y: number; width: number; height: number }[];

  return rows.map(row => ({
    nodeId: row.node_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
  }));
}

export function saveClipMapLayout(mapKey: string, nodes: ClipMapLayoutNode[]): { saved: number } {
  const cleaned = nodes.filter(node =>
    node.nodeId &&
    Number.isFinite(node.x) &&
    Number.isFinite(node.y) &&
    Number.isFinite(node.width) &&
    Number.isFinite(node.height),
  );

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO clip_map_layouts (map_key, node_id, x, y, width, height, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(map_key, node_id) DO UPDATE SET
      x = excluded.x,
      y = excluded.y,
      width = excluded.width,
      height = excluded.height,
      updated_at = datetime('now')
  `);

  db.transaction(() => {
    for (const node of cleaned) {
      upsert.run(mapKey, node.nodeId, node.x, node.y, node.width, node.height);
    }
  })();

  return { saved: cleaned.length };
}

function parseTranscriptSegments(mdPath: string): TranscriptSegment[] {
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

// ---- Voice profiles (cross-video speaker identity) ----

/** Cosine distance threshold for auto-matching a video's speaker centroid
 *  against an existing global speaker. Tighter than the within-video
 *  threshold (0.65) because cross-video false-merges are more confusing
 *  for the user than leaving an unidentified speaker for manual labeling.
 *  Matches that exceed this threshold leave speaker_id = NULL so the
 *  user can decide. */
export const SPEAKER_AUTOMATCH_THRESHOLD = 0.55;

export interface Speaker {
  id: string;
  name: string;
  display_color: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpeakerEmbedding {
  speaker_id: string;
  embedding: Float32Array;
  sample_count: number;
  updated_at: string;
}

export interface VideoSpeakerAssignment {
  video_id: string;
  channel_id: string;
  local_speaker: string;
  speaker_id: string | null;
  centroid: Float32Array;
  confidence: number | null;
  sample_start: number | null;
  sample_end: number | null;
  airtime_seconds: number;
}

function f32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToF32(buf: Buffer | Uint8Array): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 2.0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 2.0;
  return 1.0 - dot / denom;
}

export function getAllSpeakers(): Speaker[] {
  return getDb().prepare(`
    SELECT id, name, display_color, notes, created_at, updated_at
    FROM speakers ORDER BY name COLLATE NOCASE
  `).all() as Speaker[];
}

export function getSpeakerById(id: string): Speaker | undefined {
  return getDb().prepare(`
    SELECT id, name, display_color, notes, created_at, updated_at
    FROM speakers WHERE id = ?
  `).get(id) as Speaker | undefined;
}

export function createSpeaker(args: { id: string; name: string; displayColor?: string | null; notes?: string | null }): Speaker {
  const { id, name, displayColor = null, notes = null } = args;
  getDb().prepare(`
    INSERT INTO speakers (id, name, display_color, notes)
    VALUES (?, ?, ?, ?)
  `).run(id, name, displayColor, notes);
  return getSpeakerById(id)!;
}

export function updateSpeaker(id: string, fields: { name?: string; displayColor?: string | null; notes?: string | null }): Speaker | undefined {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
  if (fields.displayColor !== undefined) { sets.push("display_color = ?"); params.push(fields.displayColor); }
  if (fields.notes !== undefined) { sets.push("notes = ?"); params.push(fields.notes); }
  if (sets.length === 0) return getSpeakerById(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE speakers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getSpeakerById(id);
}

export function deleteSpeaker(id: string): boolean {
  // ON DELETE CASCADE on speaker_embeddings; ON DELETE SET NULL on
  // video_speaker_assignments.speaker_id (so the video-local assignments
  // become unidentified again instead of disappearing).
  const r = getDb().prepare("DELETE FROM speakers WHERE id = ?").run(id);
  return r.changes > 0;
}

export function getSpeakerEmbedding(speakerId: string): SpeakerEmbedding | undefined {
  const row = getDb().prepare(`
    SELECT speaker_id, embedding, sample_count, updated_at
    FROM speaker_embeddings WHERE speaker_id = ?
  `).get(speakerId) as { speaker_id: string; embedding: Buffer; sample_count: number; updated_at: string } | undefined;
  if (!row) return undefined;
  return { ...row, embedding: bufferToF32(row.embedding) };
}

export function getAllSpeakerEmbeddings(): SpeakerEmbedding[] {
  const rows = getDb().prepare(`
    SELECT speaker_id, embedding, sample_count, updated_at FROM speaker_embeddings
  `).all() as { speaker_id: string; embedding: Buffer; sample_count: number; updated_at: string }[];
  return rows.map(r => ({ ...r, embedding: bufferToF32(r.embedding) }));
}

/** Insert OR update the global centroid for a speaker. Caller decides
 *  whether to compute a fresh centroid (first label) or merge in a new
 *  sample (count-weighted average) — this just stores whatever it's given. */
export function setSpeakerEmbedding(speakerId: string, embedding: Float32Array, sampleCount: number): void {
  getDb().prepare(`
    INSERT INTO speaker_embeddings (speaker_id, embedding, sample_count, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(speaker_id) DO UPDATE SET
      embedding = excluded.embedding,
      sample_count = excluded.sample_count,
      updated_at = excluded.updated_at
  `).run(speakerId, f32ToBuffer(embedding), sampleCount);
}

/** Find the closest existing speaker by cosine distance to `embedding`.
 *  Returns null if no speaker exists OR closest is past the threshold.
 *  Threshold defaults to SPEAKER_AUTOMATCH_THRESHOLD; pass a tighter
 *  value for stricter manual matching. */
export function findClosestSpeaker(embedding: Float32Array, threshold = SPEAKER_AUTOMATCH_THRESHOLD): { speaker_id: string; distance: number } | null {
  const all = getAllSpeakerEmbeddings();
  if (all.length === 0) return null;
  let best: { speaker_id: string; distance: number } | null = null;
  for (const e of all) {
    const dist = cosineDistance(embedding, e.embedding);
    if (best === null || dist < best.distance) {
      best = { speaker_id: e.speaker_id, distance: dist };
    }
  }
  if (best && best.distance <= threshold) return best;
  return null;
}

/** Idempotent upsert. Used during transcription to record one video's
 *  per-local-speaker centroids + auto-match attempt. */
export function upsertVideoSpeakerAssignment(args: {
  videoId: string;
  channelId: string;
  localSpeaker: string;
  speakerId: string | null;
  centroid: Float32Array;
  confidence: number | null;
  sampleStart: number | null;
  sampleEnd: number | null;
  airtimeSeconds: number;
}): void {
  getDb().prepare(`
    INSERT INTO video_speaker_assignments
      (video_id, channel_id, local_speaker, speaker_id, centroid, confidence,
       sample_start, sample_end, airtime_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id, channel_id, local_speaker) DO UPDATE SET
      speaker_id = excluded.speaker_id,
      centroid = excluded.centroid,
      confidence = excluded.confidence,
      sample_start = excluded.sample_start,
      sample_end = excluded.sample_end,
      airtime_seconds = excluded.airtime_seconds,
      updated_at = excluded.updated_at
  `).run(
    args.videoId, args.channelId, args.localSpeaker, args.speakerId,
    f32ToBuffer(args.centroid), args.confidence,
    args.sampleStart, args.sampleEnd, args.airtimeSeconds,
  );
}

export function getVideoSpeakerAssignments(videoId: string, channelId: string): VideoSpeakerAssignment[] {
  const rows = getDb().prepare(`
    SELECT video_id, channel_id, local_speaker, speaker_id, centroid, confidence,
           sample_start, sample_end, airtime_seconds
    FROM video_speaker_assignments
    WHERE video_id = ? AND channel_id = ?
    ORDER BY airtime_seconds DESC
  `).all(videoId, channelId) as Array<Omit<VideoSpeakerAssignment, "centroid"> & { centroid: Buffer }>;
  return rows.map(r => ({ ...r, centroid: bufferToF32(r.centroid) }));
}

export interface SpeakerWithStats extends Speaker {
  total_airtime_seconds: number;
  appearance_count: number;     // distinct videos
  has_embedding: number;        // 1 if speaker_embeddings row exists, else 0
}

/** Speakers list with rolled-up stats — the "Speakers" page main view. */
export function getSpeakersWithStats(): SpeakerWithStats[] {
  return getDb().prepare(`
    SELECT
      s.id, s.name, s.display_color, s.notes, s.created_at, s.updated_at,
      COALESCE(SUM(vsa.airtime_seconds), 0) AS total_airtime_seconds,
      COUNT(DISTINCT vsa.video_id || '|' || vsa.channel_id) AS appearance_count,
      CASE WHEN se.speaker_id IS NOT NULL THEN 1 ELSE 0 END AS has_embedding
    FROM speakers s
    LEFT JOIN video_speaker_assignments vsa ON vsa.speaker_id = s.id
    LEFT JOIN speaker_embeddings se ON se.speaker_id = s.id
    GROUP BY s.id
    ORDER BY total_airtime_seconds DESC, s.name COLLATE NOCASE
  `).all() as SpeakerWithStats[];
}

export interface UnidentifiedAssignment extends VideoSpeakerAssignment {
  video_title: string;
  video_url: string;
  video_path: string | null;
  channel_name: string | null;
  upload_date: string | null;
}

/** All video-local speakers without a global speaker mapping —
 *  the "needs labeling" list for the UI. Ordered by airtime so
 *  dominant unidentifieds get attention first. */
export function getUnidentifiedAssignments(limit = 200): UnidentifiedAssignment[] {
  const rows = getDb().prepare(`
    SELECT
      vsa.video_id, vsa.channel_id, vsa.local_speaker, vsa.speaker_id,
      vsa.centroid, vsa.confidence, vsa.sample_start, vsa.sample_end,
      vsa.airtime_seconds,
      q.title AS video_title, q.url AS video_url, q.video_path,
      c.name AS channel_name, q.upload_date
    FROM video_speaker_assignments vsa
    JOIN video_queue q ON q.video_id = vsa.video_id AND q.channel_id = vsa.channel_id
    LEFT JOIN channels c ON c.id = vsa.channel_id
    WHERE vsa.speaker_id IS NULL
    ORDER BY vsa.airtime_seconds DESC
    LIMIT ?
  `).all(limit) as Array<Omit<UnidentifiedAssignment, "centroid"> & { centroid: Buffer }>;
  return rows.map(r => ({ ...r, centroid: bufferToF32(r.centroid) }));
}

export interface SpeakerAppearance {
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string;
  url: string;
  video_path: string | null;
  upload_date: string | null;
  local_speaker: string;
  airtime_seconds: number;
  sample_start: number | null;
  sample_end: number | null;
}

/** All videos where a given speaker appears, with their local label
 *  and airtime in each. Used by the speaker-detail view. */
export function getSpeakerAppearances(speakerId: string): SpeakerAppearance[] {
  return getDb().prepare(`
    SELECT
      vsa.video_id, vsa.channel_id, c.name AS channel_name,
      q.title, q.url, q.video_path, q.upload_date,
      vsa.local_speaker, vsa.airtime_seconds,
      vsa.sample_start, vsa.sample_end
    FROM video_speaker_assignments vsa
    JOIN video_queue q ON q.video_id = vsa.video_id AND q.channel_id = vsa.channel_id
    LEFT JOIN channels c ON c.id = vsa.channel_id
    WHERE vsa.speaker_id = ?
    ORDER BY vsa.airtime_seconds DESC
  `).all(speakerId) as SpeakerAppearance[];
}

/** Per-video summary of which speakers appear, for the Library badges.
 *  Returns top speakers (those with global identity) ordered by airtime. */
export interface VideoSpeakerSummary {
  speaker_id: string;
  name: string;
  display_color: string | null;
  airtime_seconds: number;
  local_speaker: string;
}

export function getVideoSpeakerSummary(videoId: string, channelId: string): VideoSpeakerSummary[] {
  return getDb().prepare(`
    SELECT
      s.id AS speaker_id, s.name, s.display_color,
      vsa.airtime_seconds, vsa.local_speaker
    FROM video_speaker_assignments vsa
    JOIN speakers s ON s.id = vsa.speaker_id
    WHERE vsa.video_id = ? AND vsa.channel_id = ?
    ORDER BY vsa.airtime_seconds DESC
  `).all(videoId, channelId) as VideoSpeakerSummary[];
}

/** Manually link (or unlink) a video-local speaker to a global speaker.
 *  When linking, also folds this video's centroid into the speaker's
 *  global centroid as a count-weighted moving average — improves match
 *  quality for future videos. Pass speakerId = null to unlink. */
export function assignVideoSpeakerToGlobal(args: {
  videoId: string;
  channelId: string;
  localSpeaker: string;
  speakerId: string | null;
}): void {
  const d = getDb();
  d.prepare(`
    UPDATE video_speaker_assignments
    SET speaker_id = ?, confidence = NULL, updated_at = datetime('now')
    WHERE video_id = ? AND channel_id = ? AND local_speaker = ?
  `).run(args.speakerId, args.videoId, args.channelId, args.localSpeaker);

  // If linking to a real speaker, fold the video's centroid into the
  // speaker's global centroid (count-weighted moving average).
  if (args.speakerId === null) return;
  const va = d.prepare(`
    SELECT centroid FROM video_speaker_assignments
    WHERE video_id = ? AND channel_id = ? AND local_speaker = ?
  `).get(args.videoId, args.channelId, args.localSpeaker) as { centroid: Buffer } | undefined;
  if (!va) return;
  const newCentroid = bufferToF32(va.centroid);

  const existing = getSpeakerEmbedding(args.speakerId);
  if (!existing) {
    setSpeakerEmbedding(args.speakerId, newCentroid, 1);
    return;
  }
  // Weighted average + renormalize (centroids are stored normalized).
  const merged = new Float32Array(existing.embedding.length);
  const n = existing.sample_count;
  let normSq = 0;
  for (let i = 0; i < merged.length; i++) {
    merged[i] = (existing.embedding[i] * n + newCentroid[i]) / (n + 1);
    normSq += merged[i] * merged[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < merged.length; i++) merged[i] = merged[i] / norm;
  }
  setSpeakerEmbedding(args.speakerId, merged, n + 1);
}

export function closeDb(): void {
  if (db) { db.close(); db = null; console.log("[db] SQLite closed"); }
}
