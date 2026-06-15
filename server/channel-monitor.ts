import youtubedl from "./yt-dlp-bin";
import path from "path";
import fs from "fs";

export interface ChannelVideo {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  isLive: boolean;
  isShorts: boolean;
  uploadDate: string | null;
  thumbnail: string | null;
}

export interface ChannelConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** Run speaker diarization for this channel's transcripts. Default true. */
  diarize?: boolean;
  /** Include YouTube Shorts. Default false (most are mashups of full
   *  videos already in the channel — turn on for creators whose Shorts
   *  are genuine new content). */
  include_shorts?: boolean;
  /** Personal / work category — drives the header viewing toggle and is
   *  inherited by all videos this channel ingests. */
  category?: "personal" | "work";
}

/**
 * Fetch recent videos from a YouTube channel (for monitoring mode).
 * Gets the latest N videos.
 */
export async function getChannelVideos(
  channelUrl: string,
  maxResults: number = 10
): Promise<ChannelVideo[]> {
  return fetchChannelVideos(channelUrl, 1, maxResults);
}

export async function getChannelVideosPage(
  channelUrl: string,
  start: number,
  maxResults: number
): Promise<ChannelVideo[]> {
  return fetchChannelVideos(channelUrl, start, maxResults);
}

/**
 * Fetch ALL videos from a YouTube channel (for archive/catch-up mode).
 * Iterates through the entire uploads playlist, oldest first.
 * Passes progress updates via callback.
 */
export async function getAllChannelVideos(
  channelUrl: string,
  progressCallback?: (info: { fetched: number; total: number | null; currentTitle: string }) => void
): Promise<ChannelVideo[]> {
  const allVideos: ChannelVideo[] = [];
  const seen = new Set<string>();
  const scanUrls = normalizeChannelScanUrls(channelUrl);
  console.log(`[monitor] Fetching ALL videos from channel tabs: ${scanUrls.join(", ")}`);

  for (const scanUrl of scanUrls) {
    await fetchAllVideosFromTab(scanUrl, allVideos, seen, progressCallback);
  }

  // Return sorted oldest-first
  allVideos.sort((a, b) => {
    if (!a.uploadDate || !b.uploadDate) return 0;
    return a.uploadDate.localeCompare(b.uploadDate);
  });

  console.log(`[monitor] Total videos found: ${allVideos.length}`);
  return allVideos;
}

