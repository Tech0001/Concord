import { getDb } from "./db";

// ---------------------------------------------------------------
// Channels
//
// One row per monitored source — either a YouTube channel (url begins
// "https://www.youtube.com/...") or a local folder (url begins "file://").
// The pipeline.ts scanner branches on the url scheme; everything else
// treats them uniformly.
// ---------------------------------------------------------------

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
}

type ChannelRow = { id: string; name: string; url: string; enabled: number; diarize: number; include_shorts: number };

function rowToChannel(row: ChannelRow): StoredChannel {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: !!row.enabled,
    diarize: !!row.diarize,
    include_shorts: !!row.include_shorts,
  };
}

export function getChannels(): StoredChannel[] {
  const rows = getDb().prepare(
    "SELECT id, name, url, enabled, diarize, include_shorts FROM channels ORDER BY created_at ASC, name ASC"
  ).all() as ChannelRow[];

  return rows.map(rowToChannel);
}

export function replaceChannels(channels: StoredChannel[]): void {
  const clear = getDb().prepare("DELETE FROM channels");
  const insert = getDb().prepare(`
    INSERT INTO channels (id, name, url, enabled, diarize, include_shorts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const tx = getDb().transaction(() => {
    clear.run();
    for (const channel of channels) {
      insert.run(
        channel.id, channel.name, channel.url,
        channel.enabled ? 1 : 0,
        channel.diarize === false ? 0 : 1,
        channel.include_shorts ? 1 : 0,
      );
    }
  });

  tx();
}

export function upsertChannel(channel: StoredChannel): void {
  getDb().prepare(`
    INSERT INTO channels (id, name, url, enabled, diarize, include_shorts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      url = excluded.url,
      enabled = excluded.enabled,
      diarize = excluded.diarize,
      include_shorts = excluded.include_shorts,
      updated_at = datetime('now')
  `).run(
    channel.id, channel.name, channel.url,
    channel.enabled ? 1 : 0,
    channel.diarize === false ? 0 : 1,
    channel.include_shorts ? 1 : 0,
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

  const row = d.prepare("SELECT id, name, url, enabled, diarize, include_shorts FROM channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

export function updateChannelIncludeShorts(channelId: string, includeShorts: boolean): StoredChannel | undefined {
  const d = getDb();
  const result = d.prepare(
    "UPDATE channels SET include_shorts = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(includeShorts ? 1 : 0, channelId);
  if (result.changes === 0) return undefined;
  const row = d.prepare("SELECT id, name, url, enabled, diarize, include_shorts FROM channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

export function updateChannelDiarize(channelId: string, diarize: boolean): StoredChannel | undefined {
  const d = getDb();
  const result = d.prepare(
    "UPDATE channels SET diarize = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(diarize ? 1 : 0, channelId);
  if (result.changes === 0) return undefined;

  const row = d.prepare("SELECT id, name, url, enabled, diarize, include_shorts FROM channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

export function getChannelById(channelId: string): StoredChannel | undefined {
  const row = getDb().prepare(
    "SELECT id, name, url, enabled, diarize, include_shorts FROM channels WHERE id = ?"
  ).get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}
