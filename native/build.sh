#!/usr/bin/env bash
# build.sh — compiles native/modpod_dsp.cpp + libopenmpt + Signalsmith Stretch
# into js/wasm/modpod-dsp.js (WebAssembly embedded, works inside an AudioWorklet).
#
# Needs the Emscripten SDK on the PATH (source emsdk_env.sh first).
#   https://emscripten.org/docs/getting_started/downloads.html
#
# Usage:  native/build.sh [work-dir]
# The work dir (default: native/.build) holds downloaded sources; it's git-ignored.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="${1:-$ROOT/native/.build}"
mkdir -p "$WORK"

OPENMPT_VER="0.8.9"
STRETCH_TAG="main"       # Signalsmith Stretch (MIT)
LINEAR_TAG="main"        # its FFT/linear-algebra dependency (MIT)

# ---- sources ---------------------------------------------------------------
if [ ! -d "$WORK/libopenmpt" ]; then
  curl -sSL "https://lib.openmpt.org/files/libopenmpt/src/libopenmpt-${OPENMPT_VER}+release.makefile.tar.gz" | tar xz -C "$WORK"
  mv "$WORK/libopenmpt-${OPENMPT_VER}+release" "$WORK/libopenmpt"
fi
[ -d "$WORK/signalsmith-stretch" ] || git clone -q --depth 1 -b "$STRETCH_TAG" https://github.com/Signalsmith-Audio/signalsmith-stretch.git "$WORK/signalsmith-stretch"
[ -d "$WORK/signalsmith-linear" ] || git clone -q --depth 1 -b "$LINEAR_TAG" https://github.com/Signalsmith-Audio/linear.git "$WORK/signalsmith-linear"

# ---- libopenmpt (static library) -------------------------------------------
if [ ! -f "$WORK/libopenmpt/bin/libopenmpt.a" ]; then
  make -C "$WORK/libopenmpt" -j"$(nproc)" CONFIG=emscripten EMSCRIPTEN_TARGET=wasm \
    SHARED_LIB=0 STATIC_LIB=1 EXAMPLES=0 OPENMPT123=0 TEST=0
fi

# ---- link everything into one ES module ------------------------------------
mkdir -p "$ROOT/js/wasm"
em++ -O3 -std=c++17 \
  -I "$WORK/libopenmpt" \
  -I "$WORK/signalsmith-stretch" \
  -I "$WORK" \
  "$ROOT/native/modpod_dsp.cpp" "$WORK/libopenmpt/bin/libopenmpt.a" \
  -o "$ROOT/js/wasm/modpod-dsp.js" \
  -sWASM=1 -sSINGLE_FILE=1 -sWASM_ASYNC_COMPILATION=0 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createModpodDsp \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
  -sDISABLE_EXCEPTION_CATCHING=0 \
  -sTEXTDECODER=1 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,UTF8ToString

ls -la "$ROOT/js/wasm/modpod-dsp.js"