async function fetchAllVideosFromTab(
  scanUrl: string,
  allVideos: ChannelVideo[],
  seen: Set<string>,
  progressCallback?: (info: { fetched: number; total: number | null; currentTitle: string }) => void
): Promise<void> {
  let offset = 0;
  const batchSize = 50;
  
  while (true) {
    try {
      const result = await youtubedl(scanUrl, {
        dumpSingleJson: true,
        playlistStart: offset + 1,
        playlistEnd: offset + batchSize,
        noWarnings: true,
        cacheDir: "./youtube-dl-cache",
        ignoreErrors: true,
        skipDownload: true,
      }) as any;

      let entries: any[] = [];
      
      if (Array.isArray(result)) {
        entries = result;
      } else if (result?.entries && Array.isArray(result.entries)) {
        entries = result.entries;
      }

      if (!entries.length) break; // No more videos

      const parsed = parseVideoEntries(entries, entries.length);
      const unique = parsed.filter(v => {
        if (seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
      });
      allVideos.push(...unique);

      offset += entries.length;

      // Notify progress
      if (progressCallback) {
        // Try to get total count from playlist info
        const playlistTotal = result?._total_entries ?? result?.playlist_count ?? null;
        progressCallback({
          fetched: allVideos.length,
          total: playlistTotal,
          currentTitle: unique[unique.length - 1]?.title || parsed[parsed.length - 1]?.title || "",
        });
      }

      console.log(`[monitor] Fetched ${allVideos.length} videos so far...`);

      // Safety limit
      if (allVideos.length >= 5000) {
        console.log("[monitor] Reached 5000 video safety limit");
        break;
      }

    } catch (error) {
      // Soft failures we expect on many channels — most don't have ALL of
      // /videos, /streams, /shorts. yt-dlp emits "does not have a streams
      // tab" (or shorts/videos) when we ask for a tab the channel never
      // populated. Treat as "this tab is empty, move on" and continue
      // with the next scanUrl in the caller's loop.
      const msg = error instanceof Error ? error.message : String(error);
      const stderr = (error as any)?.stderr || "";
      const combined = `${msg}\n${stderr}`;
      const missingTab = /does not have a (streams|shorts|videos) tab/i.test(combined);
      if (missingTab) {
        const tabMatch = combined.match(/does not have a (streams|shorts|videos) tab/i);
        console.log(`[monitor] No ${tabMatch?.[1] || "tab"} on ${scanUrl} — skipping (this is normal)`);
      } else {
        console.error(`[monitor] Error fetching batch at offset ${offset}:`, error);
      }
      break;
    }
  }
}

/**
 * Internal helper: fetch a batch of videos from a channel.
 */
async function fetchChannelVideos(
  channelUrl: string,
  start: number,
  maxResults: number
): Promise<ChannelVideo[]> {
  const end = start + maxResults - 1;
  const results: ChannelVideo[] = [];
  const seen = new Set<string>();
  const errors: unknown[] = [];

  for (const scanUrl of normalizeChannelScanUrls(channelUrl)) {
    console.log(`[monitor] Fetching videos from channel: ${scanUrl} (${start}-${end})`);

    try {
      const result = await youtubedl(scanUrl, {
        dumpSingleJson: true,
        playlistStart: start,
        playlistEnd: end,
        noWarnings: true,
        cacheDir: "./youtube-dl-cache",
        ignoreErrors: true,
        skipDownload: true,
      });

      const entries = Array.isArray(result)
        ? result
        : ((result as any)?.entries && Array.isArray((result as any).entries) ? (result as any).entries : []);

      for (const video of parseVideoEntries(entries, maxResults)) {
        if (seen.has(video.id)) continue;
        seen.add(video.id);
        results.push(video);
      }
    } catch (error) {
      // yt-dlp returns a non-zero exit (which youtube-dl-exec rethrows as
      // ChildProcessError) when a tab doesn't exist on the channel, e.g.
      // `/streams` on a channel that has never gone live. That's expected,
      // not an error — just skip that URL and try the next one. Real
      // failures (network, auth, parse) still propagate via `errors[]`
      // below if every URL fails.
      if (isMissingTabError(error)) {
        console.log(`[monitor] ${scanUrl}: tab not present on this channel, skipping`);
        continue;
      }
      // yt-dlp with --ignore-errors keeps going past entries it can't
      // extract (e.g. a just-ended livestream in /streams: "This live
      // event has ended") but still exits non-zero, which
      // youtube-dl-exec rethrows — discarding the otherwise-valid
      // playlist JSON it already wrote to stdout. Salvage the good
      // entries so one unreadable item doesn't sink the whole tab (and
      // miss newly-ended-live VODs that only show in /streams).
      const salvaged = salvageEntriesFromError(error);
      if (salvaged.length > 0) {
        let added = 0;
        for (const video of parseVideoEntries(salvaged, maxResults)) {
          if (seen.has(video.id)) continue;
          seen.add(video.id);
          results.push(video);
          added++;
        }
        console.log(`[monitor] ${scanUrl}: recovered ${added} entries despite a yt-dlp item error (skipped unreadable items)`);
        continue;
      }
      console.error(`[monitor] Error fetching ${scanUrl}:`, error);
      errors.push(error);
    }
  }

  // Only escalate if every URL failed AND we have nothing to show for it.
  // A partial success (e.g. /videos worked, /streams threw a real error)
  // still returns whatever we got.
  if (results.length === 0 && errors.length > 0) {
    throw errors[0];
  }

  return results.sort(compareNewestFirst);
}

function isMissingTabError(error: unknown): boolean {
  const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
  const message = error instanceof Error ? error.message : String(error);
  return /does not have an? \w+ tab/i.test(stderr) || /does not have an? \w+ tab/i.test(message);
}

/** yt-dlp run with --ignore-errors still prints the full playlist JSON
 *  to stdout even when it exits non-zero because one entry failed to
 *  extract (e.g. an ended livestream). youtube-dl-exec attaches that
 *  stdout to the thrown error. Pull the still-valid entries out of it
 *  (dropping null/failed ones) so a single bad item doesn't cost us the
 *  whole scan. Returns [] when there's no usable JSON. */
function salvageEntriesFromError(error: unknown): any[] {
  const stdout = (error as { stdout?: unknown })?.stdout;
  if (typeof stdout !== "string" || !stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout);
    const entries = Array.isArray(parsed)
      ? parsed
      : (Array.isArray((parsed as any)?.entries) ? (parsed as any).entries : []);
    return entries.filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeChannelScanUrls(channelUrl: string): string[] {
  const trimmed = channelUrl.trim().replace(/\/+$/, "");

  if (/youtube\.com\/(@|channel\/|c\/|user\/)/i.test(trimmed)) {
    const base = trimmed.replace(/\/(videos|streams|shorts|featured|playlists|community|live)$/i, "");
    return [`${base}/videos`, `${base}/streams`];
  }

  return [trimmed];
}

function compareNewestFirst(a: ChannelVideo, b: ChannelVideo): number {
  if (a.uploadDate && b.uploadDate && a.uploadDate !== b.uploadDate) {
    return b.uploadDate.localeCompare(a.uploadDate);
  }
  return a.title.localeCompare(b.title);
}

/**
 * Parse raw yt-dlp entries into ChannelVideo objects.
 * Detects Shorts and live streams.
 */
function parseVideoEntries(entries: any[], maxResults: number): ChannelVideo[] {
  return entries
    .slice(0, maxResults)
    .map((entry: any) => {
      const title = entry.title || "Unknown Title";
      const duration = entry.duration ?? null;

      return {
        id: entry.id || entry.video_id || "",
        title,
        url: entry.url || entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
        duration,
        isLive: !!(
          entry.live_status === "is_live" ||
          entry.was_live === true ||
          entry.is_live === true
        ),
        isShorts: detectShorts(title, duration, entry),
        uploadDate: entry.upload_date || entry.release_date || null,
        thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url || null,
      };
    })
    .filter((v: ChannelVideo) => v.id); // Filter out entries without IDs
}

/**
 * Detect if a video is a YouTube Short.
 * Shorts are typically:
 * - Duration < 60 seconds
 * - OR title contains "#shorts" / "#short"
 * - OR URL contains "/shorts/"
 * - OR the format/description indicates vertical video
 */
function detectShorts(title: string, duration: number | null, entry: any): boolean {
  // Duration-based: YouTube Shorts are ≤60 seconds
  if (duration !== null && duration <= 60) {
    // Also check if it's labeled as a Short
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes("#shorts") || lowerTitle.includes("#short")) {
      return true;
    }
    // Very short videos that aren't explicitly marked may still be regular uploads
    // Only flag if also has Shorts indicator
    if (duration <= 60) {
      // Check the URL pattern
      const url = entry.url || entry.webpage_url || "";
      if (url.includes("/shorts/")) return true;
      if (entry.original_url?.includes("/shorts/")) return true;
    }
    return false;
  }

  // Title-based: #shorts hashtag regardless of duration
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes("#shorts") || lowerTitle.includes("#short")) {
    return true;
  }

  // URL-based
  const url = entry.url || entry.webpage_url || entry.original_url || "";
  if (url.includes("/shorts/")) return true;

  return false;
}

