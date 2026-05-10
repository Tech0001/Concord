import youtubedl, { create } from "youtube-dl-exec";
import fs from "fs";

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
