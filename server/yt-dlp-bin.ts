import youtubedl, { create } from "youtube-dl-exec";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// On macOS the bundled yt-dlp is a Python zipapp — it requires the host's
// `python3` on PATH to be 3.10+. macOS resolves `python3` to Xcode's vendored
// 3.9, which yt-dlp explicitly rejects on import. The fix that doesn't break
// every six months is to prefer a self-contained native binary (brew on Mac,
// distro packages on Linux) when present.
function findNativeYtdlp(): string | undefined {
  const candidates = [
    "/opt/homebrew/bin/yt-dlp", // macOS Apple Silicon (brew)
    "/usr/local/bin/yt-dlp",    // macOS Intel (brew) or manual install
    "/usr/bin/yt-dlp",          // Linux distro packages (apt/pacman/etc.)
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* try next */ }
  }
  return undefined;
}

const nativeYtdlp = findNativeYtdlp();
if (nativeYtdlp) {
  console.log(`[yt-dlp] using native binary: ${nativeYtdlp}`);
} else {
  console.log("[yt-dlp] using bundled (requires python3 >= 3.10 on PATH)");
}

const ytdlp = nativeYtdlp ? create(nativeYtdlp) : youtubedl;
export default ytdlp;

/** Path of the yt-dlp binary actually being invoked. `undefined` when the
 *  bundled Python zipapp is in use (resolved at runtime via youtube-dl-exec). */
export const ytdlpBinaryPath: string | undefined = nativeYtdlp;

export interface YtdlpHealth {
  ok: boolean;
  version: string | null;
  path: string;
  /** "native" = brew/distro binary, "bundled" = youtube-dl-exec's Python zipapp. */
  kind: "native" | "bundled";
  error?: string;
}

function resolveBundledPath(): string {
  // youtube-dl-exec installs the Python zipapp into node_modules/.../bin/yt-dlp.
  return path.resolve(process.cwd(), "node_modules/youtube-dl-exec/bin/yt-dlp");
}

/** Probe the active yt-dlp by running `--version`. Used by /api/pipeline/ytdlp-health
 *  to surface a status badge in the UI. We intentionally do NOT call `yt-dlp -U`
 *  here or anywhere — auto-update has bitten us with surprise breakage. The
 *  user updates via brew / their package manager on their own schedule. */
export async function probeYtdlpHealth(): Promise<YtdlpHealth> {
  const binaryPath = nativeYtdlp ?? resolveBundledPath();
  const kind: "native" | "bundled" = nativeYtdlp ? "native" : "bundled";
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], { timeout: 5000 });
    return { ok: true, version: stdout.trim(), path: binaryPath, kind };
  } catch (err) {
    return {
      ok: false,
      version: null,
      path: binaryPath,
      kind,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
