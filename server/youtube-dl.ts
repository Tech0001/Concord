import youtubedl from "./yt-dlp-bin";
import fs from "fs";
import path from "path";
import { getConfigValues } from "./db";
import { speedPresetToSleepInterval } from "./pipeline";

/** Read the user's "cookies from which browser?" pipeline setting and
 *  return it normalized — empty string when unset (= no cookie auth). */
function youtubeCookiesFromBrowser(): string {
  return (getConfigValues().youtubeCookiesFromBrowser || "").trim();
}

/** Path to a Netscape cookies.txt file. Takes precedence over the
 *  browser source when both are set. Empty string = unset. */
function youtubeCookiesFile(): string {
  return (getConfigValues().youtubeCookiesFile || "").trim();
}

/** Build the auth-cookie subset of yt-dlp options.
 *  Prefers --cookies <file> when configured; falls back to
 *  --cookies-from-browser; otherwise no cookies at all. */
function youtubeCookieOpts(): Record<string, string> {
  const file = youtubeCookiesFile();
  if (file) return { cookies: file };
  const browser = youtubeCookiesFromBrowser();
  if (browser) return { cookiesFromBrowser: browser };
  return {};
}

/** Read the user's speed preset (fast / balanced / conservative) and
 *  return the corresponding yt-dlp sleep-interval pair. */
function youtubeSleep(): { min: number; max: number } {
  const raw = getConfigValues().youtubeSpeedPreset;
  const preset = raw === "fast" || raw === "balanced" || raw === "conservative" ? raw : "conservative";
  return speedPresetToSleepInterval(preset);
}

interface YouTubeDlVideoInfo {
  id: string;
  title: string;
  thumbnail: string;
  duration: number;
  view_count: number;
  upload_date?: string;
  channel_id?: string;
  channel?: string;
  channel_url?: string;
  uploader?: string;
  uploader_id?: string;
  formats: YouTubeDlFormat[];
  format_id?: string;
}

interface YouTubeDlFormat {
  format_id: string;
  format: string;
  ext: string;
  resolution?: string;
  filesize?: number;
  filesize_approx?: number;
  quality?: string;
  // yt-dlp fills these for multi-language audio tracks and any
  // codec-aware UI surfacing. `language` is ISO 639-1 (e.g. "en",
  // "es", "ja"); `format_note` is yt-dlp's free-form label which
  // often spells out "English original", "Spanish (Latin America)",
  // etc. when language alone is ambiguous.
  language?: string | null;
  acodec?: string;
  vcodec?: string;
  format_note?: string;
}

interface ProgressCallback {
  (progress: { percent: number; downloaded_bytes: number; total_bytes: number }): void;
}

// yt-dlp emits this when a YouTube live stream has just ended but the
// post-broadcast VOD hasn't been processed yet. YouTube's web player has
// fallback logic for that transition window; the InnerTube API yt-dlp
// uses doesn't. Window is typically minutes-to-hours, longer for
// multi-hour streams. Sometimes a different player_client serves the
// VOD earlier — we retry once with web/android/mweb before giving up.
const LIVE_ENDED_PATTERN = /This live event has ended/i;
const isLiveEndedError = (err: unknown): boolean =>
  err instanceof Error && LIVE_ENDED_PATTERN.test(err.message);
const LIVE_ENDED_FRIENDLY =
  "YouTube hasn't processed this live stream's VOD yet. "
  + "The video is fine — try again in 10-30 minutes (longer for multi-hour streams). "
  + "This is a known yt-dlp transition window after a stream ends.";

/** Fallback clients for YouTube's GVS PO-token rollout. They currently
 *  expose a plain progressive stream when the default android_vr media URL
 *  is rejected with HTTP 403. This is intentionally a recovery path: the
 *  available result may be limited to 360p. */
const POT_FALLBACK_CLIENTS = "tv_simply,mweb";

type DownloadAttemptError = Error & { potBlocked?: boolean };

