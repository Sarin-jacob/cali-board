// Export formats: structure checks, round trips, and OpenCV FileStorage compatibility.
// Run: node tests/exporters.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { exportAs, fromJSON, fromOpenCVYaml, toCOLMAP, FORMATS } from '../src/calib/exporters.js';

const require = createRequire(import.meta.url);
const cv = await require('../scripts/load-opencv.cjs')();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

const pinhole = {
  name: 'Test Cam 1', createdAt: Date.UTC(2026, 9, 5), imageSize: { width: 1280, height: 720 },
  model: 'pinhole', distortion: 'standard4', K: [910.18, 0, 646.76, 0, 904.98, 351.95, 0, 0, 1], D: [-0.268, 0.0827, 0.0012, -0.0012, 0],
  rms: 0.239, stdDevs: { fx: 0.5 }, views: [{ n: 1, rms: 0.2, rvec: [0.1, 0.2, 0.3], tvec: [1, 2, 300], used: 70 }, { n: 2, rms: 0.3, rvec: [0, 0, 0], tvec: [0, 0, 400], used: 60 }],
  target: { type: 'charuco' }, stats: { views: 2, points: 130, coverage: 0.8, removedPoints: 0 },
};
const fisheye = { ...pinhole, model: 'fisheye', distortion: 'fisheye', K: [300, 0, 481, 0, 300.5, 268, 0, 0, 1], D: [0.04, -0.012, 0.004, -0.0011] };
const rational = { ...pinhole, distortion: 'rational', D: [-0.2, 0.05, 0.001, 0.002, -0.01, 0.01, -0.005, 0.002] };

await test('Every format renders for pinhole, rational and fisheye results', async () => {
  for (const r of [pinhole, fisheye, rational]) for (const f of FORMATS) {
    const s = exportAs(r, f.id, { name: 'cam', newK: r.K });
    assert.ok(s.length > 50 && !s.includes('undefined') && !s.includes('NaN'), `${f.id} for ${r.distortion}`);
  }
});

await test('OpenCV YAML follows the cv::FileStorage layout and round-trips', async () => {
  // cv.FileStorage is not bound in this OpenCV.js build, so check the exact layout OpenCV's writer
  // produces (header, !!opencv-matrix blocks, real literals) and parse it back with our importer.
  assert.equal(typeof cv.FileStorage, 'undefined');
  for (const r of [pinhole, fisheye]) {
    const yaml = exportAs(r, 'opencv', { newK: r.K });
    const back = fromOpenCVYaml(yaml);
    assert.deepEqual(back.K, r.K);
    assert.deepEqual(back.D, r.model === 'fisheye' ? r.D : [...r.D]);
    assert.equal(back.model, r.model);
    assert.equal(back.imageSize.width, 1280);
    assert.ok(Math.abs(back.rms - r.rms) < 1e-12);
    assert.ok(yaml.startsWith('%YAML:1.0\n---\n'));
    assert.match(yaml, /camera_matrix: !!opencv-matrix\n {3}rows: 3\n {3}cols: 3\n {3}dt: d\n {3}data: \[ [\d.]+, 0\., [\d.]+, 0\., [\d.]+, [\d.]+, 0\., 0\., 1\. \]/);
  }
  assert.match(exportAs(pinhole, 'opencv'), /data: \[ 910\.18, 0\., 646\.76, 0\., 904\.98, 351\.95, 0\., 0\., 1\. \]/);
  assert.match(exportAs(fisheye, 'opencv'), /fisheye_model: 1/);
});

await test('JSON round-trips through the importer', async () => {
  const back = fromJSON(exportAs(pinhole, 'json'));
  assert.deepEqual(back.K, pinhole.K);
  assert.deepEqual(back.D, pinhole.D);
  assert.equal(back.views.length, 2);
  assert.equal(back.rms, pinhole.rms);
  assert.throws(() => fromJSON('{"hello": 1}'));
});

await test('ROS camera_info uses the right distortion model names', async () => {
  assert.match(exportAs(pinhole, 'ros', { name: 'My Cam!' }), /camera_name: my_cam\n[\s\S]*distortion_model: plumb_bob[\s\S]*cols: 5/);
  assert.match(exportAs(rational, 'ros'), /distortion_model: rational_polynomial[\s\S]*cols: 8/);
  assert.match(exportAs(fisheye, 'ros'), /distortion_model: equidistant[\s\S]*cols: 4/);
  assert.match(exportAs(pinhole, 'ros'), /projection_matrix:\n {2}rows: 3\n {2}cols: 4\n {2}data: \[910\.18, 0, 646\.76, 0, 0, 904\.98, 351\.95, 0, 0, 0, 1, 0\]/);
});

await test('COLMAP uses the matching camera model and +0.5 px principal point', async () => {
  assert.match(toCOLMAP(pinhole), /^1 OPENCV 1280 720 910\.18 904\.98 647\.26 352\.45 -0\.268 0\.0827 0\.0012 -0\.0012$/m);
  assert.match(toCOLMAP(fisheye), /^1 OPENCV_FISHEYE 1280 720 300 300\.5 481\.5 268\.5 0\.04 -0\.012 0\.004 -0\.0011$/m);
  assert.match(toCOLMAP(rational), /^1 FULL_OPENCV /m);
  assert.match(toCOLMAP({ ...pinhole, D: [0, 0, 0, 0, 0] }), /^1 PINHOLE 1280 720 /m);
});

await test('Kalibr camchain warns when coefficients are dropped', async () => {
  assert.match(exportAs(pinhole, 'kalibr'), /distortion_model: radtan\n {2}distortion_coeffs: \[-0\.268, 0\.0827, 0\.0012, -0\.0012\]/);
  assert.match(exportAs(rational, 'kalibr'), /NOTE: Kalibr radtan supports k1, k2, p1, p2 only/);
  assert.match(exportAs(fisheye, 'kalibr'), /distortion_model: equidistant/);
});

console.log(`exporters: ${passed} tests passed`);
