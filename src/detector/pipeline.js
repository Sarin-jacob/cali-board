import { CV_UTILS, matToCanvas } from '../core/utils.js';

let isStreaming = false;
let videoElement = null;
let currentStream = null;
let animFrameId = null;

let src = null, dst = null, gray = null;
let currentMatW = 0, currentMatH = 0;

export async function startDetector(videoEl) {
  videoElement = videoEl;
  const constraints = { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } };
  
  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  videoElement.srcObject = currentStream;
  await videoElement.play();

  isStreaming = true;
  requestAnimationFrame(processFrame);
}

export function stopDetector() {
  isStreaming = false;
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (currentStream) currentStream.getTracks().forEach(track => track.stop());
  
  if (src) { src.delete(); dst.delete(); gray.delete(); src = null; }
  currentMatW = 0; currentMatH = 0;
}

function processFrame() {
  if (!isStreaming) return;

  try {
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    if (vw > 0 && vh > 0) {
      const hiddenCanvas = document.getElementById('hiddenVideoCanvas');
      if (currentMatW !== vw || currentMatH !== vh) {
        currentMatW = vw; currentMatH = vh;
        hiddenCanvas.width = vw; hiddenCanvas.height = vh;

        if (src) { src.delete(); dst.delete(); gray.delete(); }
        src = new cv.Mat(vh, vw, cv.CV_8UC4);
        dst = new cv.Mat(vh, vw, cv.CV_8UC3);
        gray = new cv.Mat(vh, vw, cv.CV_8UC1);
      }

      // Memory-efficient video frame extraction via 2D Canvas Context
      const ctx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(videoElement, 0, 0, vw, vh);
      src.data.set(ctx.getImageData(0, 0, vw, vh).data);

      cv.cvtColor(src, dst, cv.COLOR_RGBA2RGB);
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      const mode = document.getElementById('detectMode').value;
      let nMarkers = 0;

      if (mode === 'checkerboard') {
        const cols = parseInt(document.getElementById('detCbCols').value);
        const rows = parseInt(document.getElementById('detCbRows').value);
        const patternSize = new cv.Size(cols - 1, rows - 1);
        const corners = new cv.Mat();

        try {
          // Bitwise OR flag combination for robust SB matching
          const flags = (cv.CALIB_CB_EXHAUSTIVE || 8) | (cv.CALIB_CB_ACCURACY || 16) | (cv.CALIB_CB_NORMALIZE_IMAGE || 2);
          let found = false;

          try {
            found = cv.findChessboardCornersSB(gray, patternSize, corners, flags);
          } catch (e) {
            const fallbackFlags = (cv.CALIB_CB_ADAPTIVE_THRESH || 1) + (cv.CALIB_CB_NORMALIZE_IMAGE || 2);
            found = cv.findChessboardCorners(gray, patternSize, corners, fallbackFlags);
            if (found) {
              const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS + cv.TERM_CRITERIA_MAX_ITER, 30, 0.1);
              cv.cornerSubPix(gray, corners, new cv.Size(5, 5), new cv.Size(-1, -1), criteria);
            }
          }

          if (found && cv.drawChessboardCorners) {
            cv.drawChessboardCorners(dst, patternSize, corners, found);
            nMarkers = (cols - 1) * (rows - 1);
          }
        } finally {
          corners.delete();
        }
      }

      matToCanvas(dst, 'canvasDetector');
      document.getElementById('detStats').innerText = `${vw}x${vh} | Targets Locked: ${nMarkers}`;
    }
  } catch (err) {
    console.error("Pipeline Frame Exception:", err);
  }

  animFrameId = requestAnimationFrame(processFrame);
}