// Camera access via getUserMedia, with clear errors and capability helpers.

export const RESOLUTIONS = [
  { id: '640x480', label: '640 × 480 (VGA)', width: 640, height: 480 },
  { id: '1280x720', label: '1280 × 720 (HD)', width: 1280, height: 720 },
  { id: '1920x1080', label: '1920 × 1080 (Full HD)', width: 1920, height: 1080 },
  { id: '2560x1440', label: '2560 × 1440 (QHD)', width: 2560, height: 1440 },
  { id: '3840x2160', label: '3840 × 2160 (4K)', width: 3840, height: 2160 },
];

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** Lists cameras. Labels are only available after permission has been granted once. */
export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}`, groupId: d.groupId }));
}

/**
 * Opens a camera. Returns { stream, track, settings, capabilities }.
 * The resolution is a request; read `settings.width/height` for what the camera actually delivers.
 */
export async function openCamera({ deviceId, width = 1280, height = 720, facingMode = 'environment' } = {}) {
  if (!window.isSecureContext) {
    const err = new Error('insecure');
    err.name = 'SecurityError';
    throw err;
  }
  if (!cameraSupported()) {
    const err = new Error('unsupported');
    err.name = 'NotSupportedError';
    throw err;
  }
  const video = { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: facingMode };
  // Calibration needs the raw sensor geometry: ask the browser not to crop or stabilise.
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  const track = stream.getVideoTracks()[0];
  let capabilities = {};
  try { capabilities = track.getCapabilities?.() || {}; } catch { /* not supported */ }
  return { stream, track, settings: track.getSettings?.() || {}, capabilities };
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function setTorch(track, on) {
  await track.applyConstraints({ advanced: [{ torch: !!on }] });
}

/** Locks focus where the browser exposes focus control (mostly Android Chrome). */
export async function lockFocus(track, lock) {
  const caps = track.getCapabilities?.() || {};
  if (!caps.focusMode) return false;
  const mode = lock ? (caps.focusMode.includes('manual') ? 'manual' : caps.focusMode.includes('fixed') ? 'fixed' : null) : 'continuous';
  if (!mode || !caps.focusMode.includes(mode)) return false;
  await track.applyConstraints({ advanced: [{ focusMode: mode }] });
  return true;
}

/** Turns getUserMedia failures into actionable sentences. */
export function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera permission was denied. Allow camera access in your browser’s site settings (the icon left of the address bar), then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No matching camera was found. Check that a camera is connected, or choose another camera / resolution.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is busy or blocked — close other apps or tabs that use it (video calls, OBS, other browsers) and try again.';
    case 'SecurityError':
      return 'Browsers only allow camera access on secure pages. Open CaliBoard over https:// (or http://localhost). For phones on your network, run “npm run dev:https”.';
    case 'NotSupportedError':
      return 'This browser does not support camera access. Use a recent Chrome, Edge, Firefox or Safari — or upload photos instead.';
    case 'AbortError':
      return 'The camera failed to start. Unplug and reconnect it, or restart the browser.';
    default:
      return `Could not start the camera: ${err?.message || err}`;
  }
}

/** Resolves when the video element has frames with known dimensions. */
export function videoReady(video, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (video.videoWidth && video.readyState >= 2) { resolve(); return; }
    const done = () => { cleanup(); resolve(); };
    const t = setTimeout(() => { cleanup(); reject(new Error('The camera did not deliver any frames.')); }, timeoutMs);
    const cleanup = () => { clearTimeout(t); video.removeEventListener('loadeddata', done); video.removeEventListener('resize', done); };
    video.addEventListener('loadeddata', done);
    video.addEventListener('resize', done);
  });
}
