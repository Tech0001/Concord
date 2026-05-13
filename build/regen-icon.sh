#!/usr/bin/env bash
# Regenerate macOS iconset + .icns from build/icon-src/icon_1024.png.
# Run this after updating the source PNG; then rebuild the .app:
#   pnpm run electron:dist
set -euo pipefail
cd "$(dirname "$0")"

SRC=icon-src/icon_1024.png
if [[ ! -f "$SRC" ]]; then
  echo "Missing source: $SRC" >&2
  exit 1
fi

rm -rf icon.iconset icon.icns
mkdir icon.iconset

for entry in \
  "16:icon_16x16.png" \
  "32:icon_16x16@2x.png" \
  "32:icon_32x32.png" \
  "64:icon_32x32@2x.png" \
  "128:icon_128x128.png" \
  "256:icon_128x128@2x.png" \
  "256:icon_256x256.png" \
  "512:icon_256x256@2x.png" \
  "512:icon_512x512.png" \
  "1024:icon_512x512@2x.png"
do
  size="${entry%%:*}"
  name="${entry##*:}"
  sips -z "$size" "$size" "$SRC" --out "icon.iconset/$name" > /dev/null
done

iconutil -c icns icon.iconset -o icon.icns
echo "Wrote: $(pwd)/icon.icns ($(du -h icon.icns | cut -f1))"
