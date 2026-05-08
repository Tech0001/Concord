import youtubedl from "youtube-dl-exec";
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
      console.error(`[monitor] Error fetching batch at offset ${offset}:`, error);
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
  try {
    const end = start + maxResults - 1;
    const results: ChannelVideo[] = [];
    const seen = new Set<string>();

    for (const scanUrl of normalizeChannelScanUrls(channelUrl)) {
      console.log(`[monitor] Fetching videos from channel: ${scanUrl} (${start}-${end})`);

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
    }

    return results.sort(compareNewestFirst);
  } catch (error) {
    console.error(`[monitor] Error fetching channel ${channelUrl}:`, error);
    throw error;
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
