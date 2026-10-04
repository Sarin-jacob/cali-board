// Virtual camera: a simulated lens filming the target, exposed as a normal MediaStream so the
// whole app (detection, capture, calibration) runs exactly as with real hardware — and the true
// intrinsics are known, so results can be checked against ground truth.

const W = 960, H = 540;

export const LENSES = {
  webcam: {
    label: 'Webcam — ≈65° view, mild barrel distortion',
    calib: { model: 'pinhole', K: [760, 0, 483.5, 0, 758, 268.2, 0, 0, 1], D: [-0.12, 0.06, 0.0006, -0.0004, 0], imageSize: { width: W, height: H } },
    suggest: { model: 'pinhole', distortion: 'standard4' },
  },
  wide: {
    label: 'Action camera — ≈100° view, strong barrel distortion',
    calib: { model: 'pinhole', K: [405, 0, 476.2, 0, 404, 271.8, 0, 0, 1], D: [-0.3, 0.1, 0.0009, -0.0006, -0.015], imageSize: { width: W, height: H } },
    suggest: { model: 'pinhole', distortion: 'standard5' },
  },
  fisheye: {
    label: 'Fisheye — ≈170° view (Kannala–Brandt)',
    calib: { model: 'fisheye', K: [300, 0, 481, 0, 300.5, 268, 0, 0, 1], D: [0.04, -0.012, 0.004, -0.0011], imageSize: { width: W, height: H } },
    suggest: { model: 'fisheye', distortion: 'fisheye' },
  },
  tele: {
    label: 'Telephoto — ≈28° view, slight pincushion',
    calib: { model: 'pinhole', K: [1900, 0, 480.5, 0, 1900, 270, 0, 0, 1], D: [0.06, -0.3, 0, 0, 0], imageSize: { width: W, height: H } },
    suggest: { model: 'pinhole', distortion: 'radial2' },
  },
};

export class VirtualCamera {
  constructor(lensId, target, { seed = 1 } = {}) {
    this.lens = LENSES[lensId] || LENSES.webcam;
    this.lensId = lensId in LENSES ? lensId : 'webcam';
    this.target = target;
    this.seed = seed;
    this.worker = null;
    this.stream = null;
    this.running = false;
  }

  get groundTruth() { return this.lens.calib; }
  get label() { return `Virtual camera (${this.lens.label.split(' — ')[0].toLowerCase()})`; }

  async start() {
    this.worker = new Worker(new URL('./virtual-worker.js', import.meta.url), { type: 'module' });
    await new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => (e.data.type === 'ready' ? resolve() : e.data.type === 'error' ? reject(new Error(e.data.error)) : null);
      this.worker.onerror = (e) => reject(new Error(e.message || 'Virtual camera failed to start'));
      this.worker.postMessage({ type: 'init', calib: this.lens.calib, target: this.target, seed: this.seed, count: 30 });
    });
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = '#222'; this.ctx.fillRect(0, 0, W, H);
    this.stream = this.canvas.captureStream();
    this.running = true;
    this.t0 = performance.now();
    this.worker.onmessage = (e) => {
      if (e.data.type !== 'frame' || !this.running) { e.data.bitmap?.close?.(); return; }
      this.ctx.drawImage(e.data.bitmap, 0, 0);
      e.data.bitmap.close();
      // ~20 fps cap; the render itself takes ~30–40 ms in the worker.
      const wait = Math.max(0, 50 - (performance.now() - this.lastRequest));
      this.timer = setTimeout(() => this.request(), wait);
    };
    this.request();
    return this.stream;
  }

  request() {
    if (!this.running) return;
    this.lastRequest = performance.now();
    this.worker.postMessage({ type: 'frame', time: (performance.now() - this.t0) / 1000 });
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
