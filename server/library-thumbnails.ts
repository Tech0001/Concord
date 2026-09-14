import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { ffmpegBin } from "./audio";
import { getDb, type QueueEntry, videoKind } from "./db";
import { trackChildProcess } from "./child-process-registry";

const inflight = new Map<string, Promise<string | null>>();
const waiting: Array<() => void> = [];
let activeGenerators = 0;
const MAX_GENERATORS = 2;

async function withGeneratorSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeGenerators >= MAX_GENERATORS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  activeGenerators += 1;
  try {
    return await work();
  } finally {
    activeGenerators -= 1;
    waiting.shift()?.();
  }
}

export function libraryThumbnailCachePath(entry: QueueEntry): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${entry.channel_id}\0${entry.video_id}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(path.dirname(getDb().name), "thumbnails", `${digest}.jpg`);
}

function fallbackYouTubeThumbnail(entry: QueueEntry): string | null {
  if (!/(youtube\.com|youtu\.be)/i.test(entry.url || "")) return null;
  return /^[A-Za-z0-9_-]{11}$/.test(entry.video_id)
    ? `https://i.ytimg.com/vi/${entry.video_id}/hqdefault.jpg`
    : null;
}

async function downloadThumbnail(url: string, output: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 100 || bytes.length > 5 * 1024 * 1024) return false;
    fs.writeFileSync(output, bytes);
    return true;
  } catch {
    return false;
  }
}

function extractVideoFrame(entry: QueueEntry, output: string): Promise<boolean> {
  if (!entry.video_path || !fs.existsSync(entry.video_path)) return Promise.resolve(false);
  const seek = Math.max(1, Math.min(60, (entry.duration || 100) * 0.1));
  return new Promise((resolve) => {
    const proc = trackChildProcess(spawn(ffmpegBin, [
      "-ss", String(seek),
      "-i", entry.video_path!,
      "-frames:v", "1",
      "-vf", "scale=640:-2",
      "-q:v", "4",
      "-f", "image2",
      "-y", output,
    ], { stdio: "ignore" }), "ffmpeg library thumbnail");
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(
      code === 0 && fs.existsSync(output) && fs.statSync(output).size > 100,
    ));
  });
}

/** Resolve or lazily create a local thumbnail. Remote artwork is cached once;
 * local videos fall back to a representative ffmpeg frame. Audio deliberately
 * returns null so the Library can render its dedicated audio treatment. */
export async function ensureLibraryThumbnail(entry: QueueEntry): Promise<string | null> {
  if (videoKind(entry.video_path) === "audio") return null;
  const output = libraryThumbnailCachePath(entry);
  if (fs.existsSync(output) && fs.statSync(output).size > 100) return output;

  const key = `${entry.channel_id}:${entry.video_id}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = withGeneratorSlot(async () => {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temp = `${output}.${process.pid}.${Date.now()}.tmp`;
    try {
      const remote = entry.thumbnail_url || fallbackYouTubeThumbnail(entry);
      const downloaded = remote ? await downloadThumbnail(remote, temp) : false;
      const extracted = downloaded ? false : await extractVideoFrame(entry, temp);
      if (!downloaded && !extracted) return null;
      fs.renameSync(temp, output);
      return output;
    } finally {
      if (fs.existsSync(temp)) {
        try { fs.unlinkSync(temp); } catch {}
      }
      inflight.delete(key);
    }
  });
  inflight.set(key, promise);
  return promise;
}
