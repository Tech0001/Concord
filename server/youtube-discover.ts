/**
 * YouTube Discover — saved-search watchers + manual search via the
 * YouTube Data API v3.
 *
 * Two consumers:
 *   - the /discover page: one-off search (`searchYouTube`)
 *   - the watcher poller: iterates each phrase variant, post-filters by
 *     title-contains + channel allow/block, dedupes, inserts into
 *     `youtube_inbox` (or video_queue when `auto_queue=1`).
 *
 * Quota math: search.list costs 100 units. The free tier is 10,000
 * units/day. Each variant in a watcher costs one call per poll.
 */

import { getConfigValues } from "./db";
import { getDb, enqueueVideo } from "./db";

export interface YouTubeSearchHit {
  videoId: string;
  channelId: string;
  channelName: string | null;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
}

export interface Watcher {
  id: number;
  label: string;
  phrase_variants: string[];
  allowed_channels: string[] | null;
  blocked_channels: string[] | null;
  enabled: boolean;
  auto_queue: boolean;
  poll_interval_hours: number;
  last_polled_at: string | null;
  last_error: string | null;
  /** Personal / work category — inherited by hits when they're
   *  promoted into video_queue (either via auto_queue or via the
   *  inbox "Queue" button). */
  category: "personal" | "work";
  created_at: string;
  updated_at: string;
}

export interface WatcherRow {
  id: number;
  label: string;
  phrase_variants: string;
  allowed_channels: string | null;
  blocked_channels: string | null;
  enabled: number;
  auto_queue: number;
  poll_interval_hours: number;
  last_polled_at: string | null;
  last_error: string | null;
  category: string;
  created_at: string;
  updated_at: string;
}

export interface InboxEntry {
  watcher_id: number;
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  found_at: string;
  status: "new" | "queued" | "dismissed";
}

function getApiKey(): string {
  const key = getConfigValues()["youtube.apiKey"];
  if (!key) throw new Error("YouTube API key not configured (Settings → YouTube Data API)");
  return key;
}

export type SearchOrder = "relevance" | "date" | "viewCount" | "rating" | "title";

export interface SearchPage {
  hits: YouTubeSearchHit[];
  nextPageToken: string | null;
  pagesScanned: number;
}

