#!/usr/bin/env bash
# 构建 Rapfi WASM 引擎（多线程 SIMD 主变体 + 单线程 SIMD 兜底）。
#
# 依赖：emsdk（C:\emsdk）、pip 安装的 cmake、ninja.exe（~/.workbuddy/bin/tools）。
# 权重包：tools/rapfi-freestyle/（config.toml + freestyle.bin.lz4 ≈ 10MB，
# 由官方 Networks/mix9svq 裁剪而来——只留无禁手 15 路一套权重）。
#
# 注意：当前 Rapfi master 的 NNUE 评估器硬性要求 WASM SIMD，
# 不存在无 SIMD 变体（构建会 static_assert 失败）；config.toml 里的
# [model] binary_file 一行必须删除（指向不存在的经典模型，会让配置加载
# 整体失败退回内置评估）。coord_conversion_mode 保持 "X_flipY"，
# 引擎输入输出均为 Gomocup 惯例 (x=col, y=row)。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK_PATH="/c/emsdk:/c/emsdk/upstream/emscripten:$PATH"
export PATH="$EMSDK_PATH"

BASE="$ROOT/tools/rapfi/Rapfi/build"
NET="$ROOT/tools/rapfi-freestyle"
DEST="$ROOT/frontend/public/engine"

build_variant() {
  local name="$1"; shift
  mkdir -p "$BASE/$name"
  cd "$BASE/$name"
  emcmake cmake ../.. -DCMAKE_BUILD_TYPE=Release -DNO_COMMAND_MODULES=ON \
    -DNETWORKS_DIR="$NET" -G Ninja "$@" > /dev/null
  emmake cmake --build . --parallel 8
}

build_variant wasm-multi-simd128 -DUSE_WASM_SIMD=ON -DUSE_WASM_SIMD_RELAXED=OFF
build_variant wasm-single-simd128 -DUSE_WASM_SIMD=ON -DNO_MULTI_THREADING=ON

mkdir -p "$DEST"
cp "$BASE/wasm-multi-simd128/rapfi-multi-simd128.js"    "$DEST/"
cp "$BASE/wasm-multi-simd128/rapfi-multi-simd128.wasm"  "$DEST/"
cp "$BASE/wasm-single-simd128/rapfi-single-simd128.js"   "$DEST/"
cp "$BASE/wasm-single-simd128/rapfi-single-simd128.wasm" "$DEST/"
# 两个变体预加载同一套权重 → data 内容一致，共享一份即可
# （worker 的 locateFile 把 rapfi-*.data 统一重定向到 rapfi.data）
cp "$BASE/wasm-multi-simd128/rapfi-multi-simd128.data"   "$DEST/rapfi.data"
echo "artifacts -> $DEST"
