#!/usr/bin/env tsx
/**
 * One-shot batch: walk every entry in video_queue, detect VP9-encoded
 * source files, and transcode them to H.264 in-place. Updates
 * `video_path` in the DB to point at the new file. Preserves the
 * video_id / transcripts / notes / clips — only the underlying media
 * file changes.
 *
 * Why: iPhone Safari can't play VP9 (not even iOS 18). Converting to
 * H.264 makes the existing library playable on mobile without
 * re-downloading. AV1 would be smaller but YouTube's AV1 only exists
 * for specific videos; local re-encoding to AV1 is hours-per-video on
 * CPU. H.264 NVENC encodes at 5-10x realtime.
 *
 * Usage:
 *   pnpm tsx scripts/transcode-vp9-to-h264.ts           # dry run: list what would happen
 *   pnpm tsx scripts/transcode-vp9-to-h264.ts --apply   # actually transcode
 *   pnpm tsx scripts/transcode-vp9-to-h264.ts --apply --limit 5    # test on 5 files first
 *   pnpm tsx scripts/transcode-vp9-to-h264.ts --apply --keep-source  # keep .vp9.bak alongside
 *   pnpm tsx scripts/transcode-vp9-to-h264.ts --apply --cpu          # libx264 instead of nvenc
 */

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { getDb } from "../server/db";
import { updateQueueStatus } from "../server/db-queue";
import { ffprobeBin } from "../server/audio";

/** Resolve which ffmpeg to use. Order:
 *    1. Explicit --ffmpeg PATH override (e.g. /usr/local/bin/ffmpeg-nvenc).
 *    2. Common system locations + PATH lookup.
 *    3. Bundled @ffmpeg-installer binary (2018 static build — works for
 *       libx264 only, no NVENC compiled in). */
function resolveFfmpeg(override: string | null): string {
  if (override) {
    if (!fs.existsSync(override)) {
      console.error(`[transcode] --ffmpeg path does not exist: ${override}`);
      process.exit(1);
    }
    return override;
  }
  for (const candidate of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const w = spawnSync("which", ["ffmpeg"], { encoding: "utf-8" });
  if (w.status === 0 && w.stdout.trim()) return w.stdout.trim();
  console.warn("[transcode] No system ffmpeg found — falling back to bundled binary (no NVENC).");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ffmpegBin: bundled } = require("../server/audio");
  return bundled;
}

let ffmpegBin = ""; // set in main() after arg parsing

/** Probe `<ffmpeg> -encoders` for h264_nvenc. Saves a doomed encode
 *  attempt on machines without an NVIDIA GPU or with an ffmpeg built
 *  without nvenc support. */
function hasNvenc(): boolean {
  const r = spawnSync(ffmpegBin, ["-hide_banner", "-encoders"], { encoding: "utf-8" });
  if (r.status !== 0) return false;
  return /\bh264_nvenc\b/.test(r.stdout || "");
}

interface Args {
  apply: boolean;
  keepSource: boolean;
  limit: number;
  /** Override the auto-detected ffmpeg with a specific binary (e.g.
   *  /usr/local/bin/ffmpeg-nvenc from a BtbN static build). */
  ffmpegOverride: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { apply: false, keepSource: false, limit: Infinity, ffmpegOverride: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--keep-source") args.keepSource = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--ffmpeg") args.ffmpegOverride = argv[++i];
    else if (a.startsWith("--ffmpeg=")) args.ffmpegOverride = a.slice("--ffmpeg=".length);
    else if (a === "--help" || a === "-h") { printHelpAndExit(); }
    else { console.error(`Unknown argument: ${a}`); printHelpAndExit(1); }
  }
  return args;
}

function printHelpAndExit(code = 0): never {
  console.log(`Usage: pnpm tsx scripts/transcode-vp9-to-h264.ts [options]

  --apply         Actually transcode (default is dry-run).
  --keep-source   Keep the original VP9 file with a .vp9.bak suffix.
  --limit N       Process at most N files this run.
  --ffmpeg PATH   Override the auto-detected ffmpeg binary
                  (e.g. --ffmpeg /usr/local/bin/ffmpeg-nvenc for a
                  static build with NVENC support).
  -h, --help      Show this help.

  NVENC required. Script aborts if h264_nvenc isn't available — CPU
  encoding is too slow to be useful for batch jobs of this size.`);
  process.exit(code);
}

interface QueueRow {
  video_id: string;
  channel_id: string;
  title: string;
  video_path: string | null;
}

function listCandidates(): QueueRow[] {
  return getDb()
    .prepare(`SELECT video_id, channel_id, title, video_path
              FROM video_queue
              WHERE video_path IS NOT NULL AND video_path <> ''
              ORDER BY updated_at DESC`)
    .all() as QueueRow[];
}

/** Probe the video stream's codec via ffprobe. Returns null on any
 *  failure (missing file, ffprobe error, no video stream). */
