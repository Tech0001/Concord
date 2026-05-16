#!/usr/bin/env bash
#
# Stage the third-party binaries that Concord bundles inside the .app at
# pack time. Run this before `pnpm run electron:dist` (the dist script
# invokes it automatically). Outputs:
#
#   build/binaries/fluidaudiocli   FluidAudio's transcription CLI
#   build/binaries/yt-dlp          yt-dlp universal binary from yt-dlp/releases
#
# Both are signed automatically as part of electron-builder's deep
# codesign pass over the .app bundle.

set -euo pipefail

cd "$(dirname "$0")/.."

BINARIES_DIR="build/binaries"
mkdir -p "$BINARIES_DIR"

# ---- FluidAudio CLI --------------------------------------------------------
# FluidAudio doesn't publish prebuilt binaries on GitHub releases yet, so we
# copy from a local clone. Override via FLUIDAUDIO_REPO if your clone lives
# somewhere other than ~/GitHub/FluidAudio.

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

# ---- yt-dlp ----------------------------------------------------------------
# Universal binary (arm64 + x86_64). Verified against yt-dlp's SHA2-256SUMS
# manifest so a compromised mirror can't slip in a different binary.

YT_DLP_RELEASE="https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
echo "→ yt-dlp"
TAG=$(curl -fsSL "$YT_DLP_RELEASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])")
BASE="https://github.com/yt-dlp/yt-dlp/releases/download/$TAG"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

curl -fsSL -o "$TMP/yt-dlp_macos" "$BASE/yt-dlp_macos"
curl -fsSL -o "$TMP/SHA2-256SUMS" "$BASE/SHA2-256SUMS"

EXPECTED=$(awk '/[[:space:]]yt-dlp_macos$/ { print $1 }' "$TMP/SHA2-256SUMS" | head -n 1)
ACTUAL=$(shasum -a 256 "$TMP/yt-dlp_macos" | awk '{ print $1 }')
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "✗ SHA256 mismatch for yt-dlp_macos@$TAG" >&2
  echo "    expected: $EXPECTED" >&2
  echo "    actual:   $ACTUAL" >&2
  exit 1
fi

mv "$TMP/yt-dlp_macos" "$BINARIES_DIR/yt-dlp"
chmod +x "$BINARIES_DIR/yt-dlp"
echo "    $TAG  $(file "$BINARIES_DIR/yt-dlp" | sed 's|.*: ||')"
echo "    $(du -h "$BINARIES_DIR/yt-dlp" | cut -f1)  checksum verified"

echo "✓ All binaries staged in $BINARIES_DIR"
