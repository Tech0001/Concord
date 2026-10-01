#!/usr/bin/env bash
# Private, pinned JavaScript runtime for Concord Next (Linux).
# yt-dlp is installed from Settings only after the user opts in.
# No installer runs, global tools are unchanged, and every executable is hashed.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Linux ]] || { echo 'Download runtime staging currently supports Linux.' >&2; exit 1; }
node_version=24.21.0
case "$(uname -m)" in
  x86_64|amd64)
    node_arch=x64
    node_hash=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
    ;;
  aarch64|arm64)
    node_arch=arm64
    node_hash=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
    ;;
  *) echo 'Unsupported downloader architecture.' >&2; exit 1 ;;
esac
cache="$PWD/build/download-cache"
dest="$PWD/build/binaries/downloads"
mkdir -p "$cache" "$dest"
fetch() {
  local target="$cache/$1" expected="$2" url="$3"
  if [[ ! -f "$target" ]] || [[ "$(sha256sum "$target" | cut -d' ' -f1)" != "$expected" ]]; then
    curl -fL --retry 3 --connect-timeout 30 -o "$target.partial" "$url"
    printf '%s  %s\n' "$expected" "$target.partial" | sha256sum -c -
    mv "$target.partial" "$target"
  fi
}
node_archive="node-v$node_version-linux-$node_arch.tar.xz"
fetch "$node_archive" "$node_hash" "https://nodejs.org/dist/v$node_version/$node_archive"
stage="$(mktemp -d "$cache/stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
tar -xJf "$cache/$node_archive" -C "$stage" "node-v$node_version-linux-$node_arch/bin/node" "node-v$node_version-linux-$node_arch/LICENSE"
install -m 755 "$stage/node-v$node_version-linux-$node_arch/bin/node" "$dest/node"
cp "$stage/node-v$node_version-linux-$node_arch/LICENSE" "$dest/NODE-LICENSE"
# Remove artifacts left by pre-opt-in builds so they cannot enter the bundle.
rm -f "$dest/yt-dlp" "$dest/YTDLP-LICENSE" "$dest/YTDLP-THIRD_PARTY_LICENSES.txt"
cat > "$dest/SOURCES.txt" <<EOF
Node.js v$node_version (linux-$node_arch)
Archive SHA-256: $node_hash
Source: https://nodejs.org/dist/v$node_version/node-v$node_version.tar.xz
Only the Node executable is distributed; npm and development headers are omitted.
EOF
"$dest/node" --version
echo "Download JavaScript runtime staged in $dest (yt-dlp is not bundled)"