function probeVideoCodec(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const r = spawnSync(ffprobeBin, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim().toLowerCase() || null;
}

/** Transcode src → dst with NVENC H.264 video + AAC audio. Streams
 *  ffmpeg progress to stdout. Resolves on exit 0; throws otherwise. */
function transcode(src: string, dst: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -pix_fmt yuv420p — broadest browser compatibility.
    // -movflags +faststart — moves moov atom to the start so the file is
    //   streamable / scrubbable without downloading the whole thing.
    // -cq 23 — NVENC constant-quality knob (visually transparent at this
    //   value for typical YouTube-quality input).
    // -f mp4 — explicit format because the temp file ends in .tmp.
    const args = [
      "-y",
      "-i", src,
      "-c:v", "h264_nvenc",
      "-preset", "p5",
      "-cq", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-f", "mp4",
      dst,
    ];

    console.log(`  ${ffmpegBin} ${args.join(" ")}`);
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

function fmtSize(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  ffmpegBin = resolveFfmpeg(args.ffmpegOverride);
  console.log(`[transcode] ffmpeg: ${ffmpegBin}`);

  // Verify the chosen encoder is actually compiled into this ffmpeg.
  // If the user asked for GPU but nvenc isn't present, fall back to CPU
  // with a clear warning rather than failing 133 times in a row.
  if (!hasNvenc()) {
    console.error(`[transcode] ${ffmpegBin} doesn't expose h264_nvenc.`);
    console.error(`  Install a GPL static build with NVENC, e.g.:`);
    console.error(`    curl -L -o /tmp/ff.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz`);
    console.error(`    mkdir -p /tmp/ff && tar xf /tmp/ff.tar.xz -C /tmp/ff --strip-components=1`);
    console.error(`    sudo install -m 755 /tmp/ff/bin/ffmpeg /usr/local/bin/ffmpeg-nvenc`);
    console.error(`  Then re-run with --ffmpeg /usr/local/bin/ffmpeg-nvenc`);
    process.exit(1);
  }

  console.log(`[transcode] mode: ${args.apply ? "APPLY" : "dry-run"} | encoder: h264_nvenc | keep source: ${args.keepSource} | limit: ${args.limit === Infinity ? "no limit" : args.limit}`);

  const all = listCandidates();
  const vp9: QueueRow[] = [];
  let missingCount = 0;
  let notVp9Count = 0;

  console.log(`[transcode] Scanning ${all.length} queue entries...`);
  for (const row of all) {
    if (!row.video_path) continue;
    const codec = probeVideoCodec(row.video_path);
    if (codec === null) {
      missingCount++;
      continue;
    }
    if (codec === "vp9" || codec === "vp09") {
      vp9.push(row);
    } else {
      notVp9Count++;
    }
  }

  console.log(`[transcode] Found ${vp9.length} VP9 video${vp9.length === 1 ? "" : "s"} to transcode (${notVp9Count} already non-VP9, ${missingCount} missing/unreadable files).`);

  if (vp9.length === 0) {
    console.log("[transcode] Nothing to do.");
    return;
  }

  const target = vp9.slice(0, args.limit);
  if (!args.apply) {
    console.log("[transcode] Dry run — would transcode:");
    for (const row of target) {
      const stat = fs.statSync(row.video_path!);
      console.log(`  - ${row.title}  (${fmtSize(stat.size)})  ${row.video_path}`);
    }
    console.log("[transcode] Re-run with --apply to actually transcode.");
    return;
  }

  let success = 0, failed = 0;
  for (let i = 0; i < target.length; i++) {
    const row = target[i];
    const src = row.video_path!;
    const ext = path.extname(src);
    const dst = src.replace(new RegExp(`${ext}$`), ".mp4");
    const tmp = `${dst}.tmp`;
    const backup = `${src}.vp9.bak`;

    console.log(`\n[${i + 1}/${target.length}] ${row.title}`);
    console.log(`  src: ${src}`);
    console.log(`  dst: ${dst}`);

    // If dst == src (already .mp4 named but VP9-encoded, rare), use a
    // distinct temp + rename. If dst != src, we still write to tmp first
    // so a partial encode doesn't get registered.
    try {
      await transcode(src, tmp);

      // Sanity-check the output before swapping.
      const stat = fs.statSync(tmp);
      if (stat.size === 0) throw new Error("ffmpeg produced empty output");
      const newCodec = probeVideoCodec(tmp);
      if (newCodec !== "h264") throw new Error(`unexpected output codec: ${newCodec}`);

      // Move source aside, then move tmp into place. Always-rename even
      // when src==dst (e.g. .mp4 → .mp4) so we don't overwrite mid-move.
      if (args.keepSource) {
        fs.renameSync(src, backup);
      } else {
        fs.unlinkSync(src);
      }
      fs.renameSync(tmp, dst);

      // Update DB if the path changed (extension differs).
      if (dst !== src) {
        updateQueueStatus(row.video_id, row.channel_id, { videoPath: dst });
      }
      const inSize = args.keepSource ? fs.statSync(backup).size : "(deleted)";
      const outSize = fs.statSync(dst).size;
      console.log(`  ✓ ${typeof inSize === "string" ? inSize : fmtSize(inSize)} → ${fmtSize(outSize)}`);
      success++;
    } catch (err) {
      console.error(`  ✗ ${(err as Error).message}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      failed++;
    }
  }

  console.log(`\n[transcode] Done. Success: ${success}, failed: ${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[transcode] Fatal:", err);
  process.exit(1);
});
