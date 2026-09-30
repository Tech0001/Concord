#!/usr/bin/env bash
# Stage the pinned, tested Linux native runtime and its private shared libraries.
set -euo pipefail
cd "$(dirname "$0")/.."
runtime_revision=4c101bc7113f49101a3e11d2c994c519f41939f6
runtime_source="${CONCORD_LAB_CACHE:-$HOME/.cache/concord-diarization-lab}/NeMo-Speech.cpp"
runtime_build="$runtime_source/build-asr-lab"
if [[ "$(uname -s)" != Linux ]]; then
  echo 'This branch packages the native runtime for Linux first.' >&2
  exit 1
fi
if [[ ! -x "$runtime_build/bin/nemo-speech" ]]; then
  CONCORD_LAB_ASR=ON bash experiments/diarization/build-runtime.sh "${CONCORD_NEMO_BACKEND:-vulkan}"
fi
if [[ "$(git -C "$runtime_source" rev-parse HEAD)" != "$runtime_revision" ]]; then
  echo 'Native runtime source does not match the tested revision.' >&2
  exit 1
fi
stage=build/binaries/nemo
mkdir -p "$stage/licenses"
cp "$runtime_build/bin/nemo-speech" "$stage/"
cp -a "$runtime_build"/bin/lib*.so* "$stage/"
cp "$runtime_source/LICENSE" "$stage/licenses/NeMo-Speech.cpp-LICENSE"
cp "$runtime_source/ggml/LICENSE" "$stage/licenses/ggml-LICENSE"
cp -a "$runtime_source/.deps/sentencepiece/share/licenses/nemo-speech/third_party" "$stage/licenses/"
printf '%s\n' "$runtime_revision" > "$stage/REVISION"
"$stage/nemo-speech" doctor --json
