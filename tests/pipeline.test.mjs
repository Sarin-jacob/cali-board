// End-to-end: render synthetic, lens-distorted views of each target with a known camera, run them
// through the real detection + calibration code (public/cv-core.js), and compare with the truth.
// Run: node tests/pipeline.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { defaultTarget, layoutTarget, objectPoints, normalizeTarget, detectorSpec } from '../src/targets/targets.js';
import { projectPoint, distortNormalized, undistortNormalized, rodrigues, fieldOfView } from '../src/calib/camera-model.js';
import { SyntheticCamera, randomPoses, boardCornersObject } from '../src/calib/synthetic.js';

const require = createRequire(import.meta.url);
const { loadCore } = require('../scripts/load-opencv.cjs');
const core = await loadCore();
const cv = core.cv;

let passed = 0;
const test = async (name, fn) => { const t0 = Date.now(); await fn(); passed++; console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); };

const W = 1280, H = 720;
const PINHOLE = { model: 'pinhole', K: [910, 0, 646.5, 0, 905, 352.25, 0, 0, 1], D: [-0.27, 0.085, 0.0011, -0.0007, 0], imageSize: { width: W, height: H } };
const FISHEYE = { model: 'fisheye', K: [430, 0, 641, 0, 431, 361, 0, 0, 1], D: [0.035, -0.012, 0.004, -0.0012], imageSize: { width: W, height: H } };

await test('JS camera models match OpenCV projectPoints / fisheye_projectPoints', async () => {
  for (const calib of [PINHOLE, { ...PINHOLE, D: [-0.2, 0.05, 0.001, 0.002, -0.01, 0.01, -0.005, 0.002, 0.001, -0.0005, 0.0007, 0.0002] }, FISHEYE]) {
    const pts = [], rvec = [0.2, -0.3, 0.1], tvec = [-40, 25, 600];
    for (let i = 0; i < 50; i++) pts.push((i % 10) * 25 - 100, Math.floor(i / 10) * 25 - 50, 0);
    const obj = Float32Array.from(pts);
    const ref = core.projectPoints({ obj, rvec, tvec, calib });
    const R = rodrigues(rvec);
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const p = projectPoint(calib, R, tvec, obj[3 * i], obj[3 * i + 1], 0);
      worst = Math.max(worst, Math.hypot(p[0] - ref[2 * i], p[1] - ref[2 * i + 1]));
    }
    assert.ok(worst < 1e-3, `${calib.model} projection mismatch ${worst}`);
    // Round trip distort → undistort.
    for (const [x, y] of [[0.1, 0.2], [-0.4, 0.3], [0.6, -0.1]]) {
      const [xd, yd] = distortNormalized(calib, x, y);
      const back = undistortNormalized(calib, xd, yd);
      assert.ok(back && Math.hypot(back[0] - x, back[1] - y) < 1e-8, 'undistort round trip');
    }
  }
  const fov = fieldOfView(FISHEYE);
  assert.ok(fov.horizontal > 120 && fov.horizontal < 180, `fisheye hfov ${fov.horizontal}`);
});

