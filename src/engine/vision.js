// Main-thread client for the OpenCV worker (public/cv-worker.js).
//
// - Starts the worker lazily and reports download/compile progress.
// - Promise-based RPC: `await vision.call('calibrate', { req })`.
// - If OpenCV aborts on bad input, the worker reports a fatal error and exits; the next call
//   transparently starts a fresh worker, so one bad frame never breaks the whole app.

const WORKER_URL = () => new URL('cv-worker.js', document.baseURI).href;

class VisionEngine extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.state = 'idle'; // idle | loading | ready | error
    this.progress = { loaded: 0, total: 0 };
    this.statusText = '';
    this.info = null;
    this.error = null;
    this.pending = new Map();
    this.seq = 0;
    this.restarts = 0;
    this._ready = null;
  }

  _set(state, extra = {}) {
    Object.assign(this, extra);
    this.state = state;
    this.dispatchEvent(new CustomEvent('change', { detail: this }));
  }

  /** Starts the worker (once) and resolves with build info when OpenCV is ready. */
  start() {
    if (this._ready) return this._ready;
    this._ready = new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(WORKER_URL());
      } catch (err) {
        this._set('error', { error: `Web Workers are unavailable: ${err.message}` });
        this._ready = null;
        reject(err);
        return;
      }
      this.worker = worker;
      this._set('loading', { progress: { loaded: 0, total: 0 }, statusText: 'Downloading the vision engine…', error: null });

      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          this.progress = { loaded: msg.loaded, total: msg.total };
          this.dispatchEvent(new CustomEvent('change', { detail: this }));
        } else if (msg.type === 'status') {
          this._set('loading', { statusText: msg.text });
        } else if (msg.type === 'ready') {
          this._set('ready', { info: msg.info, statusText: 'Ready' });
          resolve(msg.info);
        } else if (msg.type === 'init-error') {
          this._fail(new Error(msg.error));
          reject(new Error(msg.error));
        } else if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else {
            const err = new Error(msg.error);
            err.fatal = !!msg.fatal;
            p.reject(err);
            if (msg.fatal) this._restart();
          }
        }
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        const err = new Error(e.message || 'The vision worker crashed');
        if (this.state !== 'ready') { this._fail(err); reject(err); }
        else this._restart(err);
      };
    });
    return this._ready;
  }

  _fail(err) {
    this.worker?.terminate();
    this.worker = null;
    this._ready = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this._set('error', { error: err.message });
  }

  _restart(reason) {
    this.worker?.terminate();
    this.worker = null;
    this._ready = null;
    this.restarts++;
    const err = reason || new Error('The vision engine restarted');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this._set('idle', { statusText: 'Restarting…' });
    this.dispatchEvent(new CustomEvent('restart', { detail: { count: this.restarts } }));
    this.start().catch(() => {});
  }

  /** Calls an operation in the worker. `transfer` lists transferable objects (ImageBitmaps, buffers). */
  async call(op, args = {}, transfer = []) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, op, args }, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  get ready() { return this.state === 'ready'; }
  get canDecodeInWorker() { return !!(this.info && this.info.offscreenCanvas && this.info.createImageBitmap); }
}

export const vision = new VisionEngine();

/**
 * Resolves on the next *new* video frame (so loops never re-analyse duplicates), with a timeout
 * fallback: requestVideoFrameCallback and requestAnimationFrame both pause while a page is not
 * being rendered, and a live loop must not stall forever because of that.
 */
export function nextVideoFrame(video, timeoutMs = 250) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    const t = setTimeout(finish, timeoutMs);
    if (video?.requestVideoFrameCallback) video.requestVideoFrameCallback(finish);
    else requestAnimationFrame(finish);
  });
}

/**
 * Grabs the current frame of a <video> (or canvas) in a form the worker can decode, optionally
 * downscaled so its longer side ≤ maxSide. Returns { frame, transfer, width, height, scale }.
 */
export async function grabFrame(source, maxSide = 0) {
  const w = source.videoWidth || source.width, h = source.videoHeight || source.height;
  if (!w || !h) return null;
  const scale = maxSide && Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
  const tw = Math.round(w * scale), th = Math.round(h * scale);
  if (vision.canDecodeInWorker && typeof createImageBitmap === 'function') {
    const bitmap = scale === 1
      ? await createImageBitmap(source)
      : await createImageBitmap(source, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'medium' });
    return { frame: bitmap, transfer: [bitmap], width: tw, height: th, scale };
  }
  // Fallback for browsers without OffscreenCanvas in workers: read pixels on the main thread.
  grabFrame.canvas ??= document.createElement('canvas');
  const c = grabFrame.canvas;
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, tw, th);
  const img = ctx.getImageData(0, 0, tw, th);
  return { frame: { data: img.data, width: tw, height: th }, transfer: [img.data.buffer], width: tw, height: th, scale };
}
