#!/usr/bin/env bash
# Build locally; no sudo, global packages, shell-profile edits, or app changes.
set -euo pipefail
runtime_rev=4c101bc7113f49101a3e11d2c994c519f41939f6
model_rev=f667ed73aee57d40cc39428eb768b4fd87a0a29e
sentencepiece_rev=17d7580d6407802f85855d2cc9190634e2c95624
vulkan_headers_rev=e3b1eec08173d6b825cd3ac88c885a63b621504a
spirv_headers_rev=cb42dec3830d3ac67fa449ecdc0c0f73d5e74498
lab_cache="${CONCORD_LAB_CACHE:-$HOME/.cache/concord-diarization-lab}"
runtime_src="$lab_cache/NeMo-Speech.cpp"
backend="${1:-cpu}"
build_asr="${CONCORD_LAB_ASR:-OFF}"
case "$build_asr" in ON|OFF) ;; *) echo 'CONCORD_LAB_ASR must be ON or OFF' >&2; exit 2 ;; esac
build_dir="$runtime_src/build-lab"
if [[ "$build_asr" == ON ]]; then build_dir="$runtime_src/build-asr-lab"; fi
case "$backend" in cpu|vulkan) ;; *) echo 'Usage: build-runtime.sh [cpu|vulkan]' >&2; exit 2 ;; esac
if [[ ! -d "$runtime_src/.git" ]]; then
  git clone --no-checkout https://github.com/NVIDIA/NeMo-Speech.cpp.git "$runtime_src"
fi
if [[ "$(git -C "$runtime_src" rev-parse HEAD)" != "$runtime_rev" ]]; then
  git -C "$runtime_src" fetch --depth 1 origin "$runtime_rev"
fi
git -C "$runtime_src" -c filter.lfs.process= -c filter.lfs.smudge=cat -c filter.lfs.required=false checkout --detach "$runtime_rev"
git -C "$runtime_src" submodule update --init --depth 1 ggml
if [[ ! -f "$runtime_src/.deps/sentencepiece/lib/libsentencepiece.a" ]]; then
  sp_source="$runtime_src/.deps/sentencepiece-build/source"
  sp_build="$runtime_src/.deps/sentencepiece-build/build"
  sp_prefix="$runtime_src/.deps/sentencepiece"
  if [[ ! -d "$sp_source/.git" ]]; then
    git clone --no-checkout https://github.com/google/sentencepiece.git "$sp_source"
  fi
  git -C "$sp_source" fetch --depth 1 origin "$sentencepiece_rev"
  git -C "$sp_source" checkout --detach "$sentencepiece_rev"
  # CMake 4 removed the old compatibility policy used by this pinned dependency.
  cmake -S "$sp_source" -B "$sp_build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DCMAKE_CXX_FLAGS='-include cstdint' \
    -DSPM_BUILD_TEST=OFF -DSPM_ENABLE_SHARED=OFF -DSPM_ENABLE_TCMALLOC=OFF
  cmake --build "$sp_build" --target sentencepiece-static -j 4
  install -d "$sp_prefix/lib" "$sp_prefix/include"
  install -m 0644 "$sp_build/src/libsentencepiece.a" "$sp_prefix/lib/libsentencepiece.a"
  install -m 0644 "$sp_source/src/sentencepiece_processor.h" "$sp_prefix/include/sentencepiece_processor.h"
  sp_licenses="$sp_prefix/share/licenses/nemo-speech/third_party/sentencepiece"
  install -Dm0644 "$sp_source/LICENSE" "$sp_licenses/LICENSE"
  for dep in absl darts_clone protobuf-lite; do
    install -Dm0644 "$sp_source/third_party/$dep/LICENSE" "$sp_licenses/$dep-LICENSE"
  done
fi
vulkan=OFF
vulkan_options=()
if [[ "$backend" == vulkan ]]; then
  vulkan=ON
  if [[ ! -f /usr/include/vulkan/vulkan.h ]]; then
    vk_headers="$lab_cache/Vulkan-Headers"
    if [[ ! -d "$vk_headers/.git" ]]; then
      git clone --depth 1 --branch v1.4.357 https://github.com/KhronosGroup/Vulkan-Headers.git "$vk_headers"
    fi
    if [[ "$(git -C "$vk_headers" rev-parse HEAD)" != "$vulkan_headers_rev" ]]; then
      echo 'Cached Vulkan headers do not match the pinned revision' >&2
      exit 1
    fi
    vulkan_options+=("-DVulkan_INCLUDE_DIR=$vk_headers/include")
  fi
  spirv_src="$lab_cache/SPIRV-Headers"
  if [[ ! -d "$spirv_src/.git" ]]; then
    git clone --depth 1 https://github.com/KhronosGroup/SPIRV-Headers.git "$spirv_src"
  fi
  if [[ "$(git -C "$spirv_src" rev-parse HEAD)" != "$spirv_headers_rev" ]]; then
    git -C "$spirv_src" fetch --depth 1 origin "$spirv_headers_rev"
    git -C "$spirv_src" checkout --detach "$spirv_headers_rev"
  fi
  cmake -S "$spirv_src" -B "$spirv_src/build-lab" -G Ninja \
    -DCMAKE_INSTALL_PREFIX="$spirv_src/install-lab"
  cmake --install "$spirv_src/build-lab"
  vulkan_options+=("-DCMAKE_PREFIX_PATH=$spirv_src/install-lab")
  vulkan_options+=("-DCMAKE_CXX_STANDARD_INCLUDE_DIRECTORIES=$spirv_src/install-lab/include")
fi
cmake -S "$runtime_src" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DNEMO_SPEECH_DEPENDENCY_PREFIX="$runtime_src/.deps" \
  -DCMAKE_CXX_FLAGS='-include cstdint' \
  -DNEMO_SPEECH_BUILD_ASR="$build_asr" -DNEMO_SPEECH_BUILD_DIAR=ON \
  -DNEMO_SPEECH_BUILD_TTS=OFF -DNEMO_SPEECH_BUILD_NMT=OFF \
  -DNEMO_SPEECH_BUILD_MIC_CAPTURE=OFF -DNEMO_SPEECH_GGML_PATCHED=OFF \
  -DGGML_VULKAN="$vulkan" "${vulkan_options[@]}"
cmake --build "$build_dir" --target nemo-speech -j 4
hf download nvidia/Nemotron-3-Diarization Nemotron-3-Diarization.q8_0.gguf \
  --revision "$model_rev" --local-dir "$lab_cache/models/nemotron-3"
"$build_dir/bin/nemo-speech" doctor
