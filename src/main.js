import { initOpenCV } from './core/loader.js';
import { drawCheckerboard } from './generators/checkerboard.js';
import { drawAruco } from './generators/aruco.js';
import { drawCharuco } from './generators/charuco.js';
import { exportTiledPdf } from './generators/pdf.js';
import { startDetector, stopDetector } from './detector/pipeline.js';

let currentTab = 'genCheckerboard';

async function bootstrap() {
  try {
    await initOpenCV();
    
    document.getElementById('loadingStatus').className = "flex items-center bg-emerald-100 text-emerald-800 px-4 py-2 rounded-lg font-bold text-sm";
    document.getElementById('loadingStatus').innerText = "✔ Engine Ready";
    document.getElementById('mainTabs').classList.remove('pointer-events-none', 'opacity-50');

    // Attach Generator Input Handlers
    ['cbCols', 'cbRows', 'cbSize'].forEach(id => document.getElementById(id).addEventListener('input', () => drawCheckerboard()));
    ['arDict', 'arId', 'arSize'].forEach(id => document.getElementById(id).addEventListener('input', () => drawAruco()));
    ['chDict', 'chCols', 'chRows', 'chSqSize', 'chMkSize'].forEach(id => document.getElementById(id).addEventListener('input', () => drawCharuco()));

    // Attach PDF Handlers
    document.getElementById('btnExportCbPdf').addEventListener('click', () => exportTiledPdf('canvasCheckerboard', 'checkerboard'));
    document.getElementById('btnExportArPdf').addEventListener('click', () => exportTiledPdf('canvasAruco', 'aruco'));
    document.getElementById('btnExportChPdf').addEventListener('click', () => exportTiledPdf('canvasCharuco', 'charuco'));

    // Populate Dictionaries
    const dicts = ['DICT_4X4_50', 'DICT_4X4_250', 'DICT_5X5_50', 'DICT_5X5_250', 'DICT_6X6_50', 'DICT_6X6_250', 'DICT_ARUCO_ORIGINAL'];
    ['arDict', 'chDict'].forEach(selectId => {
      const sel = document.getElementById(selectId);
      dicts.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d; opt.text = d;
        if (d === 'DICT_6X6_250') opt.selected = true;
        sel.appendChild(opt);
      });
    });

    // Initial Renders
    drawCheckerboard();
    drawAruco();
    drawCharuco();

    // Camera Toggle Handler
    let camActive = false;
    document.getElementById('btnToggleCamera').addEventListener('click', async () => {
      const videoEl = document.getElementById('videoInput');
      if (!camActive) {
        await startDetector(videoEl);
        camActive = true;
        document.getElementById('btnToggleCamera').innerText = "Stop Camera Feed";
        document.getElementById('btnToggleCamera').className = "w-full py-3 bg-red-600 text-white font-bold rounded-lg shadow";
      } else {
        stopDetector();
        camActive = false;
        document.getElementById('btnToggleCamera').innerText = "Start Camera Feed";
        document.getElementById('btnToggleCamera').className = "w-full py-3 bg-emerald-600 text-white font-bold rounded-lg shadow";
      }
    });

  } catch (err) {
    console.error("Bootstrap Failure:", err);
    document.getElementById('loadingStatus').className = "flex items-center bg-red-100 text-red-800 px-4 py-2 rounded-lg font-bold text-sm";
    document.getElementById('loadingStatus').innerText = "✖ Engine Initialization Failed";
  }
}

window.addEventListener('DOMContentLoaded', bootstrap);