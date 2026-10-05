/* CaliBoard vision worker.
 *
 * Runs OpenCV.js (WebAssembly) off the main thread so the UI stays responsive while frames are
 * analysed and calibrations are solved. Protocol:
 *   main → worker: { id, op, args }
 *   worker → main: { id, ok: true, result } | { id, ok: false, error, fatal }
 *                  { type: 'progress' | 'status' | 'ready' | 'init-error', ... }
 *
 * This OpenCV build aborts (instead of throwing) on failed assertions. After an abort the worker
 * reports `fatal: true` and closes itself; the client transparently starts a fresh one.
 */
'use strict';

const OPENCV_JS = 'opencv/opencv4.13.js';
const OPENCV_WASM = 'opencv/opencv4.13_js.wasm';
const EXPECTED_WASM_BYTES = 5370545; // fallback when the server compresses and hides the real length

let core = null;
let aborted = false;
let abortReason = '';

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const now = () => performance.now();

async function fetchWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the vision engine (${res.status} ${res.statusText})`);
  const encoding = res.headers.get('Content-Encoding');
  const length = Number(res.headers.get('Content-Length')) || 0;
  const total = (!encoding || encoding === 'identity') && length ? length : EXPECTED_WASM_BYTES;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    post({ type: 'progress', loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const t = now();
    if (t - last > 60) { last = t; post({ type: 'progress', loaded, total: Math.max(total, loaded) }); }
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  post({ type: 'progress', loaded, total: loaded });
  return bytes;
}

// Emscripten picks up this global `Module` when the UMD wrapper instantiates OpenCV.
self.Module = {
  instantiateWasm(imports, receiveInstance) {
    fetchWithProgress(new URL(OPENCV_WASM, self.location.href).href)
      .then((bytes) => { post({ type: 'status', text: 'Compiling the vision engine…' }); return WebAssembly.instantiate(bytes, imports); })
      .then((result) => receiveInstance(result.instance, result.module))
      .catch((err) => post({ type: 'init-error', error: (err && err.message) || String(err) }));
    return {};
  },
  onAbort(what) { aborted = true; abortReason = String(what ?? ''); },
  print() {},
  printErr() {},
};

try {
  importScripts(OPENCV_JS, 'cv-core.js');
} catch (err) {
  post({ type: 'init-error', error: `Could not load ${OPENCV_JS}: ${err.message}` });
}

Promise.resolve(self.cv)
  .then((cvModule) => {
    self.cv = cvModule;
    core = self.createCvCore(cvModule);
    const info = core.info();
    info.offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
    info.createImageBitmap = typeof createImageBitmap === 'function';
    post({ type: 'ready', info });
  })
  .catch((err) => post({ type: 'init-error', error: (err && err.message) || String(err) }));

// -------------------------------------------------------------------------------------------
// Image decoding
// -------------------------------------------------------------------------------------------

let scratch = null;
function scratchCtx(w, h) {
  if (!scratch) {
    const canvas = new OffscreenCanvas(w, h);
    scratch = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  if (scratch.canvas.width !== w || scratch.canvas.height !== h) { scratch.canvas.width = w; scratch.canvas.height = h; }
  return scratch.ctx;
}

/** Accepts a Blob/File, ImageBitmap or { data, width, height } and returns RGBA pixels. */
async function decode(src) {
  if (src && src.data && src.width && src.height) return { data: src.data, width: src.width, height: src.height, bitmap: null };
  let bitmap = src;
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    try { bitmap = await createImageBitmap(src, { imageOrientation: 'from-image' }); }
    catch (e) { throw new Error(`Could not decode ${src.name || 'image'} — is it a JPEG/PNG/WebP?`); }
  }
  if (!bitmap || !bitmap.width) throw new Error('Unsupported image source');
  const ctx = scratchCtx(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { data: img.data, width: img.width, height: img.height, bitmap };
}

/** JPEG of `bitmap` scaled so its longer side ≤ maxSide. */
async function encodePreview(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

function rgbaToBitmap(data, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.transferToImageBitmap();
}

function transferables(obj, list = []) {
  if (!obj || typeof obj !== 'object') return list;
  if (ArrayBuffer.isView(obj)) { if (!list.includes(obj.buffer)) list.push(obj.buffer); return list; }
  if (typeof ImageBitmap !== 'undefined' && obj instanceof ImageBitmap) { list.push(obj); return list; }
  if (typeof Blob !== 'undefined' && obj instanceof Blob) return list;
  for (const k in obj) transferables(obj[k], list);
  return list;
}

// -------------------------------------------------------------------------------------------
// Operations
// -------------------------------------------------------------------------------------------

function withGray(img, fn) {
  const gray = core.grayFromRGBA(img.data, img.width, img.height);
  try { return fn(gray); } finally { gray.delete(); }
}

const ops = {
  info() { return core.info(); },

  /** Live detection on one video frame. */
  async detect({ frame, spec, opts }) {
    const img = await decode(frame);
    if (img.bitmap && img.bitmap.close) img.bitmap.close();
    return withGray(img, (gray) => core.detect(gray, spec, opts || { mode: 'live' }));
  },

  /**
   * Accurate analysis of a still (captured frame or uploaded photo): detection, sharpness and
   * JPEG previews for the session gallery.
   */
  async analyze({ source, spec, opts, preview, thumb }) {
    const img = await decode(source);
    const t0 = now();
    const res = withGray(img, (gray) => {
      const det = core.detect(gray, spec, { ...(opts || {}), mode: 'accurate' });
      det.sharpness = det.found ? core.sharpness(gray, det.points) : 0;
      return det;
    });
    res.ms = now() - t0;
    if (img.bitmap) {
      if (preview) res.preview = await encodePreview(img.bitmap, preview.maxSide || 1600, preview.quality || 0.88);
      if (thumb) res.thumb = await encodePreview(img.bitmap, thumb.maxSide || 320, thumb.quality || 0.8);
      if (img.bitmap.close) img.bitmap.close();
    }
    return res;
  },

  calibrate({ req }) { return core.calibrate(req); },
  newCameraMatrix({ calib, alpha, outSize }) { return core.newCameraMatrix(calib, alpha, outSize); },

  /** Undistorts (and optionally rectifies) one image; returns an ImageBitmap when possible. */
  async undistort({ frame, calib, opts, asBitmap = true }) {
    const img = await decode(frame);
    if (img.bitmap && img.bitmap.close) img.bitmap.close();
    const out = core.undistortRGBA(img.data, img.width, img.height, calib, opts || {});
    if (asBitmap && typeof OffscreenCanvas !== 'undefined') {
      return { bitmap: rgbaToBitmap(out.data, out.width, out.height), width: out.width, height: out.height, newK: out.newK };
    }
    return out;
  },

  pose({ obj, img, calib }) { return core.estimatePose({ obj, img, calib }); },
  project({ obj, rvec, tvec, calib }) { return core.projectPoints({ obj, rvec, tvec, calib }); },
  stereoCalibrate({ req }) { return core.stereoCalibrate(req); },
  stereoRectify({ req }) { return core.stereoRectify(req); },
  dispose() { core.dispose(); return true; },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data || {};
  if (id === undefined) return;
  if (!core) { post({ id, ok: false, error: 'Vision engine is not ready yet' }); return; }
  const fn = ops[op];
  if (!fn) { post({ id, ok: false, error: `Unknown operation ${op}` }); return; }
  try {
    const result = await fn(args || {});
    if (aborted) throw new Error('aborted');
    post({ id, ok: true, result }, transferables(result));
  } catch (err) {
    const fatal = aborted || (err instanceof WebAssembly.RuntimeError);
    const message = fatal
      ? `OpenCV rejected the input during “${op}”${abortReason && abortReason !== 'undefined' ? ` (${abortReason})` : ''}. The vision engine will restart.`
      : (err && err.message) || String(err);
    post({ id, ok: false, error: message, fatal });
    if (fatal) self.close();
  }
};
