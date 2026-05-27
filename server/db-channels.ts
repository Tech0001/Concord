import { getDb } from "./db";

// ---------------------------------------------------------------
// Channels
//
// One row per monitored source — either a YouTube channel (url begins
// "https://www.youtube.com/...") or a local folder (url begins "file://").
// The pipeline.ts scanner branches on the url scheme; everything else
// treats them uniformly.
// ---------------------------------------------------------------

/** Personal / work category. Drives the header viewing toggle so the
 *  user can keep work-research and personal-archive views separated.
 *  Stored on each channel + denormalized onto its videos so the queue
 *  filter never needs to JOIN. */
export type Category = "personal" | "work";
export const CATEGORIES: readonly Category[] = ["personal", "work"] as const;
export function normalizeCategory(value: unknown): Category {
  return value === "work" ? "work" : "personal";
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
  /** Include YouTube Shorts when scanning this channel. Off by default —
   *  most Shorts are mashups/clips of full videos already in the channel,
   *  so they duplicate content without adding signal. Toggle on per-channel
   *  for creators whose Shorts are genuine new content. */
  include_shorts?: boolean;
  /** Personal / work category. Defaults to 'personal' on writes. */
  category?: Category;
  /** YouTube UC... channel id — populated lazily from yt-dlp metadata.
   *  Lets manual downloads match against the configured channel
   *  reliably (URL-substring + name-match both have failure modes). */
  youtube_channel_id?: string | null;
}

type ChannelRow = { id: string; name: string; url: string; enabled: number; diarize: number; include_shorts: number; category: string; youtube_channel_id: string | null };

const CHANNEL_COLUMNS = "id, name, url, enabled, diarize, include_shorts, category, youtube_channel_id";

function rowToChannel(row: ChannelRow): StoredChannel {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: !!row.enabled,
    diarize: !!row.diarize,
    include_shorts: !!row.include_shorts,
    category: normalizeCategory(row.category),
    youtube_channel_id: row.youtube_channel_id,
  };
}

export function getChannels(filters?: { category?: Category }): StoredChannel[] {
  const where = filters?.category ? "WHERE category = ?" : "";
  const params = filters?.category ? [filters.category] : [];
  const rows = getDb().prepare(
    `SELECT ${CHANNEL_COLUMNS} FROM channels ${where} ORDER BY created_at ASC, name ASC`
  ).all(...params) as ChannelRow[];

  return rows.map(rowToChannel);
}

export function replaceChannels(channels: StoredChannel[]): void {
  const clear = getDb().prepare("DELETE FROM channels");
  const insert = getDb().prepare(`
    INSERT INTO channels (id, name, url, enabled, diarize, include_shorts, category, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const tx = getDb().transaction(() => {
    clear.run();
    for (const channel of channels) {
      insert.run(
        channel.id, channel.name, channel.url,
        channel.enabled ? 1 : 0,
        channel.diarize === false ? 0 : 1,
        channel.include_shorts ? 1 : 0,
        normalizeCategory(channel.category),
      );
    }
  });

  tx();
}

export function upsertChannel(channel: StoredChannel): void {
  getDb().prepare(`
    INSERT INTO channels (id, name, url, enabled, diarize, include_shorts, category, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      url = excluded.url,
      enabled = excluded.enabled,
      diarize = excluded.diarize,
      include_shorts = excluded.include_shorts,
      category = excluded.category,
      updated_at = datetime('now')
  `).run(
    channel.id, channel.name, channel.url,
    channel.enabled ? 1 : 0,
    channel.diarize === false ? 0 : 1,
    channel.include_shorts ? 1 : 0,
    normalizeCategory(channel.category),
  );
}

/** Move a channel between categories AND cascade the change down to
 *  all of its already-ingested videos in one transaction. Without the
 *  cascade, the channel filter would say "work" but the videos would
 *  still show under "personal" since the queue is denormalized. */
export function updateChannelCategory(channelId: string, category: Category): StoredChannel | undefined {
  const d = getDb();
  const cat = normalizeCategory(category);
  const result = d.transaction(() => {
    const r = d.prepare(
      "UPDATE channels SET category = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(cat, channelId);
    if (r.changes === 0) return null;
    d.prepare(
      "UPDATE video_queue SET category = ?, updated_at = datetime('now') WHERE channel_id = ?"
    ).run(cat, channelId);
    return d.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`).get(channelId) as ChannelRow | undefined;
  })();
  return result ? rowToChannel(result) : undefined;
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

  const row = d.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`).get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

export function updateChannelIncludeShorts(channelId: string, includeShorts: boolean): StoredChannel | undefined {
  const d = getDb();
  const result = d.prepare(
    "UPDATE channels SET include_shorts = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(includeShorts ? 1 : 0, channelId);
  if (result.changes === 0) return undefined;
  const row = d.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`).get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

