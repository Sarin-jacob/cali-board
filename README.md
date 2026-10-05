# CaliBoard — camera calibration in your browser

CaliBoard is a single place to calibrate cameras without installing anything and without a server:
print a target, wave it in front of the camera, and get intrinsics, distortion, stereo extrinsics
and ready-to-use exports. Everything — detection, calibration, undistortion — runs locally in
OpenCV 4.13 compiled to WebAssembly. Images never leave the device.

## What it does

| | |
|---|---|
| **Targets** | ChArUco (incl. legacy layout), checkerboards, ArUco/AprilTag marker grids, marker sheets · 22 dictionaries · vector PDF (auto-tiling that cuts along square edges, scale bar), SVG, PNG with DPI metadata · pixel-exact full-screen display for calibrating against a monitor |
| **Calibrate** | Live camera (device/resolution/torch/focus lock), photo upload (any camera), or a **virtual camera** with known ground truth · ROS-style coverage guidance (X, Y, size, tilt) · auto-capture when the board is still and in a new pose · session survives reloads |
| **Models** | Pinhole with 0–14 coefficients (radial, tangential, rational, thin-prism, tilted) · Kannala–Brandt fisheye · robust outlier rejection |
| **Results** | RMS with grading and advice · ±1σ uncertainties · FOV / 35 mm equivalent · per-view error chart (click to see residual arrows) · residual scatter · distortion map · 3-D board poses · before/after undistortion (also for any photo you drop in) · one-click "exclude bad views & recalibrate" |
| **Exports** | OpenCV YAML · ROS `camera_info` · Kalibr camchain · COLMAP `cameras.txt` · JSON · Python and C++ snippets |
| **Stereo** | Two live cameras, a synchronised virtual rig, or left/right photo sets · `stereoCalibrate` + `stereoRectify` · baseline, rotation, rectification error · rectified preview · OpenCV / ROS / Kalibr / JSON export |
| **Validate** | Live pose with axes and cube on the board, distance and tilt, live reprojection error, undistorted video, metric measurement on the board plane |
| **Library** | Saved calibrations in IndexedDB, import CaliBoard JSON / OpenCV YAML, re-export any time |

It is installable and works offline after the first visit (service worker precaches the app and
the 5 MB engine), and it is built for keyboard and screen-reader use (landmarks, live
announcements, focus management, accessible charts with data tables, reduced-motion support).

## Accuracy

The test-suite renders lens-distorted images with known intrinsics and runs them through the real
pipeline (`npm test`):

| Check | Result |
|---|---|
| ChArUco / checkerboard corner detection error | ≈ 0.07–0.08 px mean (marker grid ≈ 0.2 px) |
| Focal length recovered (pinhole and fisheye) | within 0.04 % (ChArUco, checkerboard), 0.1 % (marker grid) |
| Principal point recovered | within ~0.6 px |
| Stereo baseline (80 mm rig) | within 0.03 mm |
| ChArUco layout vs `cv::aruco::CharucoBoard::generateImage` | pixel-identical |

## Develop

```bash
npm install
npm run dev          # http://localhost:5173
npm run dev:https    # HTTPS on your LAN, so phones can use their cameras
npm test             # geometry, end-to-end calibration, export formats
npm run build        # static site in dist/
npm run preview      # serve the production build
```

Node 20+ is required for the tests.

## Deploy (serverless)

The build is a folder of static files — host it anywhere.

- **GitHub Pages via Actions:** Settings → Pages → Source: *GitHub Actions*. Every push to `main`
  runs the tests and publishes `dist/` (`.github/workflows/deploy.yml`).
- **gh-pages branch:** `npm run deploy` (then set Pages to deploy from the `gh-pages` branch).

Camera access requires HTTPS (or `localhost`), which GitHub Pages provides.

## How it is put together

```
index.html, src/main.js     app shell, hash router, engine status
src/views/                  home, targets, calibrate, results, stereo, validate, library, help
src/targets/                target model (geometry, object points), dictionaries, PDF/SVG/PNG
src/calib/                  sessions, coverage, solver orchestration, quality, exporters,
                            camera models (JS), synthetic camera, stereo helpers, library
src/sources/                getUserMedia cameras, virtual camera (+ its render worker)
src/engine/vision.js        promise RPC to the OpenCV worker, auto-restart, frame grabbing
public/cv-worker.js         Web Worker: loads OpenCV.js with download progress, decodes frames
public/cv-core.js           all OpenCV calls (detection, calibration, stereo, undistortion)
public/opencv/              OpenCV 4.13 WebAssembly build (see opencv-build/README.md)
tests/                      Node tests against the same OpenCV build and the same core code
```

Design rules worth knowing:

- **The JS target model is the single source of truth** for layouts and object points; OpenCV only
  detects. Renderer, detector and solver therefore cannot disagree about a board.
- **OpenCV runs in a worker**, so the UI never freezes, and because this build aborts on invalid
  input (no C++ exception support), inputs are validated first and the worker is restarted after
  an abort. Details and other workarounds: [`opencv-build/README.md`](opencv-build/README.md).

## Roadmap

- Circle-grid targets and hand-eye calibration (need `findCirclesGrid` / `calibrateHandEye` —
  included in `opencv-build/opencv_js.config.py` for the next engine build).
- Video-file import with automatic frame selection.
- Multi-camera rigs (more than two cameras) and camera–projector calibration.

## Credits

OpenCV (Apache-2.0) compiled to WebAssembly · jsPDF (MIT) · Tailwind CSS (MIT) · Vite (MIT).