/** One raw search.list call. Pure pass-through — no post-filtering. */
async function searchYouTubeRaw(query: string, opts: {
  maxResults: number;
  order: SearchOrder;
  publishedAfter?: string;
  pageToken?: string | null;
}): Promise<{ hits: YouTubeSearchHit[]; nextPageToken: string | null }> {
  const apiKey = getApiKey();
  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(Math.min(Math.max(opts.maxResults, 1), 50)),
    order: opts.order,
    key: apiKey,
  });
  if (opts.publishedAfter) params.set("publishedAfter", opts.publishedAfter);
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`YouTube API search.list failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json() as {
    nextPageToken?: string;
    items?: Array<{
      id?: { videoId?: string };
      snippet?: {
        title?: string;
        description?: string;
        channelId?: string;
        channelTitle?: string;
        publishedAt?: string;
        thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
      };
    }>;
  };
  const hits: YouTubeSearchHit[] = (data.items ?? [])
    .filter(item => !!item.id?.videoId)
    .map(item => ({
      videoId: item.id!.videoId!,
      channelId: item.snippet?.channelId ?? "",
      channelName: item.snippet?.channelTitle ?? null,
      title: item.snippet?.title ?? "",
      description: item.snippet?.description ?? null,
      thumbnailUrl: item.snippet?.thumbnails?.medium?.url
        ?? item.snippet?.thumbnails?.default?.url
        ?? null,
      publishedAt: item.snippet?.publishedAt ?? null,
    }));
  return { hits, nextPageToken: data.nextPageToken ?? null };
}

/** Search YouTube and (optionally) auto-paginate through the API until
 *  we've collected `maxResults` hits whose title contains an include
 *  phrase (or `maxPages` is exhausted, whichever comes first). When no
 *  title filter is supplied, this is a single page fetch — same shape
 *  as before, just one of pagesScanned. */
export async function searchYouTube(query: string, opts?: {
  maxResults?: number;
  order?: SearchOrder;
  publishedAfter?: string;
  pageToken?: string | null;
  titleMustContain?: string[];
  titleMustNotContain?: string[];
  maxPages?: number;
}): Promise<SearchPage> {
  const maxResults = Math.min(Math.max(opts?.maxResults ?? 50, 1), 50);
  const order = opts?.order ?? "relevance";
  const includes = (opts?.titleMustContain ?? []).map(s => s.toLowerCase()).filter(Boolean);
  const excludes = (opts?.titleMustNotContain ?? []).map(s => s.toLowerCase()).filter(Boolean);
  const filtering = includes.length > 0 || excludes.length > 0;
  // Cap quota damage: each page costs 100 units. Default 5 pages = 500
  // units per Search click in filter mode. User can keep hitting "Load
  // more" to scan further.
  const maxPages = Math.min(Math.max(opts?.maxPages ?? 5, 1), 10);

  const accumulated: YouTubeSearchHit[] = [];
  let token: string | null = opts?.pageToken ?? null;
  let pagesScanned = 0;
  let lastNext: string | null = null;

  do {
    const page = await searchYouTubeRaw(query, {
      maxResults,
      order,
      publishedAfter: opts?.publishedAfter,
      pageToken: token,
    });
    pagesScanned += 1;
    lastNext = page.nextPageToken;

    const passing = filtering
      ? page.hits.filter(hit => {
          const title = hit.title.toLowerCase();
          if (excludes.length && excludes.some(p => title.includes(p))) return false;
          if (includes.length && !includes.some(p => title.includes(p))) return false;
          return true;
        })
      : page.hits;
    accumulated.push(...passing);

    token = page.nextPageToken;
    // Stop if (a) we have enough filtered hits, (b) we've used the
    // page budget, or (c) YouTube has no more pages.
    if (accumulated.length >= maxResults) break;
    if (pagesScanned >= maxPages) break;
    if (!token) break;
    if (!filtering) break; // unfiltered: one page is the contract
  } while (true);

  return {
    hits: accumulated.slice(0, maxResults),
    nextPageToken: lastNext,
    pagesScanned,
  };
}

// ---- Watcher CRUD ----

function rowToWatcher(r: WatcherRow): Watcher {
  return {
    id: r.id,
    label: r.label,
    phrase_variants: safeJsonArray(r.phrase_variants),
    allowed_channels: r.allowed_channels ? safeJsonArray(r.allowed_channels) : null,
    blocked_channels: r.blocked_channels ? safeJsonArray(r.blocked_channels) : null,
    enabled: r.enabled === 1,
    auto_queue: r.auto_queue === 1,
    poll_interval_hours: r.poll_interval_hours,
    last_polled_at: r.last_polled_at,
    last_error: r.last_error,
    category: r.category === "work" ? "work" : "personal",
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function listWatchers(opts?: { category?: "personal" | "work" }): Watcher[] {
  const where = opts?.category ? "WHERE category = ?" : "";
  const params = opts?.category ? [opts.category] : [];
  const rows = getDb()
    .prepare(`SELECT * FROM youtube_watchers ${where} ORDER BY created_at DESC`)
    .all(...params) as WatcherRow[];
  return rows.map(rowToWatcher);
}

export function getWatcher(id: number): Watcher | null {
  const row = getDb()
    .prepare("SELECT * FROM youtube_watchers WHERE id = ?")
    .get(id) as WatcherRow | undefined;
  return row ? rowToWatcher(row) : null;
}

export interface WatcherInput {
  label: string;
  phrase_variants: string[];
  allowed_channels?: string[] | null;
  blocked_channels?: string[] | null;
  enabled?: boolean;
  auto_queue?: boolean;
  poll_interval_hours?: number;
  category?: "personal" | "work";
}

function normCategory(value: unknown): "personal" | "work" {
  return value === "work" ? "work" : "personal";
}

export function createWatcher(input: WatcherInput): Watcher {
  if (!input.label?.trim()) throw new Error("label is required");
  const variants = (input.phrase_variants ?? []).map(s => s.trim()).filter(Boolean);
  if (!variants.length) throw new Error("at least one phrase variant is required");

  const info = getDb().prepare(`
    INSERT INTO youtube_watchers
      (label, phrase_variants, allowed_channels, blocked_channels,
       enabled, auto_queue, poll_interval_hours, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.label.trim(),
    JSON.stringify(variants),
    input.allowed_channels?.length ? JSON.stringify(input.allowed_channels) : null,
    input.blocked_channels?.length ? JSON.stringify(input.blocked_channels) : null,
    input.enabled === false ? 0 : 1,
    input.auto_queue ? 1 : 0,
    Math.max(1, input.poll_interval_hours ?? 24),
    normCategory(input.category),
  );
  return getWatcher(Number(info.lastInsertRowid))!;
}