/** Remove only files belonging to this unique manual-download target. A
 *  failed multi-format yt-dlp run can leave `.part`, `.ytdl`, and `.f136`
 *  siblings that would otherwise make the fallback resume the bad URL. */
function cleanPartialDownloadFiles(outputPath: string): void {
  const dir = path.dirname(outputPath);
  const outputName = path.basename(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  if (!fs.existsSync(dir)) return;

  try {
    for (const file of fs.readdirSync(dir)) {
      const belongsToAttempt = file === outputName
        || file.startsWith(`${base}.f`)
        || (file.startsWith(`${base}.`) && (file.endsWith(".part") || file.endsWith(".ytdl")));
      if (!belongsToAttempt) continue;
      try {
        fs.unlinkSync(path.join(dir, file));
        console.log(`[download] Cleaned failed partial: ${file}`);
      } catch {}
    }
  } catch {}
}

export async function getYouTubeVideoInfo(url: string): Promise<YouTubeDlVideoInfo> {
  const cookieOpts = youtubeCookieOpts();
  const sleep = youtubeSleep();
  const baseOpts = {
    dumpSingleJson: true,
    noWarnings: true,
    // Using proper properties for youtube-dl-exec
    preferFreeFormats: true,
    // Adding cache dir to improve speed
    cacheDir: './youtube-dl-cache',
    // Without a JS runtime yt-dlp can't decode YouTube's player and falls
    // back to the android_vr API, which only exposes H.264. Pointing it
    // at the local node binary unlocks the full AV1/VP9 format list.
    jsRuntimes: 'node',
    // Auth cookies — defeats the "Sign in to confirm you're not a bot"
    // gate. Prefers cookies.txt file over browser extraction.
    ...cookieOpts,
    sleepInterval: sleep.min,
    maxSleepInterval: sleep.max,
  } as Parameters<typeof youtubedl>[1];

  try {
    const result = await youtubedl(url, baseOpts);
    return result as unknown as YouTubeDlVideoInfo;
  } catch (firstErr) {
    if (isLiveEndedError(firstErr)) {
      // Just-ended live: retry with alternative player clients before
      // surfacing a user-visible error.
      try {
        const retry = await youtubedl(url, {
          ...baseOpts,
          extractorArgs: "youtube:player_client=web,android,mweb",
        } as Parameters<typeof youtubedl>[1]);
        return retry as unknown as YouTubeDlVideoInfo;
      } catch (secondErr) {
        if (isLiveEndedError(secondErr)) {
          console.error("Live-ended VOD not yet available:", secondErr);
          throw new Error(LIVE_ENDED_FRIENDLY);
        }
        console.error("Error in youtube-dl (retry):", secondErr);
        throw new Error(`Failed to get video info: ${secondErr instanceof Error ? secondErr.message : "Unknown error"}`);
      }
    }
    console.error("Error in youtube-dl:", firstErr);
    throw new Error(`Failed to get video info: ${firstErr instanceof Error ? firstErr.message : "Unknown error"}`);
  }
}

export async function downloadYouTubeVideo(
  videoId: string,
  formatId: string,
  outputPath: string,
  progressCallback: ProgressCallback,
  opts: { audioLanguage?: string } = {},
): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  console.log(`Starting download for video ${videoId} with format ${formatId} (audioLang: ${opts.audioLanguage || "any"})`);
  console.log(`Output path: ${outputPath}`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const cookieOpts = youtubeCookieOpts();
  const sleep = youtubeSleep();

  // Prefer the configured language, then any matching audio, then m4a.
  const audioSelector = opts.audioLanguage
    ? `(bestaudio[language=${opts.audioLanguage}][ext=m4a]/bestaudio[language=${opts.audioLanguage}]/bestaudio[ext=m4a])`
    : "bestaudio[ext=m4a]";

  const runAttempt = (playerClient?: string): Promise<void> => new Promise((resolve, reject) => {
    let combinedOutput = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    const downloader = youtubedl.exec(url, {
      output: outputPath,
      format: `${formatId}+${audioSelector}/best`,
      mergeOutputFormat: "mp4",
      postprocessorArgs: "ffmpeg:-c:v copy -c:a aac -b:a 192k",
      cacheDir: "./youtube-dl-cache",
      limitRate: "2M",
      retries: 10,
      keepFragments: true,
      embedSubs: false,
      verbose: true,
      jsRuntimes: "node",
      ...(playerClient ? { extractorArgs: `youtube:player_client=${playerClient}` } : {}),
      ...cookieOpts,
      sleepInterval: sleep.min,
      maxSleepInterval: sleep.max,
    } as Parameters<typeof youtubedl>[1]);

    if (!downloader.stdout || !downloader.stderr) {
      finish(() => reject(new Error("Failed to create download process")));
      return;
    }

    // youtube-dl-exec rejects its Promise on a non-zero exit. The close
    // handler below owns completion because it has the captured stderr needed
    // to distinguish a PO-token 403 from other failures.
    Promise.resolve(downloader).catch(() => {});

    downloader.stdout.on("data", (data: Buffer) => {
      const output = data.toString();
      combinedOutput += output;
      console.log(`youtube-dl stdout: ${output}`);

      const progressMatch = output.match(/(\d+\.\d+)%/);
      if (!progressMatch?.[1]) return;
      const percent = parseFloat(progressMatch[1]);
      const bytesMatch = output.match(/(\d+\.\d+)(\w+) of (\d+\.\d+)(\w+)/);
      let downloadedBytes = 0;
      let totalBytes = 0;
      if (bytesMatch) {
        const units = { B: 1, KiB: 1024, MiB: 1024 * 1024, GiB: 1024 * 1024 * 1024 };
        downloadedBytes = parseFloat(bytesMatch[1]) * (units[bytesMatch[2] as keyof typeof units] || 1);
        totalBytes = parseFloat(bytesMatch[3]) * (units[bytesMatch[4] as keyof typeof units] || 1);
      }
      progressCallback({ percent, downloaded_bytes: downloadedBytes, total_bytes: totalBytes });
    });

    downloader.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      combinedOutput += output;
      console.error(`youtube-dl stderr: ${output}`);
    });

    downloader.once("error", (error) => {
      console.error("Download process error:", error);
      finish(() => reject(error));
    });

    downloader.once("close", (code) => {
      console.log(`youtube-dl process exited with code ${code}${playerClient ? ` (player_client=${playerClient})` : ""}`);
      try {
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          const size = fs.statSync(outputPath).size;
          progressCallback({ percent: 100, downloaded_bytes: size, total_bytes: size });
          console.log(`Download completed successfully: ${outputPath} (${size} bytes)`);
          finish(resolve);
          return;
        }
      } catch (error) {
        finish(() => reject(error));
        return;
      }

      const error = new Error(`Download failed (yt-dlp exit ${code})`) as DownloadAttemptError;
      error.potBlocked = !playerClient && /HTTP Error 403/.test(combinedOutput);
      finish(() => reject(error));
    });
  });

  try {
    await runAttempt();
  } catch (error) {
    if ((error as DownloadAttemptError).potBlocked === true) {
      cleanPartialDownloadFiles(outputPath);
      console.warn(
        `[download] ${videoId}: HTTP 403 on requested media — retrying with `
        + `player_client=${POT_FALLBACK_CLIENTS}. Quality may fall back to 360p.`,
      );
      try {
        await runAttempt(POT_FALLBACK_CLIENTS);
        return;
      } catch (fallbackError) {
        console.error("Fallback download failed:", fallbackError);
        throw new Error(`Failed to download video after PO-token fallback: ${fallbackError instanceof Error ? fallbackError.message : "Unknown error"}`);
      }
    }

    console.error("Error downloading video:", error);
    throw new Error(`Failed to download video: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

export function formatDuration(seconds?: number): string {
  if (!seconds) return "Unknown";
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  } else {
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
  }
}
