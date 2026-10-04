// Renders frames for the virtual camera off the main thread.
import { SyntheticCamera, randomPoses, boardCornersObject } from '../calib/synthetic.js';
import { projectPoint, rodrigues, rotationToRodrigues } from '../calib/camera-model.js';
import { layoutTarget } from '../targets/targets.js';

let cam = null;
let keyframes = [];
let frameNo = 0;
let opts = { noise: 1.5, lighting: 0.25, move: 1.4, hold: 1.6 };

const ease = (x) => x * x * (3 - 2 * x);

function poseAt(t) {
  const seg = opts.move + opts.hold;
  const k = Math.floor(t / seg) % keyframes.length;
  const a = keyframes[k], b = keyframes[(k + 1) % keyframes.length];
  const tau = t - Math.floor(t / seg) * seg;
  // Hand tremor: tiny, smooth wobble so "hold still" detection has something real to measure.
  const wob = (f, s) => Math.sin(t * f + s) * 0.0025;
  if (tau < opts.hold) {
    const r = [a.r[0] + wob(5.1, 0), a.r[1] + wob(4.3, 1), a.r[2] + wob(3.7, 2)];
    return { rvec: r, tvec: [a.t[0] + wob(6.2, 3) * 40, a.t[1] + wob(5.6, 4) * 40, a.t[2]] };
  }
  const s = ease((tau - opts.hold) / opts.move);
  return {
    rvec: a.r.map((v, i) => v + (b.r[i] - v) * s),
    tvec: a.t.map((v, i) => v + (b.t[i] - v) * s),
  };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      opts = { ...opts, ...(msg.options || {}) };
      const layout = await layoutTarget(msg.target);
      cam = new SyntheticCamera({ calib: msg.calib, target: msg.target, layout, texScale: 5, supersample: 1 });
      const poses = randomPoses(msg.count || 30, {
        calib: msg.calib, target: msg.target, layout, seed: msg.seed || 1, project: projectPoint,
        corners: boardCornersObject(msg.target, layout), fill: msg.calib.model === 'fisheye' ? 0.42 : 0.5, maxTilt: 0.65, margin: 0.02,
      });
      keyframes = poses.map((p) => ({ r: rotationToRodrigues(p.R), t: p.tvec }));
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'frame' && cam) {
      const pose = poseAt(msg.time);
      const rgba = cam.render({ R: rodrigues(pose.rvec), tvec: pose.tvec }, { rgba: true, noise: opts.noise, lighting: opts.lighting, seed: ++frameNo });
      const bitmap = await createImageBitmap(new ImageData(rgba, cam.width, cam.height));
      self.postMessage({ type: 'frame', bitmap }, [bitmap]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message || String(err) });
  }
};