export function updateWatcher(id: number, input: Partial<WatcherInput>): Watcher | null {
  const existing = getWatcher(id);
  if (!existing) return null;

  const next: WatcherInput = {
    label: input.label ?? existing.label,
    phrase_variants: input.phrase_variants ?? existing.phrase_variants,
    allowed_channels: input.allowed_channels !== undefined ? input.allowed_channels : existing.allowed_channels,
    blocked_channels: input.blocked_channels !== undefined ? input.blocked_channels : existing.blocked_channels,
    enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
    auto_queue: input.auto_queue !== undefined ? input.auto_queue : existing.auto_queue,
    poll_interval_hours: input.poll_interval_hours ?? existing.poll_interval_hours,
    category: input.category !== undefined ? input.category : existing.category,
  };

  getDb().prepare(`
    UPDATE youtube_watchers
       SET label = ?, phrase_variants = ?, allowed_channels = ?,
           blocked_channels = ?, enabled = ?, auto_queue = ?,
           poll_interval_hours = ?, category = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(
    next.label,
    JSON.stringify(next.phrase_variants),
    next.allowed_channels?.length ? JSON.stringify(next.allowed_channels) : null,
    next.blocked_channels?.length ? JSON.stringify(next.blocked_channels) : null,
    next.enabled === false ? 0 : 1,
    next.auto_queue ? 1 : 0,
    Math.max(1, next.poll_interval_hours ?? 24),
    normCategory(next.category),
    id,
  );
  return getWatcher(id);
}

export function deleteWatcher(id: number): boolean {
  const info = getDb().prepare("DELETE FROM youtube_watchers WHERE id = ?").run(id);
  return info.changes > 0;
}

// ---- Inbox ----

export function listInbox(opts?: {
  status?: "new" | "queued" | "dismissed";
  category?: "personal" | "work";
}): InboxEntry[] {
  const status = opts?.status ?? "new";
  // Inbox rows are owned by a watcher, so the category filter is a JOIN
  // on youtube_watchers — keeps the inbox in sync with watcher filtering
  // automatically when the user changes a watcher's category.
  const where: string[] = ["i.status = ?"];
  const params: any[] = [status];
  if (opts?.category) {
    where.push("w.category = ?");
    params.push(opts.category);
  }
  return getDb()
    .prepare(`
      SELECT i.*
      FROM youtube_inbox i
      JOIN youtube_watchers w ON w.id = i.watcher_id
      WHERE ${where.join(" AND ")}
      ORDER BY i.found_at DESC
    `)
    .all(...params) as InboxEntry[];
}

export function setInboxStatus(watcherId: number, videoId: string, status: "new" | "queued" | "dismissed"): boolean {
  const info = getDb()
    .prepare("UPDATE youtube_inbox SET status = ? WHERE watcher_id = ? AND video_id = ?")
    .run(status, watcherId, videoId);
  return info.changes > 0;
}

// ---- Polling ----

/** Run a single watcher: search each variant, post-filter, dedupe, and
 *  insert hits into the inbox (or video_queue when auto_queue=true).
 *  Updates last_polled_at + last_error on the watcher row. */
export async function pollWatcher(watcher: Watcher): Promise<{ inserted: number; queued: number }> {
  const db = getDb();
  const allowSet = watcher.allowed_channels?.length
    ? new Set(watcher.allowed_channels.map(s => s.toLowerCase()))
    : null;
  const blockSet = watcher.blocked_channels?.length
    ? new Set(watcher.blocked_channels.map(s => s.toLowerCase()))
    : null;

  const seen = new Map<string, YouTubeSearchHit>();
  let lastError: string | null = null;

  for (const variant of watcher.phrase_variants) {
    try {
      const page = await searchYouTube(variant, { order: "date", maxResults: 50 });
      const needle = variant.toLowerCase();
      for (const hit of page.hits) {
        // Strict title-contains so YouTube's fuzzy match doesn't sneak in
        // unrelated videos that only mention the name in description/tags.
        if (!hit.title.toLowerCase().includes(needle)) continue;
        // Channel allow/block applies to both channelId and channelName,
        // matched case-insensitively so users can write either form.
        const channelKeys = [hit.channelId.toLowerCase(), (hit.channelName ?? "").toLowerCase()].filter(Boolean);
        if (blockSet && channelKeys.some(k => blockSet.has(k))) continue;
        if (allowSet && !channelKeys.some(k => allowSet.has(k))) continue;
        if (!seen.has(hit.videoId)) seen.set(hit.videoId, hit);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  let inserted = 0;
  let queued = 0;
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO youtube_inbox
      (watcher_id, video_id, channel_id, channel_name, title, description,
       thumbnail_url, published_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const hit of Array.from(seen.values())) {
    const status = watcher.auto_queue ? "queued" : "new";
    const result = insertStmt.run(
      watcher.id,
      hit.videoId,
      hit.channelId,
      hit.channelName,
      hit.title,
      hit.description,
      hit.thumbnailUrl,
      hit.publishedAt,
      status,
    );
    if (result.changes > 0) {
      inserted += 1;
      if (watcher.auto_queue) {
        const enqueued = enqueueVideo({
          videoId: hit.videoId,
          channelId: hit.channelId,
          title: hit.title,
          url: `https://www.youtube.com/watch?v=${hit.videoId}`,
          uploadDate: hit.publishedAt?.slice(0, 10).replace(/-/g, "") ?? null,
          category: watcher.category,
          thumbnailUrl: hit.thumbnailUrl,
        });
        if (enqueued) queued += 1;
      }
    }
  }

  db.prepare(`
    UPDATE youtube_watchers
       SET last_polled_at = datetime('now'),
           last_error = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(lastError, watcher.id);

  return { inserted, queued };
}

/** Iterate all enabled watchers whose `last_polled_at` is older than
 *  `poll_interval_hours`. Background-runnable; logs but doesn't throw. */
export async function pollDueWatchers(): Promise<void> {
  const watchers = listWatchers().filter(w => w.enabled);
  for (const w of watchers) {
    if (w.last_polled_at) {
      const lastMs = Date.parse(w.last_polled_at.replace(" ", "T") + "Z");
      const dueMs = lastMs + w.poll_interval_hours * 3600 * 1000;
      if (Date.now() < dueMs) continue;
    }
    try {
      const out = await pollWatcher(w);
      console.log(`[youtube] watcher "${w.label}" → ${out.inserted} new (${out.queued} auto-queued)`);
    } catch (err) {
      console.error(`[youtube] watcher "${w.label}" failed:`, err);
    }
  }
}
