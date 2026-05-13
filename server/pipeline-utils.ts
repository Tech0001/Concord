import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import type { ChannelVideo } from "./channel-monitor";
import type { SpeedPreset } from "./pipeline-types";

/** Pipeline errors that should NOT trigger a retry — these won't fix
 *  themselves between attempts and would just burn through the retry
 *  budget. Two families:
 *  - CUDA / driver issues (the GPU isn't going to come back online
 *    between retries 1 and 4).
 *  - Corrupt / unreadable source files (a missing moov atom or an
 *    "Invalid data" verdict from ffmpeg means the bytes themselves are
 *    bad — replaying the same input gets the same answer every time).
 */
export function isNonRetryableTranscriptionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    // CUDA / GPU driver
    lower.includes("no cuda-capable device is detected") ||
    lower.includes("can't initialize nvml") ||
    lower.includes("cuda driver") ||
    lower.includes("cuda failed") ||
    // Corrupt media / ffmpeg cannot decode
    lower.includes("moov atom not found") ||
    lower.includes("invalid data found when processing input") ||
    lower.includes("error opening input file") ||
    lower.includes("invalid argument") && lower.includes("ffmpeg")
  );
}

// ---- Local-folder channel helpers ----
//
// A channel whose `url` starts with `file://` is a local folder rather than a
// YouTube channel. Scanning walks the folder for media files; "downloading"
// is a no-op because the file's already on disk; everything else (audio
// extraction, transcription, FTS indexing, clips/tags/links) reuses the same
// pipeline as YouTube videos.

export const VIDEO_FILE_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]);
export const AUDIO_FILE_EXTS = new Set([".mp3", ".m4a", ".wav", ".flac", ".aac", ".opus", ".ogg"]);

export function isLocalChannel(channel: { url: string }): boolean {
  return typeof channel.url === "string" && channel.url.startsWith("file://");
}

export function isLocalVideoUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith("file://");
}

export function fileUrlToPath(fileUrl: string): string {
  // Node's fileURLToPath handles all the cross-platform pain: Windows drive
  // letters, percent-decoding, separator normalization. Falls back to a
  // crude strip for malformed inputs so we never throw.
  try {
    return fileURLToPath(fileUrl);
  } catch {
    return fileUrl.replace(/^file:\/\//, "");
  }
}

export function pathToFileUrl(absPath: string): string {
  return pathToFileURL(absPath).toString();
}

export function isMediaFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (!(VIDEO_FILE_EXTS.has(ext) || AUDIO_FILE_EXTS.has(ext))) return false;
  // Skip our own AAC playback sidecars (`<stem>.playback.m4a`). These live
  // next to source files and would otherwise re-ingest as a separate video
  // on every scan.
  const stem = path.basename(name, ext).toLowerCase();
  if (stem.endsWith(".playback")) return false;
  return true;
}

export function isAudioOnlyPath(filePath: string): boolean {
  return AUDIO_FILE_EXTS.has(path.extname(filePath).toLowerCase());
}

/** Stable per-file ID. SHA-256 of the absolute path, prefixed with "local-"
 *  so it's distinguishable from YouTube IDs at a glance. Same path always
 *  produces the same ID across rescans. */
export function localStableId(absPath: string): string {
  const hash = crypto.createHash("sha256").update(absPath).digest("hex");
  return `local-${hash.substring(0, 11)}`;
}

/** YouTube sometimes leaves `is_live: true` on the metadata of old
 *  streams (especially archived premieres). A video uploaded more than
 *  24 hours ago physically can't still be broadcasting, so the flag is
 *  stale and we should proceed with a normal download instead of parking
 *  the row in `waiting_live` forever. */
export function isLiveFlagStale(uploadDate: string | null): boolean {
  if (!uploadDate) return false;
  const m = uploadDate.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return false;
  const uploadMs = Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
  );
  return Date.now() - uploadMs > 24 * 60 * 60 * 1000;
}

export function mtimeToYYYYMMDD(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

/** Pick the earliest meaningful timestamp on a file. Prefers birthtime
 *  (filesystem creation) when present and sane, then mtime. Guards
 *  against the classic trap where some filesystems / network mounts
 *  return 0 for birthtime — that would otherwise map to 1970-01-01 and
 *  bucket every such file under the Unix epoch in the upload-date
 *  filters. The "sane" floor is the year 2000 — earlier than any
 *  realistic YouTube/local recording. */
const SANE_TIMESTAMP_FLOOR_MS = Date.UTC(2000, 0, 1);
export function pickFileDate(stat: fs.Stats): number {
  const m = Number(stat.mtimeMs) || 0;
  const b = Number(stat.birthtimeMs) || 0;
  const bSane = b > SANE_TIMESTAMP_FLOOR_MS;
  const mSane = m > SANE_TIMESTAMP_FLOOR_MS;
  if (bSane && mSane) return Math.min(b, m);
  if (bSane) return b;
  if (mSane) return m;
  // Both unreliable — fall back to mtime (even if pre-2000) rather than
  // synthesize a fake "now". A truly broken stat will format as e.g.
  // 19700101 and at least surfaces the problem to the user.
  return m;
}

/** Recursively walk a folder and return one ChannelVideo per media file
 *  found. Doesn't ffprobe (would be slow on big folders); duration is
 *  resolved later during processing. */
export function scanLocalFolder(folderUrl: string): ChannelVideo[] {
  const folder = fileUrlToPath(folderUrl);
  if (!fs.existsSync(folder)) {
    console.error(`[pipeline] Local channel folder not found: ${folder}`);
    return [];
  }

  const out: ChannelVideo[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`[pipeline] Cannot read directory ${dir}:`, err);
      return;
    }
    for (const entry of entries) {
      // Skip hidden / system files
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          out.push({
            id: localStableId(fullPath),
            title: path.basename(entry.name, path.extname(entry.name)),
            url: pathToFileUrl(fullPath),
            duration: null,
            isLive: false,
            isShorts: false,
            uploadDate: mtimeToYYYYMMDD(pickFileDate(stat)),
            thumbnail: null,
          });
        } catch (err) {
          console.error(`[pipeline] Stat failed for ${fullPath}:`, err);
        }
      }
    }
  };
  walk(folder);
  return out;
}

// ---- Config parsing ----

export function parseConfigNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseConfigBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

export function parseSpeedPreset(value: string | undefined, fallback: SpeedPreset): SpeedPreset {
  if (value === "fast" || value === "balanced" || value === "conservative") return value;
  return fallback;
}

/**
 * Map a politeness preset to yt-dlp's --sleep-interval (min sleep
 * between requests in seconds) and --max-sleep-interval (random ceiling).
 * Higher values = more polite to YouTube's rate-limiter = lower chance
 * of triggering bot-detection or temporary blocks. Conservative is the
 * "I don't want my IP banned" setting; Fast is "I have cookies and a
 * small queue and want it done now".
 */
export function speedPresetToSleepInterval(preset: SpeedPreset): { min: number; max: number } {
  switch (preset) {
    case "fast":         return { min: 1,  max: 3  };
    case "balanced":     return { min: 3,  max: 8  };
    case "conservative": return { min: 30, max: 90 };
  }
}
