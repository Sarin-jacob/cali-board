#!/usr/bin/env bash
# Rebuilds public/opencv/opencv4.13.js + opencv4.13_js.wasm with Docker and the official emsdk image.
#
#   ./opencv-build/build.sh                 # OpenCV 4.13.0, SIMD, catchable exceptions
#   OPENCV_VERSION=4.x ./opencv-build/build.sh
#
# Afterwards run `npm test` and the in-app self-test (Guide → Engine & self-test).
# NOTE: written from OpenCV's documented build_js.py options; adjust EMSDK_IMAGE if a newer
# Emscripten release breaks the OpenCV build.
set -euo pipefail

OPENCV_VERSION="${OPENCV_VERSION:-4.13.0}"
EMSDK_IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:4.0.10}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/.opencv-build"

mkdir -p "$WORK"
if [ ! -d "$WORK/opencv" ]; then
  git clone --depth 1 --branch "$OPENCV_VERSION" https://github.com/opencv/opencv.git "$WORK/opencv"
fi

# --enable_exception : OpenCV errors become catchable JS exceptions instead of aborting WebAssembly
# --simd             : WebAssembly SIMD (all current browsers) — markedly faster detection
# No --threads: that needs cross-origin isolation headers, which GitHub Pages cannot send.
docker run --rm \
  -v "$WORK":/work \
  -v "$ROOT/opencv-build":/cfg:ro \
  -e OPENCV_SRC=/work/opencv \
  -w /work/opencv \
  "$EMSDK_IMAGE" \
  emcmake python3 platforms/js/build_js.py /work/build_js \
    --build_wasm --disable_single_file --simd --enable_exception \
    --config /cfg/opencv_js.config.py \
    --cmake_option="-DBUILD_LIST=core,imgproc,calib3d,features2d,flann,objdetect,photo,video,js" \
    --build_flags="-s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB"

cp "$WORK/build_js/bin/opencv.js" "$ROOT/public/opencv/opencv4.13.js"
cp "$WORK/build_js/bin/opencv_js.wasm" "$ROOT/public/opencv/opencv4.13_js.wasm"
echo "Copied the new build into public/opencv/. The worker loads the .wasm by file name, so the"
echo "module's internal wasm name does not matter. Update EXPECTED_WASM_BYTES in public/cv-worker.js"
echo "(progress-bar fallback only): $(wc -c < "$ROOT/public/opencv/opencv4.13_js.wasm") bytes."
echo "Then regenerate the dictionary table: npm run dictionaries"
