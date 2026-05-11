import { spawn } from "child_process";
import path from "path";
import fs from "fs";

/**
 * Fast extract: just demux the audio track from a video file without re-encoding.
 * Returns the path to the extracted audio file (typically m4a for YouTube videos).
 */
export function copyAudioTrack(
  videoPath: string,
  outputPath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", videoPath,
      "-vn",                      // No video
      "-acodec", "copy",           // Stream copy — no re-encode, nearly instant
      "-y", outputPath,
    ];

    console.log(`[audio] Demuxing audio: ffmpeg ${args.join(" ")}`);

    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        console.log(`[audio] Audio track copied: ${outputPath}`);
        resolve(outputPath);
      } else {
        reject(new Error(`Audio track copy failed (code ${code})`));
      }
    });

    proc.on("error", (err) => reject(new Error(`ffmpeg error: ${err.message}`)));
  });
}

export interface AudioExtractOptions {
  /** Sample rate in Hz (default: 16000 for whisper) */
  sampleRate?: number;
  /** Audio channels (default: 1 for mono) */
  channels?: number;
  /** Output format (default: wav) */
  format?: "wav" | "mp3" | "flac";
  /** Audio bitrate (default: not set, ffmpeg default) */
  bitrate?: string;
}

/**
 * Extract audio track from a video file using ffmpeg.
 * Uses ffmpeg's stream copy when possible for speed.
 */
export function extractAudio(
  videoPath: string,
  outputPath: string,
  options: AudioExtractOptions = {}
): Promise<void> {
  const {
    sampleRate = 16000,
    channels = 1,
    format = "wav",
    bitrate,
  } = options;

  return new Promise((resolve, reject) => {
    const args = [
      "-i", videoPath,            // Input file
      "-vn",                       // No video
      "-acodec", "pcm_s16le",      // PCM 16-bit little-endian (best for whisper)
      "-ar", String(sampleRate),   // Sample rate
      "-ac", String(channels),     // Channels
    ];

    // Add bitrate if specified (for mp3 output)
    if (bitrate && format !== "wav") {
      args.push("-b:a", bitrate);
    }

    args.push("-y", outputPath);   // Overwrite output

    console.log(`[audio] Extracting audio: ffmpeg ${args.join(" ")}`);

    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        // Verify output file was created
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          console.log(`[audio] Audio extracted successfully: ${outputPath}`);
          resolve();
        } else {
          reject(new Error("Audio extraction produced empty or missing file"));
        }
      } else {
        console.error(`[audio] ffmpeg stderr: ${stderr.slice(-500)}`);
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
  });
}

/**
 * Encode an AAC-in-MP4 playback sidecar. Used when the source's container
 * or codec isn't reliably decoded by Firefox/Safari (Ogg-Speex, Ogg-FLAC,
 * exotic FLAC variants, etc.). AAC-in-M4A is universally supported by every
 * browser. Sample rate / channels are preserved at "stereo 44.1k" — good
 * enough for voice + casual music, small file footprint.
 */
export function encodeAacSidecar(
  sourcePath: string,
  outputPath: string,
  bitrate = "128k",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", sourcePath,
      "-vn",
      "-acodec", "aac",
      "-b:a", bitrate,
      "-y", outputPath,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        console.log(`[audio] Encoded AAC sidecar: ${outputPath}`);
        resolve();
      } else {
        console.error(`[audio] AAC sidecar ffmpeg stderr: ${stderr.slice(-500)}`);
        reject(new Error(`AAC sidecar encode failed (code ${code})`));
      }
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg error: ${err.message}`)));
  });
}

/**
 * Get the duration of a media file in seconds using ffprobe.
 */
export function getMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ];

    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        const duration = parseFloat(stdout.trim());
        if (!isNaN(duration)) {
          resolve(duration);
        } else {
          reject(new Error(`Could not parse duration from: ${stdout}`));
        }
      } else {
        reject(new Error(`ffprobe exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start ffprobe: ${err.message}`));
    });
  });
}

export interface VideoStreamInfo {
  codec: string | null;       // e.g. "av1", "vp9", "h264"
  codecLong: string | null;   // friendlier name from ffprobe
  width: number | null;
  height: number | null;
  fps: number | null;
  container: string | null;   // file extension
  fileSizeMb: number | null;
}

/**
 * Probe a media file for its primary video stream codec, resolution, fps,
 * container, and on-disk size.
 */
export async function getVideoStreamInfo(filePath: string): Promise<VideoStreamInfo> {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? null;
  let fileSizeMb: number | null = null;
  try {
    const stat = (await import("fs")).statSync(filePath);
    fileSizeMb = Math.round((stat.size / (1024 * 1024)) * 10) / 10;
  } catch {}

  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,codec_long_name,width,height,r_frame_rate",
      "-of", "json",
      filePath,
    ];
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        // ffprobe failed: still return container + file size so the drawer
        // can show something useful.
        return resolve({ codec: null, codecLong: null, width: null, height: null, fps: null, container: ext, fileSizeMb });
      }
      try {
        const parsed = JSON.parse(stdout);
        const stream = (parsed.streams && parsed.streams[0]) || {};
        const fpsRaw = String(stream.r_frame_rate || "");
        let fps: number | null = null;
        if (fpsRaw.includes("/")) {
          const [num, den] = fpsRaw.split("/").map(Number);
          if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
            fps = Math.round((num / den) * 100) / 100;
          }
        } else if (fpsRaw) {
          const n = Number(fpsRaw);
          if (Number.isFinite(n)) fps = n;
        }
        resolve({
          codec: stream.codec_name || null,
          codecLong: stream.codec_long_name || null,
          width: stream.width ?? null,
          height: stream.height ?? null,
          fps,
          container: ext,
          fileSizeMb,
        });
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${(err as Error).message}`));
      }
    });
    proc.on("error", (err) => reject(new Error(`Failed to start ffprobe: ${err.message}`)));
  });
}
