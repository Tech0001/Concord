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
