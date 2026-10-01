#!/usr/bin/env bash
# Private uv installs only into Concord's data directory, never into system Python.
set -euo pipefail
cd "$(dirname "$0")/.."
version=0.12.5
case "$(uname -m)" in
 x86_64|amd64) arch=x86_64; hash=68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2 ;;
 aarch64|arm64) arch=aarch64; hash=9bf43b4d1a07665bf64d4c4e710930b382321a785e0eb10aac07f46471f86a31 ;;
 *) echo 'Unsupported setup-tool architecture' >&2; exit 1 ;;
esac
asset="uv-$arch-unknown-linux-gnu"
cache="$PWD/build/download-cache"
dest="$PWD/build/binaries/setup"
mkdir -p "$cache" "$dest"
archive="$cache/$asset-$version.tar.gz"
if [[ ! -f "$archive" ]] || [[ "$(sha256sum "$archive" | cut -d' ' -f1)" != "$hash" ]]; then
 curl -fL --retry 3 --connect-timeout 30 "https://github.com/astral-sh/uv/releases/download/$version/$asset.tar.gz" -o "$archive.partial"
 printf '%s  %s\n' "$hash" "$archive.partial" | sha256sum -c -
 mv "$archive.partial" "$archive"
fi
stage="$(mktemp -d "$cache/uv-stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$archive" -C "$stage"
install -m 755 "$stage/$asset/uv" "$dest/uv"
for name in LICENSE-APACHE LICENSE-MIT; do
 curl -fsSL --retry 3 "https://raw.githubusercontent.com/astral-sh/uv/$version/$name" -o "$stage/$name"
 cp "$stage/$name" "$dest/$name"
done
printf 'uv %s\nArchive SHA-256: %s\nSource: https://github.com/astral-sh/uv/tree/%s\n' "$version" "$hash" "$version" > "$dest/SOURCES.txt"
"$dest/uv" --version
