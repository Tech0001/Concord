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
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`Starting download for video ${videoId} with format ${formatId} (audioLang: ${opts.audioLanguage || "any"})`);
    console.log(`Output path: ${outputPath}`);
    
    // Start downloading with progress tracking
    // Ensure temp directory exists
    try {
      if (!fs.existsSync(path.dirname(outputPath))) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      }
    } catch (error) {
      console.error("Error ensuring temp directory exists:", error);
    }

    const cookieOpts = youtubeCookieOpts();
    const sleep = youtubeSleep();

    // Build the audio selector. yt-dlp's selector grammar lets us
    // express "prefer audio in language X but fall back if none":
    //   bestaudio[language=en][ext=m4a] / bestaudio[language=en] / bestaudio[ext=m4a]
    // The double-slash chain tries each branch left-to-right until
    // one matches a real stream. Without the audioLanguage filter
    // yt-dlp picks whichever audio comes first — usually the
    // channel's original language, not the user's preference.
    const audioSelector = opts.audioLanguage
      ? `(bestaudio[language=${opts.audioLanguage}][ext=m4a]/bestaudio[language=${opts.audioLanguage}]/bestaudio[ext=m4a])`
      : "bestaudio[ext=m4a]";

    // youtube-dl-exec library call (NOT child_process.exec) — runs
    // yt-dlp with the format selector built above so the user's
    // preferred audio language wins on multi-track videos.
    const downloader = youtubedl.exec(url, {
      output: outputPath,
      format: `${formatId}+${audioSelector}/best`,
      // Merge video and audio streams into a single file
      mergeOutputFormat: "mp4",
      // Important: Force enabling the postprocessor for proper audio/video merging
      postprocessorArgs: "ffmpeg:-c:v copy -c:a aac -b:a 192k",
      // Cache to improve speed
      cacheDir: './youtube-dl-cache',
      // Avoid rate limiting errors
      limitRate: '2M',
      // Allow retries
      retries: 10,
      // Don't remove intermediate files on error to help debugging
      keepFragments: true,
      // Enable all postprocessors
      embedSubs: false,
      // Additional debugging
      verbose: true,
      // Use Node as the JS runtime so yt-dlp can decode YouTube's player
      // and see AV1/VP9 streams (otherwise falls back to H.264-only API).
      jsRuntimes: 'node',
      // Auth cookies — same priority as the metadata path above.
      ...cookieOpts,
      sleepInterval: sleep.min,
      maxSleepInterval: sleep.max,
    } as Parameters<typeof youtubedl>[1]);

    if (!downloader.stdout || !downloader.stderr) {
      throw new Error("Failed to create download process");
    }

    // youtube-dl-exec auto-rejects on non-zero exit. We track failure via
    // the "exit" event below; swallow this rejection to prevent an
    // unhandled-promise crash when YouTube returns a 5xx mid-download.
    Promise.resolve(downloader).catch(() => {});

    // Parse progress information from stdout
    downloader.stdout.on("data", (data: Buffer) => {
      const output = data.toString();
      console.log(`youtube-dl stdout: ${output}`);
      
      // Parse progress percentage
      const progressMatch = output.match(/(\d+\.\d+)%/);
      if (progressMatch && progressMatch[1]) {
        const percent = parseFloat(progressMatch[1]);
        console.log(`Download progress: ${percent}%`);
        
        // Parse downloaded bytes and total bytes if available
        const bytesMatch = output.match(/(\d+\.\d+)(\w+) of (\d+\.\d+)(\w+)/);
        let downloaded_bytes = 0;
        let total_bytes = 0;
        
        if (bytesMatch) {
          // Convert to bytes based on unit
          const units = { B: 1, KiB: 1024, MiB: 1024 * 1024, GiB: 1024 * 1024 * 1024 };
          const downloadValue = parseFloat(bytesMatch[1]);
          const downloadUnit = bytesMatch[2] as keyof typeof units;
          const totalValue = parseFloat(bytesMatch[3]);
          const totalUnit = bytesMatch[4] as keyof typeof units;
          
          downloaded_bytes = downloadValue * (units[downloadUnit] || 1);
          total_bytes = totalValue * (units[totalUnit] || 1);
          
          console.log(`Downloaded: ${downloaded_bytes} bytes of ${total_bytes} bytes`);
        }
        
        progressCallback({
          percent,
          downloaded_bytes,
          total_bytes
        });
      }
    });

    // Handle any errors
    downloader.stderr.on("data", (data: Buffer) => {
      console.error(`youtube-dl stderr: ${data.toString()}`);
    });

    // Log when the process ends
    downloader.on('close', (code) => {
      console.log(`youtube-dl process exited with code ${code}`);
      
      // Check if file exists using the imported fs
      try {
        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          console.log(`Download file exists at ${outputPath}, size: ${stats.size} bytes`);
        } else {
          console.error(`Download file doesn't exist at ${outputPath}`);
        }
      } catch (error) {
        console.error('Error checking file status:', error);
      }
    });

    // Wait for download to complete - this is just the initial download, not the ffmpeg processing
    console.log("Waiting for download to complete...");
    
    // Create a promise that will resolve when the download process is actually complete
    return new Promise<void>((resolve, reject) => {
      // Set up a handler for when the process exits
      downloader.on('close', (code) => {
        console.log(`youtube-dl process exited with code ${code}`);
        
        // Check if file exists
        try {
          if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            
            if (stats.size > 0) {
              console.log(`Download successful! File exists at ${outputPath}, size: ${stats.size} bytes`);
              
              // Set progress to 100% when done
              progressCallback({
                percent: 100,
                downloaded_bytes: stats.size,
                total_bytes: stats.size
              });
              
              console.log("Download completed successfully");
              resolve(); // Resolve the promise when everything is done
            } else {
              console.error(`Download file exists but is empty: ${outputPath}`);
              reject(new Error("Download file is empty"));
            }
          } else {
            console.error(`Download file does not exist: ${outputPath}`);
            reject(new Error("Download file not found"));
          }
        } catch (error) {
          console.error("Error checking file:", error);
          reject(error);
        }
      });
      
      // Handle errors during the download process
      downloader.on('error', (error) => {
        console.error("Download process error:", error);
        reject(error);
      });
      
      // Wait for the command to finish
      downloader.then((result) => {
        console.log("Download command finished");
        // We don't resolve here because we want to wait for the 'close' event
        // which happens after any post-processing (like ffmpeg)
      }).catch((error) => {
        console.error("Download command failed:", error);
        reject(error);
      });
    });
  } catch (error) {
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
