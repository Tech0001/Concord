#!/usr/bin/env bash
# Pinned runtime with portable CPU backends and optional Vulkan GPU acceleration. Model weights are downloaded separately by Concord.
set -euo pipefail
cd "$(dirname "$0")/.."
revision=f7b384c1e5c5b2c5b321a4a7cefea04b15b54cb7
source_dir="$PWD/build/llama-source"
if [[ ! -d "$source_dir/.git" ]]; then git clone --filter=blob:none --no-checkout https://github.com/ggml-org/llama.cpp.git "$source_dir"; fi
if ! git -C "$source_dir" cat-file -e "$revision^{commit}" 2>/dev/null; then
  git -C "$source_dir" fetch --depth 1 origin "$revision"
fi
git -C "$source_dir" checkout --detach "$revision"
cmake -S "$source_dir" -B "$source_dir/build-concord" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_CUDA=OFF -DGGML_VULKAN=ON -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build "$source_dir/build-concord" --config Release --target llama-server -j "${CONCORD_BUILD_JOBS:-8}"
mkdir -p build/binaries/embedding
cp "$source_dir/build-concord/bin/llama-server" build/binaries/embedding/
cp -P "$source_dir/build-concord/bin/"*.so* build/binaries/embedding/
# Keep runtime lookup relocatable inside the AppImage.
for lib in build/binaries/embedding/llama-server build/binaries/embedding/*.so*; do
  [[ -L "$lib" ]] || patchelf --set-rpath '$ORIGIN' "$lib"
done
cp "$source_dir/LICENSE" build/binaries/embedding/LLAMA-LICENSE
printf '%s\n' "$revision" > build/binaries/embedding/REVISION
