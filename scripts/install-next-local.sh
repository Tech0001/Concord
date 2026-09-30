#!/usr/bin/env bash
# Install the native preview beside the existing Concord application.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Linux ]]; then
  echo 'This preview installer currently supports Linux.' >&2
  exit 1
fi
image="${1:-desktop/src-tauri/target/release/bundle/appimage/Concord Next_0.1.0_amd64.AppImage}"
if [[ ! -f "$image" ]]; then
  echo 'Build first with: pnpm --dir desktop package' >&2
  exit 1
fi
app_dir="$HOME/.local/opt/concord-next"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$app_dir" "$data_dir/applications" "$data_dir/icons/hicolor/scalable/apps"
staged_image="$(mktemp "$app_dir/.Concord-Next.XXXXXX")"
trap 'rm -f "$staged_image"' EXIT
install -m 755 "$image" "$staged_image"
mv -f "$staged_image" "$app_dir/Concord-Next.AppImage"
install -m 644 assets/brand/concord-icon.svg "$data_dir/icons/hicolor/scalable/apps/concord-next.svg"
# Desktop Entry quoted strings require escaping these characters, including $.
app_exec="$(python3 - "$app_dir/Concord-Next.AppImage" <<'PY'
import sys
p = sys.argv[1]
for char in ('\\', '"', '`', '$'):
    p = p.replace(char, '\\' + char)
print('"' + p.replace('%', '%%') + '"')
PY
)"
cat > "$data_dir/applications/concord-next.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Concord Next
Comment=Rust desktop preview of your spoken-word research archive
Exec=$app_exec
Icon=concord-next
Terminal=false
Categories=AudioVideo;
StartupWMClass=concord-next
EOF
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$data_dir/applications"
fi
printf 'Installed Concord Next: %s\n' "$app_dir/Concord-Next.AppImage"
