import youtubedl, { create } from "youtube-dl-exec";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Concord's yt-dlp resolution strategy, ordered by precedence:
//
//   1. <userdata>/bin/yt-dlp — the writable, user-updatable copy.
//      Seeded on first launch from the bundle, but lives outside the
//      signed .app so the "Update yt-dlp" button can swap it without
//      asking the user to wait for a full app release. YouTube breaks
//      yt-dlp every couple weeks; this lets the user keep up.
//
//   2. <resourcesPath>/binaries/yt-dlp — the binary we shipped in the
//      .app. Only the seed source; once copied to (1) we don't touch it.
//
//   3. /opt/homebrew/bin/yt-dlp (Apple Silicon brew),
//      /usr/local/bin/yt-dlp (Intel brew or manual),
//      /usr/bin/yt-dlp (Linux distro packages) — dev-mode fallback when
//      neither (1) nor (2) is present.
//
//   4. youtube-dl-exec's bundled Python zipapp — last-ditch fallback.
//      Requires python3 >= 3.10 on PATH, which not every Mac has, so it's
//      genuinely a last resort.

function userDataDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Concord");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Concord");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "concord");
}

/** Writable copy of yt-dlp. The "Update yt-dlp" endpoint writes here;
 *  we always execute from here.
 *
 *  Special-case for macOS: the canonical data dir is "Application
 *  Support/Concord" — but the embedded space breaks `youtube-dl-exec`'s
 *  tinyspawn, which naively does `input.split(' ')` on the binary path
 *  and tries to spawn the first segment as the command. Stashing the
 *  binary in `~/.concord/bin` instead sidesteps the bug entirely — the
 *  path has no spaces, so split-on-space is a no-op.
 *
 *  Linux + Windows aren't affected (their data dirs already have no
 *  spaces), so they keep using the standard userdata location for
 *  consistency with everything else under that tree. */
function ytdlpBinDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".concord", "bin");
  }
  return path.join(userDataDir(), "bin");
}

export function userYtdlpPath(): string {
  return path.join(ytdlpBinDir(), "yt-dlp");
}

/** Read-only seed copy inside the packaged .app. Undefined under
 *  `pnpm dev` (process.resourcesPath only exists when running inside
 *  an Electron .app bundle). */
function bundledYtdlpPath(): string | null {
  if (typeof process.resourcesPath !== "string") return null;
  return path.join(process.resourcesPath, "binaries", "yt-dlp");
}

/** Find the first existing system yt-dlp (brew / distro). Dev-mode safety
 *  net for machines that don't have the .app installed. */
function findSystemYtdlp(): string | undefined {
  const candidates = [
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* try next */ }
  }
  return undefined;
}

/** Seed the writable copy from the bundle if the writable one doesn't
 *  exist yet. First-launch only — once seeded we leave it alone and let
 *  the "Update yt-dlp" flow manage it. Idempotent. */
function ensureUserYtdlpSeeded(): void {
  const dst = userYtdlpPath();
  if (fs.existsSync(dst)) return;
  const src = bundledYtdlpPath();
  if (!src || !fs.existsSync(src)) return;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    console.log(`[yt-dlp] seeded writable copy from bundle → ${dst}`);
  } catch (err) {
    console.warn(`[yt-dlp] failed to seed writable copy: ${err instanceof Error ? err.message : err}`);
  }
}

ensureUserYtdlpSeeded();

export type YtdlpKind = "user" | "bundled" | "native" | "zipapp";

function resolveYtdlp(): { path: string; kind: YtdlpKind } | null {
  const user = userYtdlpPath();
  if (fs.existsSync(user)) return { path: user, kind: "user" };

  const bundled = bundledYtdlpPath();
  if (bundled && fs.existsSync(bundled)) return { path: bundled, kind: "bundled" };

  const native = findSystemYtdlp();
  if (native) return { path: native, kind: "native" };

  return null;
}

const resolved = resolveYtdlp();
if (resolved) {
  console.log(`[yt-dlp] using ${resolved.kind} binary: ${resolved.path}`);
} else {
  console.log("[yt-dlp] no native binary found — falling back to bundled Python zipapp (requires python3 >= 3.10 on PATH)");
}

const ytdlp = resolved ? create(resolved.path) : youtubedl;
export default ytdlp;

/** Active yt-dlp binary path. `undefined` when we're on the
 *  youtube-dl-exec Python zipapp fallback. */
export const ytdlpBinaryPath: string | undefined = resolved?.path;

export interface YtdlpHealth {
  ok: boolean;
  version: string | null;
  path: string;
  kind: YtdlpKind;
  /** True only for the writable user-copy at <userdata>/bin/yt-dlp.
   *  The Settings UI uses this to decide whether to show the
   *  "Update yt-dlp" button — there's no point offering an update
   *  when we're running a Homebrew install or the Python fallback. */
  updatable: boolean;
  error?: string;
}

function zipappPath(): string {
  // youtube-dl-exec installs the Python zipapp into
  // node_modules/youtube-dl-exec/bin/yt-dlp.
  return path.resolve(process.cwd(), "node_modules/youtube-dl-exec/bin/yt-dlp");
}

/** Probe the active yt-dlp by running `--version`. Used by
 *  /api/pipeline/ytdlp-health for a status badge in the UI. We do NOT
 *  call `yt-dlp -U` here or anywhere — auto-update has bitten us with
 *  surprise breakage; the user-update flow goes through our explicit
 *  `/api/system/yt-dlp/update` endpoint instead. */
export async function probeYtdlpHealth(): Promise<YtdlpHealth> {
  const r = resolved
    ? { binaryPath: resolved.path, kind: resolved.kind }
    : { binaryPath: zipappPath(), kind: "zipapp" as const };
  try {
    // 30s, not 5s: yt-dlp is a PyInstaller bundle, and the very first
    // exec from a new process context unpacks ~35 MB of Python files
    // into a per-process temp dir. That cold-start can take 5–10s.
    // Electron's spawned children don't share TMPDIR with your terminal,
    // so the cache warmed by `yt-dlp --version` at a shell prompt doesn't
    // help — the app's first probe pays the full extraction cost. Warm
    // subsequent runs finish in <500ms regardless.
    const { stdout } = await execFileAsync(r.binaryPath, ["--version"], { timeout: 30000 });
    return {
      ok: true,
      version: stdout.trim(),
      path: r.binaryPath,
      kind: r.kind,
      updatable: r.kind === "user",
    };
  } catch (err) {
    return {
      ok: false,
      version: null,
      path: r.binaryPath,
      kind: r.kind,
      updatable: r.kind === "user",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
