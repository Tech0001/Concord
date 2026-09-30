#!/usr/bin/env bash
#
# Stage the third-party binaries that Concord bundles at pack time. The macOS
# and Linux dist scripts both invoke this automatically. Outputs:
#
#   build/binaries/fluidaudiocli   FluidAudio's transcription CLI (macOS only)
#   build/binaries/yt-dlp          native yt-dlp binary for the build host
#
# macOS binaries are signed automatically as part of electron-builder's deep
# codesign pass over the .app bundle. Every downloaded yt-dlp artifact is
# checked against the release's SHA2-256SUMS manifest before it is staged.

set -euo pipefail

cd "$(dirname "$0")/.."

BINARIES_DIR="build/binaries"
mkdir -p "$BINARIES_DIR"

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

case "$OS_NAME" in
  Darwin)
    YT_DLP_ASSET="yt-dlp_macos"

    # FluidAudio doesn't publish prebuilt binaries yet, so copy it from a
    # local clone. Override FLUIDAUDIO_REPO when the clone lives elsewhere.
    FLUIDAUDIO_REPO="${FLUIDAUDIO_REPO:-$HOME/GitHub/FluidAudio}"
    FLUIDAUDIO_BUILT="$FLUIDAUDIO_REPO/.build/release/fluidaudiocli"

    echo "→ FluidAudio"
    if [[ ! -x "$FLUIDAUDIO_BUILT" ]]; then
      echo "    Building FluidAudio (swift build -c release)…"
      (cd "$FLUIDAUDIO_REPO" && swift build -c release)
    fi
    cp "$FLUIDAUDIO_BUILT" "$BINARIES_DIR/fluidaudiocli"
    chmod +x "$BINARIES_DIR/fluidaudiocli"
    echo "    $(file "$BINARIES_DIR/fluidaudiocli" | sed 's|.*: ||')"
    echo "    $(du -h "$BINARIES_DIR/fluidaudiocli" | cut -f1)"
    ;;
  Linux)
    bash scripts/stage-nemo-runtime.sh
    # FluidAudio is Apple-only. Remove a stale macOS artifact so a build tree
    # reused across platforms cannot accidentally ship it in a Linux package.
    rm -f "$BINARIES_DIR/fluidaudiocli"
    case "$ARCH_NAME" in
      x86_64|amd64) YT_DLP_ASSET="yt-dlp_linux" ;;
      aarch64|arm64) YT_DLP_ASSET="yt-dlp_linux_aarch64" ;;
      *)
        echo "Unsupported Linux architecture for bundled yt-dlp: $ARCH_NAME" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Unsupported packaging host: $OS_NAME" >&2
    exit 1
    ;;
esac

# ---- yt-dlp ----------------------------------------------------------------
# Universal binary (arm64 + x86_64). Verified against yt-dlp's SHA2-256SUMS
# manifest so a compromised mirror can't slip in a different binary.

YT_DLP_RELEASE="https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
echo "→ yt-dlp"
TAG="${YT_DLP_TAG:-$(curl -fsSL "$YT_DLP_RELEASE" | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => console.log(JSON.parse(data).tag_name));')}"
BASE="https://github.com/yt-dlp/yt-dlp/releases/download/$TAG"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/$YT_DLP_ASSET" "$BASE/$YT_DLP_ASSET"
curl -fsSL -o "$TMP/SHA2-256SUMS" "$BASE/SHA2-256SUMS"

EXPECTED=$(awk -v asset="$YT_DLP_ASSET" '$2 == asset { print $1; exit }' "$TMP/SHA2-256SUMS")
if [[ -z "$EXPECTED" ]]; then
  echo "✗ No checksum found for $YT_DLP_ASSET@$TAG" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP/$YT_DLP_ASSET" | awk '{ print $1 }')
else
  ACTUAL=$(shasum -a 256 "$TMP/$YT_DLP_ASSET" | awk '{ print $1 }')
fi
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "✗ SHA256 mismatch for $YT_DLP_ASSET@$TAG" >&2
  echo "    expected: $EXPECTED" >&2
  echo "    actual:   $ACTUAL" >&2
  exit 1
fi

mv "$TMP/$YT_DLP_ASSET" "$BINARIES_DIR/yt-dlp"
chmod +x "$BINARIES_DIR/yt-dlp"
echo "    $TAG ($YT_DLP_ASSET)  $(file "$BINARIES_DIR/yt-dlp" | sed 's|.*: ||')"
echo "    $(du -h "$BINARIES_DIR/yt-dlp" | cut -f1)  checksum verified"

echo "✓ All binaries staged in $BINARIES_DIR"