export function updateChannelDiarize(channelId: string, diarize: boolean): StoredChannel | undefined {
  const d = getDb();
  const result = d.prepare(
    "UPDATE channels SET diarize = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(diarize ? 1 : 0, channelId);
  if (result.changes === 0) return undefined;

  const row = d.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`).get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

/** Find a configured channel that matches a YouTube channel's identifying
 *  info — used to attach manual downloads to their existing pipeline
 *  channel rather than creating an orphan row keyed by the display name.
 *
 *  Match order:
 *    1. URL contains the YouTube UC... id (most specific — survives renames).
 *    2. Case-insensitive name equality (covers channels added before
 *       yt-dlp started returning channel ids, or local-folder channels).
 *  Returns undefined when there's no match; the caller is responsible
 *  for the legacy "treat the display name as the channel id" fallback. */
/** Extract a YouTube channel handle (e.g. "@somehandle") from any
 *  URL shape that contains one. Lowercased for case-insensitive
 *  comparison. Returns null when the URL has no handle (the
 *  /channel/UC... form, /user/foo, bare domain). */
function extractHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/(@[A-Za-z0-9._-]+)/);
  return m ? m[1].toLowerCase() : null;
}

/** Strip common suffixes and lowercase a URL for fuzzy comparison.
 *  Handles trailing slashes, /videos, /streams, /featured — yt-dlp
 *  may emit "youtube.com/@handle" while the user typed
 *  "youtube.com/@handle/videos". */
function normalizeChannelUrl(url: string | null | undefined): string {
  if (!url) return "";
  return url
    .toLowerCase()
    .replace(/\/(videos|streams|featured|live|playlists|community|about)\/?$/i, "")
    .replace(/\/$/, "")
    .trim();
}

export function findChannelByYouTubeInfo(
  youtubeChannelId: string | null | undefined,
  youtubeChannelName: string | null | undefined,
  youtubeChannelUrl?: string | null | undefined,
): StoredChannel | undefined {
  const channels = getChannels();

  // Diagnostic — surfaces exactly which step fires (or why none did)
  // when manual downloads aren't attaching to the right configured
  // channel. Strip after the matcher is confirmed working.
  const dbg = (step: string, extra?: unknown) => {
    console.log(`[match-channel] ${step}`, extra ?? "");
  };
  dbg("input", {
    youtubeChannelId,
    youtubeChannelName,
    youtubeChannelUrl,
    knownChannels: channels.map(c => ({
      id: c.id,
      name: c.name,
      url: c.url,
      youtube_channel_id: c.youtube_channel_id,
      handle: extractHandle(c.url),
      norm: normalizeChannelUrl(c.url),
    })),
  });

  // 1. Stored UC id — most reliable once populated.
  if (youtubeChannelId) {
    const byStoredId = channels.find(c => c.youtube_channel_id === youtubeChannelId);
    if (byStoredId) { dbg("MATCH step1 stored UC id", byStoredId.id); return byStoredId; }
  }

  // 2. UC id appears in the configured URL — covers /channel/UC... URLs.
  if (youtubeChannelId) {
    const byUcInUrl = channels.find(c => c.url.includes(youtubeChannelId));
    if (byUcInUrl) {
      dbg("MATCH step2 UC-in-URL", byUcInUrl.id);
      cacheYouTubeChannelId(byUcInUrl.id, youtubeChannelId);
      return { ...byUcInUrl, youtube_channel_id: youtubeChannelId };
    }
  }

  // 3. Handle match — yt-dlp's channel_url and the user's typed URL
  //    both carry the same @handle for /@handle channels.
  const ytHandle = extractHandle(youtubeChannelUrl);
  if (ytHandle) {
    const byHandle = channels.find(c => extractHandle(c.url) === ytHandle);
    if (byHandle) {
      dbg("MATCH step3 @handle", { handle: ytHandle, channelId: byHandle.id });
      if (youtubeChannelId) cacheYouTubeChannelId(byHandle.id, youtubeChannelId);
      return byHandle;
    } else {
      dbg("step3 @handle MISS — yt handle did not match any configured channel handle", { ytHandle });
    }
  } else {
    dbg("step3 skipped — no @handle in yt channel_url", { youtubeChannelUrl });
  }

  // 4. Normalized URL equality.
  if (youtubeChannelUrl) {
    const normYt = normalizeChannelUrl(youtubeChannelUrl);
    if (normYt) {
      const byUrl = channels.find(c => normalizeChannelUrl(c.url) === normYt);
      if (byUrl) {
        dbg("MATCH step4 normalized URL", { normYt, channelId: byUrl.id });
        if (youtubeChannelId) cacheYouTubeChannelId(byUrl.id, youtubeChannelId);
        return byUrl;
      } else {
        dbg("step4 normalized-URL MISS", { normYt });
      }
    }
  }

  // 5. Case-insensitive name equality.
  if (youtubeChannelName) {
    const needle = youtubeChannelName.toLowerCase().trim();
    const byName = channels.find(c => c.name.toLowerCase().trim() === needle);
    if (byName) {
      dbg("MATCH step5 name", { needle, channelId: byName.id });
      if (youtubeChannelId) cacheYouTubeChannelId(byName.id, youtubeChannelId);
      return byName;
    } else {
      dbg("step5 name MISS", { needle });
    }
  }

  dbg("NO MATCH — will fall back to display-name as channel_id");
  return undefined;
}

/** Cache the YouTube UC id on a channel row. Idempotent — writes
 *  only when the column is empty or holds a different value.
 *  Called opportunistically from findChannelByYouTubeInfo whenever a
 *  match succeeds via URL or name, so future lookups can go straight
 *  through the cheap id-equality path. */
export function cacheYouTubeChannelId(channelRowId: string, youtubeChannelId: string): void {
  if (!youtubeChannelId) return;
  getDb()
    .prepare("UPDATE channels SET youtube_channel_id = ? WHERE id = ? AND (youtube_channel_id IS NULL OR youtube_channel_id <> ?)")
    .run(youtubeChannelId, channelRowId, youtubeChannelId);
}

export function getChannelById(channelId: string): StoredChannel | undefined {
  const row = getDb().prepare(
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`
  ).get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}
