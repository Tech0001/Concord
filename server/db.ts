import Database from "better-sqlite3";
import path from "path";

let db: Database.Database | null = null;

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
  created_at: string;
  updated_at: string;
}

export interface StoredChannel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export function getDb(dbPath?: string): Database.Database {
  if (!db) {
    const resolvedPath = path.resolve(dbPath || "./pipeline.db");
    db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA);
    console.log(`[db] SQLite ready: ${resolvedPath}`);
  }
  return db;
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

export function getChannels(): StoredChannel[] {
  const rows = getDb().prepare(
    "SELECT id, name, url, enabled FROM channels ORDER BY created_at ASC, name ASC"
  ).all() as { id: string; name: string; url: string; enabled: number }[];

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: !!row.enabled,
  }));
}

export function replaceChannels(channels: StoredChannel[]): void {
  const clear = getDb().prepare("DELETE FROM channels");
  const insert = getDb().prepare(`
    INSERT INTO channels (id, name, url, enabled, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const tx = getDb().transaction(() => {
    clear.run();
    for (const channel of channels) {
      insert.run(channel.id, channel.name, channel.url, channel.enabled ? 1 : 0);
    }
  });

  tx();
}

export function upsertChannel(channel: StoredChannel): void {
  getDb().prepare(`
    INSERT INTO channels (id, name, url, enabled, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      url = excluded.url,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `).run(channel.id, channel.name, channel.url, channel.enabled ? 1 : 0);
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

  const row = d.prepare("SELECT id, name, url, enabled FROM channels WHERE id = ?").get(channelId) as
    | { id: string; name: string; url: string; enabled: number }
    | undefined;

  return row ? { ...row, enabled: !!row.enabled } : undefined;
}

// ---- Queue operations ----

export function getQueueEntryByVideoId(videoId: string): QueueEntry | undefined {
  return getDb().prepare(
    "SELECT * FROM video_queue WHERE video_id = ? ORDER BY updated_at DESC LIMIT 1"
  ).get(videoId) as QueueEntry | undefined;
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

export function closeDb(): void {
  if (db) { db.close(); db = null; console.log("[db] SQLite closed"); }
}
