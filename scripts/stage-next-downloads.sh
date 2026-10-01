#!/usr/bin/env bash
# Private, pinned downloader and JavaScript runtime for Concord Next (Linux).
# No installer runs, global tools are unchanged, and every executable is hashed.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Linux ]] || { echo 'Download runtime staging currently supports Linux.' >&2; exit 1; }
yt_version=2026.08.19
node_version=24.21.0
case "$(uname -m)" in
  x86_64|amd64)
    yt_asset=yt-dlp_linux
    yt_hash=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
    node_arch=x64
    node_hash=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
    ;;
  aarch64|arm64)
    yt_asset=yt-dlp_linux_aarch64
    yt_hash=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc
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
fetch "$yt_asset-$yt_version" "$yt_hash" "https://github.com/yt-dlp/yt-dlp/releases/download/$yt_version/$yt_asset"
node_archive="node-v$node_version-linux-$node_arch.tar.xz"
fetch "$node_archive" "$node_hash" "https://nodejs.org/dist/v$node_version/$node_archive"
stage="$(mktemp -d "$cache/stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
tar -xJf "$cache/$node_archive" -C "$stage" "node-v$node_version-linux-$node_arch/bin/node" "node-v$node_version-linux-$node_arch/LICENSE"
install -m 755 "$cache/$yt_asset-$yt_version" "$dest/yt-dlp"
install -m 755 "$stage/node-v$node_version-linux-$node_arch/bin/node" "$dest/node"
cp "$stage/node-v$node_version-linux-$node_arch/LICENSE" "$dest/NODE-LICENSE"
for license in LICENSE THIRD_PARTY_LICENSES.txt; do
  curl -fsSL --retry 3 --connect-timeout 30 "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$yt_version/$license" -o "$stage/$license"
  cp "$stage/$license" "$dest/YTDLP-$license"
done
cat > "$dest/SOURCES.txt" <<EOF
yt-dlp $yt_version ($yt_asset)
Binary SHA-256: $yt_hash
Source: https://github.com/yt-dlp/yt-dlp/tree/$yt_version
Release and dependency notices: https://github.com/yt-dlp/yt-dlp/releases/tag/$yt_version

Node.js v$node_version (linux-$node_arch)
Archive SHA-256: $node_hash
Source: https://nodejs.org/dist/v$node_version/node-v$node_version.tar.xz
Only the Node executable is distributed; npm and development headers are omitted.
EOF
"$dest/yt-dlp" --version
"$dest/node" --version
echo "Download tools staged in $dest"
