import type { Express } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { ffmpegBin, ffprobeBin, getMediaDuration } from "./audio";

/**
 * Standalone media utilities that operate on arbitrary server paths —
 * currently just the Extract Audio tool (pull the audio track out of a
 * video file, e.g. a screen recording whose video is broken). Not tied
 * to the Library; the input comes from the native file picker.
 *
 * Design doc: docs/superpowers/specs/2026-08-06-extract-audio-design.md
 */

/** Tokens for the one-shot download endpoint. Extraction responses
 *  include a random token; the download route only serves paths from
 *  this map, so we never expose an arbitrary-path file server. Bounded
 *  so a long-running server doesn't accumulate entries forever. */
const downloadTokens = new Map<string, string>();
const MAX_TOKENS = 20;

function issueDownloadToken(filePath: string): string {
  const token = crypto.randomBytes(16).toString("hex");
  downloadTokens.set(token, filePath);
  while (downloadTokens.size > MAX_TOKENS) {
    const oldest = downloadTokens.keys().next().value;
    if (oldest === undefined) break;
    downloadTokens.delete(oldest);
  }
  return token;
}

/** First free variant of filePath: the path itself, else stem-1.ext,
 *  stem-2.ext, … Never overwrites an existing file. */
function uniqueOutputPath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

/** Codec name of the first audio stream, or null when the file has no
 *  audio track (the "silent screen recording" case we error on). */
function probeAudioCodec(filePath: string): Promise<string | null> {
  const args = [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("error", (err) => reject(new Error(`Failed to start ffprobe: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}: ${stderr.slice(-500)}`));
      resolve(stdout.trim() || null);
    });
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  console.log(`[tools] ffmpeg ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    proc.on("error", (err) => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

export function registerToolsRoutes(app: Express): void {
  // Extract the audio track from a video file on the server's disk.
  // Output lands next to the source; m4a stream-copies when the source
  // audio is already AAC (instant), otherwise re-encodes.
  app.post("/api/tools/extract-audio", async (req, res) => {
    try {
      const inputPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
      const format = req.body?.format === "mp3" ? "mp3" : "m4a";
      if (!inputPath) {
        return res.status(400).json({ error: "path is required" });
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(inputPath);
      } catch {
        return res.status(400).json({ error: `File not found: ${inputPath}` });
      }
      if (!stat.isFile()) {
        return res.status(400).json({ error: `Not a file: ${inputPath}` });
      }

      const codec = await probeAudioCodec(inputPath);
      if (!codec) {
        return res.status(400).json({ error: "This file has no audio track." });
      }

      const parsed = path.parse(inputPath);
      const outputPath = uniqueOutputPath(path.join(parsed.dir, `${parsed.name}.${format}`));

      const args = format === "mp3"
        ? [
            "-i", inputPath, "-vn", "-map", "0:a:0",
            "-c:a", "libmp3lame", "-q:a", "2",
            "-y", outputPath,
          ]
        : codec === "aac"
          ? [
              "-i", inputPath, "-vn", "-map", "0:a:0",
              "-c:a", "copy", "-movflags", "+faststart",
              "-y", outputPath,
            ]
          : [
              "-i", inputPath, "-vn", "-map", "0:a:0",
              "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
              "-y", outputPath,
            ];

      try {
        await runFfmpeg(args);
      } catch (err) {
        // Don't leave a half-written output behind on failure.
        try { fs.unlinkSync(outputPath); } catch {}
        throw err;
      }

      const sizeBytes = fs.statSync(outputPath).size;
      const durationSeconds = await getMediaDuration(outputPath).catch(() => null);

      res.json({
        outputPath,
        sizeBytes,
        durationSeconds,
        downloadToken: issueDownloadToken(outputPath),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // One-shot download of a just-extracted file (phone / PWA case where
  // the server path isn't reachable). Only paths in the token map are
  // servable; tokens survive until evicted by newer extractions.
  app.get("/api/tools/extract-audio/download", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const filePath = token ? downloadTokens.get(token) : undefined;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Unknown or expired download token" });
    }
    res.download(filePath, path.basename(filePath));
  });
}
