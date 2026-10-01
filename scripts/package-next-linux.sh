#!/usr/bin/env bash
# Bundle the webview's media decoders as well as Concord's speech runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Linux ]]; then
  echo 'This preview packaging script currently supports Linux.' >&2
  exit 1
fi
for tool in patchelf gst-inspect-1.0 pkg-config; do
  if ! command -v "$tool" >/dev/null; then
    echo "Packaging requires $tool on PATH." >&2
    exit 1
  fi
done
if [[ ! -x build/binaries/nemo/nemo-speech ]]; then
  bash scripts/stage-nemo-runtime.sh
fi
if [[ ! -x build/binaries/embedding/llama-server || ! -f build/binaries/embedding/libggml-vulkan.so ]]; then
  bash scripts/build-embedding-runtime.sh
fi
bash scripts/stage-next-downloads.sh
bash scripts/stage-next-setup.sh
system_plugins="$(pkg-config --variable=pluginsdir gstreamer-1.0)"
mkdir -p build
staging_root="$(mktemp -d "$PWD/build/concord-media.XXXXXX")"
trap 'rm -rf "$staging_root"' EXIT
stage="$staging_root/plugins"
mkdir -p "$stage"
# A staging folder may supply additional distro-matched plugins without root.
# These files must come from the same GStreamer release as the build system.
extra_plugins="${CONCORD_GST_PLUGINS:-$PWD/build/binaries/gstreamer}"
for plugin in "$system_plugins"/*.so "$extra_plugins"/*.so; do
  [[ -f "$plugin" ]] || continue
  cp -L "$plugin" "$stage/"
done
export GST_PLUGIN_PATH_1_0="$stage${GST_PLUGIN_PATH_1_0:+:$GST_PLUGIN_PATH_1_0}"
for element in qtdemux matroskademux opusdec vorbisdec avdec_h264 avdec_aac; do
  if ! gst-inspect-1.0 "$element" >/dev/null; then
    echo "Missing media decoder: $element. Install GStreamer good, bad, and libav plugins." >&2
    exit 1
  fi
done
if ! gst-inspect-1.0 av1dec >/dev/null 2>&1 && ! gst-inspect-1.0 dav1ddec >/dev/null 2>&1; then
  echo 'Missing AV1 decoder. Install GStreamer bad plugins or the dav1d plugin.' >&2
  exit 1
fi
export GSTREAMER_PLUGINS_DIR="$stage"
export GSTREAMER_HELPERS_DIR="$staging_root/helpers"
mkdir -p "$GSTREAMER_HELPERS_DIR"
for helper_dir in "$system_plugins" \
  "$(pkg-config --variable=libexecdir gstreamer-1.0)/gstreamer-1.0" \
  "/usr/lib/$(uname -m)-linux-gnu/gstreamer1.0/gstreamer-1.0"; do
  [[ -x "$helper_dir/gst-plugin-scanner" ]] || continue
  cp -L "$helper_dir/gst-plugin-scanner" "$GSTREAMER_HELPERS_DIR/"
  [[ ! -x "$helper_dir/gst-ptp-helper" ]] || cp -L "$helper_dir/gst-ptp-helper" "$GSTREAMER_HELPERS_DIR/"
  break
done
if [[ ! -x "$GSTREAMER_HELPERS_DIR/gst-plugin-scanner" ]]; then
  echo 'Cannot find the GStreamer plugin scanner.' >&2
  exit 1
fi
pnpm --dir desktop exec tauri build --bundles appimage deb "$@"
