# The OpenCV.js build

CaliBoard ships a custom OpenCV 4.13 WebAssembly build in `public/opencv/` because the official
`opencv.js` leaves out most of `calib3d` (no `calibrateCamera`, no chessboard detection, no stereo,
no fisheye calibration).

## What the bundled build contains

Verified by loading it in Node (`scripts/load-opencv.cjs`) and enumerating its exports:

| Area | Available |
|---|---|
| Modules | core, imgproc, calib3d, features2d, flann, objdetect, photo, video (no dnn) |
| Calibration | `calibrateCamera`, `calibrateCameraExtended` (std devs + per-view errors), `fisheye_calibrate` |
| Stereo | `stereoCalibrate`, `stereoRectify`, `fisheye_stereoCalibrate`, `fisheye_stereoRectify`, `StereoBM`, `StereoSGBM` |
| Targets | `findChessboardCorners`, `findChessboardCornersSB`, `cornerSubPix`, full `aruco_*` API, 22 dictionaries incl. AprilTag |
| Geometry | `solvePnP*`, `projectPoints`, `Rodrigues`, `undistort`, `initUndistortRectifyMap`, `remap`, `getOptimalNewCameraMatrix` (5-argument form) |
| **Missing** | `findCirclesGrid`, `calibrateHandEye`, `undistortPoints`, `fisheye_undistortPoints`, `FileStorage` |

Build flags (from `cv.getBuildInformation()`): Emscripten, `-O3`, no SIMD, no threads, separate
`.wasm` file, **C++ exception catching disabled**.

## Quirks CaliBoard works around

These were found while testing the build; the workarounds live in `public/cv-core.js`.

1. **Errors abort the runtime.** With exception catching disabled, any failed `CV_Assert` calls
   `abort()` instead of throwing a `cv::Exception` with a message. The runtime keeps limping along
   but leaks memory and stack. CaliBoard validates every input before calling OpenCV, runs OpenCV
   in a Web Worker, and restarts that worker after an abort.
2. **`CharucoDetector` corners are biased by ≈ +0.5 px** in x and y. A `cornerSubPix` pass with a
   window kept inside the marker inset removes the bias completely (see `tests/geometry.test.mjs`).
3. **`CharucoBoard.matchImagePoints`** only binds the `MatVector` overload. CaliBoard computes
   object points from ids in JavaScript (`src/targets/targets.js`), verified against OpenCV.
4. **`GridBoard.generateImage` aborts.** Targets are rendered from extracted dictionary bits
   instead (`src/targets/dictionaries.data.js`), pixel-identical to OpenCV's ChArUco renderer.
5. **`getOptimalNewCameraMatrix` with `validPixROI`** is unbound (pointer argument); the
   5-argument form works.
6. **Marker corners** from `ArucoDetector` are biased on blurred images (they are L-corners); an
   edge-line refinement in `cv-core.js` reduces the error ~30 %.

## Rebuilding

`build.sh` rebuilds with Docker and the official `emscripten/emsdk` image, using
`opencv_js.config.py` (the stock whitelist plus the calibration API above):

```bash
./opencv-build/build.sh
npm run dictionaries   # regenerate the marker bit table from the new build
npm test               # geometry, end-to-end calibration and export tests
```

Recommended flags (already in the script):

- `--enable_exception` — real, catchable error messages instead of aborts.
- `--simd` — WebAssembly SIMD; every current browser supports it and detection gets much faster.
- **not** `--threads` — threads need `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`
  headers, which static hosts such as GitHub Pages cannot send.

After rebuilding, open the app → Guide → *Engine & self-test* to confirm the new engine in the
browser. The script has not been run in CI; if a newer Emscripten breaks the OpenCV build,
set `EMSDK_IMAGE` to an older `emscripten/emsdk` tag.