/**
 * Resolve a configured channel URL (e.g. `youtube.com/@handle`) to
 * its YouTube UC... id. yt-dlp will flat-extract one entry from the
 * channel and emit its channel_id, which is canonical and survives
 * handle / display-name changes.
 *
 * Returns null when:
 *   - The URL is local (file://) — local-folder channels have no UC id.
 *   - yt-dlp can't reach YouTube or the channel doesn't exist.
 *   - The entry is missing channel_id (unlikely on real channels).
 *
 * Used to backfill youtube_channel_id on configured channels so manual
 * downloads can attach to the right row via direct id equality
 * (otherwise we fall back to URL/handle/name heuristics that miss when
 * yt-dlp returns the /channel/UC... URL form against an @handle row).
 */
export async function resolveChannelUcId(channelUrl: string): Promise<string | null> {
  if (!channelUrl || channelUrl.startsWith("file://")) return null;
  try {
    // --playlist-items 1 grabs just the first video to keep this
    // cheap; --flat-playlist skips per-video metadata fetches.
    // The entry's channel_id is what we're after.
    const info = await youtubedl(channelUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistEnd: 1,
      noWarnings: true,
      cacheDir: "./youtube-dl-cache",
      skipDownload: true,
    }) as any;
    // For a channel URL, yt-dlp returns either:
    //   - a playlist-shaped object with `channel_id` on the root, OR
    //   - an entries[] where entries[0].channel_id is the id.
    const id = info?.channel_id
      || info?.uploader_id
      || info?.entries?.[0]?.channel_id
      || info?.entries?.[0]?.uploader_id
      || null;
    // YouTube UC ids are 24 chars starting with UC. Anything else
    // (a handle like @moneyotm, a /user/ legacy id) isn't what we
    // want — skip rather than poison the cache.
    if (typeof id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(id)) return id;
    return null;
  } catch (err) {
    console.warn(`[channel-monitor] resolveChannelUcId failed for ${channelUrl}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Check if a specific video is a live stream that's currently live.
 */
export async function isVideoCurrentlyLive(videoUrl: string): Promise<boolean> {
  try {
    const info = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      cacheDir: "./youtube-dl-cache",
      skipDownload: true,
    }) as any;

    return info?.live_status === "is_live" || info?.is_live === true;
  } catch (error) {
    console.error(`[monitor] Error checking live status for ${videoUrl}:`, error);
    return false;
  }
}