async function runPipeline(label, targetInput, truth, { distortion = 'standard4', views = 14, seed = 11, noise = 2, minFound = 12 } = {}) {
  const target = normalizeTarget(targetInput);
  const layout = await layoutTarget(target);
  const cam = new SyntheticCamera({ calib: truth, target, layout, texScale: 8, supersample: 2 });
  const corners = boardCornersObject(target, layout);
  const poses = randomPoses(views, { calib: truth, target, layout, seed, project: projectPoint, corners, fill: truth.model === 'fisheye' ? 0.45 : 0.55 });
  const spec = detectorSpec(target);
  const collected = [];
  let detErr = [], total = 0;
  for (let i = 0; i < poses.length; i++) {
    const img = cam.render(poses[i], { noise, seed: seed + i, lighting: 0.3 });
    const gray = cv.matFromArray(H, W, cv.CV_8UC1, img);
    const res = core.detect(gray, spec, { mode: 'accurate' });
    gray.delete();
    if (!res.found) continue;
    const obj = objectPoints(target, res.ids);
    // Detection accuracy against the ground truth projection.
    const gt = cam.groundTruth(poses[i], obj, projectPoint);
    for (let k = 0; k < res.points.length / 2; k++) detErr.push(Math.hypot(res.points[2 * k] - gt[2 * k], res.points[2 * k + 1] - gt[2 * k + 1]));
    total += res.points.length / 2;
    collected.push({ obj, img: res.points });
  }
  assert.ok(collected.length >= minFound, `${label}: detected only ${collected.length}/${poses.length} views`);
  detErr.sort((a, b) => a - b);
  const detMean = detErr.reduce((a, b) => a + b, 0) / detErr.length;
  const result = core.calibrate({ views: collected, imageSize: { width: W, height: H }, model: truth.model, distortion });
  const K = result.K, Kt = truth.K;
  const rel = (a, b) => Math.abs(a - b) / b;
  console.log(`    ${label}: ${collected.length}/${poses.length} views, ${total} pts, detection error mean ${detMean.toFixed(3)} px (p95 ${detErr[Math.floor(detErr.length * 0.95)].toFixed(3)}), rms ${result.rms.toFixed(3)} px, ${result.ms.toFixed(0)} ms`);
  console.log(`      fx ${K[0].toFixed(2)} (${Kt[0]})  fy ${K[4].toFixed(2)} (${Kt[4]})  cx ${K[2].toFixed(2)} (${Kt[2]})  cy ${K[5].toFixed(2)} (${Kt[5]})  D ${result.D.slice(0, 5).map((v) => v.toFixed(4)).join(' ')}`);
  assert.ok(detMean < 0.25, `${label}: mean detection error ${detMean.toFixed(3)} px`);
  assert.ok(result.rms < 0.35, `${label}: rms ${result.rms}`);
  assert.ok(rel(K[0], Kt[0]) < 0.004 && rel(K[4], Kt[4]) < 0.004, `${label}: focal length off`);
  assert.ok(Math.abs(K[2] - Kt[2]) < 2 && Math.abs(K[5] - Kt[5]) < 2, `${label}: principal point off`);
  if (result.stdDevs) assert.ok(result.stdDevs.fx > 0 && result.stdDevs.fx < 5, 'std devs present');
  assert.equal(result.views.length, collected.length);
  return result;
}

await test('ChArUco → pinhole calibration recovers ground truth', () => runPipeline('charuco', defaultTarget('charuco'), PINHOLE));
await test('Checkerboard → pinhole calibration recovers ground truth', () => runPipeline('checkerboard', defaultTarget('checkerboard'), PINHOLE));
await test('AprilTag grid → pinhole calibration recovers ground truth', () => runPipeline('gridboard', defaultTarget('gridboard'), PINHOLE));
await test('ChArUco → fisheye calibration recovers ground truth', () => runPipeline('charuco/fisheye', defaultTarget('charuco'), FISHEYE));

await test('Pose estimation recovers the rendered pose', async () => {
  const target = normalizeTarget(defaultTarget('charuco'));
  const layout = await layoutTarget(target);
  const cam = new SyntheticCamera({ calib: PINHOLE, target, layout, texScale: 8, supersample: 2 });
  const [pose] = randomPoses(1, { calib: PINHOLE, target, layout, seed: 99, project: projectPoint, corners: boardCornersObject(target, layout) });
  const gray = cv.matFromArray(H, W, cv.CV_8UC1, cam.render(pose, { noise: 1 }));
  const res = core.detect(gray, detectorSpec(target), { mode: 'accurate' });
  gray.delete();
  const est = core.estimatePose({ obj: objectPoints(target, res.ids), img: res.points, calib: PINHOLE });
  assert.ok(est.ok);
  const dt = Math.hypot(est.tvec[0] - pose.tvec[0], est.tvec[1] - pose.tvec[1], est.tvec[2] - pose.tvec[2]);
  assert.ok(dt < 1.0, `translation error ${dt.toFixed(2)} mm`);
  console.log(`    pose: translation error ${dt.toFixed(3)} mm at ${pose.tvec[2].toFixed(0)} mm, reprojection ${est.rms.toFixed(3)} px`);
});

await test('Invalid input is rejected before reaching OpenCV', async () => {
  assert.throws(() => core.calibrate({ views: [], imageSize: { width: W, height: H } }), /at least 3 views/);
  const flat = { obj: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]), img: new Float32Array([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]) };
  assert.throws(() => core.calibrate({ views: [flat, flat, flat], imageSize: { width: W, height: H } }), /collinear/);
  assert.throws(() => core.detect(new cv.Mat(10, 10, cv.CV_8UC1), { type: 'checkerboard', cols: 2, rows: 5 }), /3 × 3/);
});

console.log(`pipeline: ${passed} tests passed`);
