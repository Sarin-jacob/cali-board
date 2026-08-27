import { initOpenCV } from './core/loader.js';
import { getGlobalDPI } from './core/utils.js';
import { drawCheckerboard } from './generators/checkerboard.js';
import { drawAruco } from './generators/aruco.js';
import { drawCharuco } from './generators/charuco.js';
import { exportTiledPdf } from './generators/pdf.js';

// IMPORTANT: Ensure your pipeline.js exports these functions!
import { startDetector, stopDetector } from './detector/pipeline.js';

// ============================================================================
// 1. BRIDGE CORE MODULES TO GLOBAL HTML SCOPE
// ============================================================================
window.drawCheckerboard = drawCheckerboard;
window.drawAruco = drawAruco;
window.drawCharuco = drawCharuco;

// Detector parameter hooks
// window.invalidateDetector = invalidateDetector || function() {};
// window.switchCamera = switchCamera || function() {};
// window.toggleFlash = toggleFlash || function() {};

// ============================================================================
// 2. UI & TAB NAVIGATION
// ============================================================================
window.switchTab = function(tabId) {
    if (tabId !== 'cameraDetector' && window.isStreaming) window.toggleCamera();
    
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('tab-active'));
    document.querySelector(`[onclick="switchTab('${tabId}')"]`).classList.add('tab-active');
    
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById(document.querySelector(`[onclick="switchTab('${tabId}')"]`).dataset.target).classList.remove('hidden');
};

window.downloadCanvas = function(canvasId, filename) {
    const canvas = document.getElementById(canvasId);
    const link = document.createElement('a');
    link.download = filename; 
    link.href = canvas.toDataURL('image/png'); 
    link.click();
};

window.updateDetectorUI = function() {
    const mode = document.getElementById('detectMode').value;
    document.getElementById('detArucoParams').classList.add('hidden');
    document.getElementById('detCharucoParams').classList.add('hidden');
    document.getElementById('detCheckerParams').classList.add('hidden');
    
    if (mode === 'aruco') document.getElementById('detArucoParams').classList.remove('hidden');
    else if (mode === 'charuco') {
        document.getElementById('detArucoParams').classList.remove('hidden');
        document.getElementById('detCharucoParams').classList.remove('hidden');
    } else if (mode === 'checkerboard') document.getElementById('detCheckerParams').classList.remove('hidden');
};

// ============================================================================
// 3. CAMERA LIFECYCLE
// ============================================================================
window.isStreaming = false;

window.toggleCamera = async function() {
    const videoEl = document.getElementById('videoInput');
    const btn = document.getElementById('btnToggleCamera');

    if (!window.isStreaming) {
        try {
            await startDetector(videoEl);
            window.isStreaming = true;
            btn.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path></svg> Stop Camera`;
            btn.className = "w-full py-3 px-4 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold shadow transition-colors flex justify-center items-center gap-2";
        } catch (err) {
            console.error("Camera startup failed:", err);
        }
    } else {
        stopDetector();
        window.isStreaming = false;
        btn.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg> Start Camera`;
        btn.className = "w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold shadow transition-colors flex justify-center items-center gap-2";
    }
};

// ============================================================================
// 4. GLOBAL SETTINGS MODAL
// ============================================================================
window.openSettingsModal = function() { 
    document.getElementById('globalDPI').value = getGlobalDPI(); 
    document.getElementById('settingsModal').classList.remove('hidden'); 
};

window.closeSettingsModal = function() { 
    document.getElementById('settingsModal').classList.add('hidden'); 
};

window.saveSettings = function() {
    const dpi = Math.max(10, parseInt(document.getElementById('globalDPI').value));
    localStorage.setItem('cv_calib_dpi', dpi);
    window.closeSettingsModal();
    drawCheckerboard(); drawAruco(); drawCharuco();
};

// ============================================================================
// 5. PDF TILING MODAL UI LOGIC
// ============================================================================
window.openPdfModal = function(canvasId, baseFilename) {
    document.getElementById('activePdfCanvas').value = canvasId;
    document.getElementById('activePdfFilename').value = baseFilename;
    document.getElementById('pdfModal').classList.remove('hidden');
    window.updatePdfStats();
};

window.closePdfModal = function() { 
    document.getElementById('pdfModal').classList.add('hidden'); 
};

window.updatePdfStats = function() {
    const canvasId = document.getElementById('activePdfCanvas').value;
    if (!canvasId) return;
    
    const canvas = document.getElementById(canvasId);
    const dpi = getGlobalDPI();
    const formatStr = document.getElementById('pdfFormat').value;
    const orientation = document.getElementById('pdfOrientation').value;
    const marginIn = parseFloat(document.getElementById('pdfMargin').value) || 0;

    const imgWInches = canvas.width / dpi;
    const imgHInches = canvas.height / dpi;

    let pageW, pageH;
    if (formatStr === 'a4') { pageW = 8.27; pageH = 11.69; }
    else if (formatStr === 'letter') { pageW = 8.5; pageH = 11.0; }
    else if (formatStr === 'legal') { pageW = 8.5; pageH = 14.0; }
    if (orientation === 'l') { [pageW, pageH] = [pageH, pageW]; }

    const printW = pageW - (marginIn * 2);
    const printH = pageH - (marginIn * 2);

    if (printW <= 0 || printH <= 0) {
        document.getElementById('pdfPreviewStats').innerHTML = `<span class="text-red-600">Margin is too large for the page size.</span>`;
        return;
    }

    const cols = Math.ceil(imgWInches / printW);
    const rows = Math.ceil(imgHInches / printH);
    const totalPages = cols * rows;

    document.getElementById('pdfPreviewStats').innerHTML = 
        `Board Physical Size: <strong>${imgWInches.toFixed(2)}" x ${imgHInches.toFixed(2)}"</strong><br>` +
        `Requires: <strong>${totalPages} page(s)</strong> (${cols} columns x ${rows} rows grid)`;

    // Draw the tiny visual preview in the modal
    const preview = document.getElementById('pdfPreviewCanvas');
    const ctx = preview.getContext('2d');
    const totalPhysW = cols * pageW;
    const totalPhysH = rows * pageH;
    const scale = Math.min(280 / totalPhysW, 180 / totalPhysH);

    preview.width = totalPhysW * scale;
    preview.height = totalPhysH * scale;
    ctx.clearRect(0, 0, preview.width, preview.height);

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const pageX = c * pageW * scale;
            const pageY = r * pageH * scale;
            
            // Draw Paper
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(pageX + 1, pageY + 1, (pageW * scale) - 2, (pageH * scale) - 2);
            ctx.strokeStyle = '#cbd5e1';
            ctx.setLineDash([]);
            ctx.strokeRect(pageX + 1, pageY + 1, (pageW * scale) - 2, (pageH * scale) - 2);

            // Draw Red Margin
            ctx.strokeStyle = '#f87171'; 
            ctx.setLineDash([2, 2]);
            ctx.strokeRect(pageX + (marginIn * scale), pageY + (marginIn * scale), printW * scale, printH * scale);

            // Draw Pattern Data
            const sourceX = c * printW * dpi;
            const sourceY = r * printH * dpi;
            const sWidth = Math.min(printW * dpi, canvas.width - sourceX);
            const sHeight = Math.min(printH * dpi, canvas.height - sourceY);

            if (sWidth > 0 && sHeight > 0) {
                ctx.drawImage(canvas, sourceX, sourceY, sWidth, sHeight, pageX + (marginIn * scale), pageY + (marginIn * scale), (sWidth / dpi) * scale, (sHeight / dpi) * scale);
            }
        }
    }
};

window.generatePdf = async function() {
    const btn = document.getElementById('btnGeneratePdf');
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Processing...';
    btn.disabled = true;

    // Allow UI to update before heavy synchronous PDF generation
    await new Promise(r => setTimeout(r, 50));

    try {
        const canvasId = document.getElementById('activePdfCanvas').value;
        const filename = document.getElementById('activePdfFilename').value;
        const format = document.getElementById('pdfFormat').value;
        const orientation = document.getElementById('pdfOrientation').value;
        const margin = parseFloat(document.getElementById('pdfMargin').value) || 0;
        const dpi = getGlobalDPI();

        // Pass DOM values to the actual PDF engine module
        exportTiledPdf(canvasId, filename, margin, format, orientation, dpi);
        window.closePdfModal();
    } catch (e) {
        console.error(e);
        alert("Error generating PDF: " + e.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
};

// Attach listeners for realtime preview updates
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#pdfFormat, #pdfOrientation, #pdfMargin').forEach(el => { 
        if(el) el.addEventListener('input', window.updatePdfStats); 
    });
});

// ============================================================================
// 6. BOOTSTRAP APP (INITIALIZATION)
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
    try {
        // 1. Populate Dictionary Dropdowns
        const dicts = ['DICT_4X4_50', 'DICT_4X4_100', 'DICT_4X4_250', 'DICT_4X4_1000', 'DICT_5X5_50', 'DICT_5X5_100', 'DICT_5X5_250', 'DICT_5X5_1000', 'DICT_6X6_50', 'DICT_6X6_100', 'DICT_6X6_250', 'DICT_6X6_1000', 'DICT_7X7_50', 'DICT_7X7_100', 'DICT_7X7_250', 'DICT_7X7_1000', 'DICT_ARUCO_ORIGINAL'];
        ['arDict', 'chDict', 'detDict'].forEach(selId => {
            const sel = document.getElementById(selId);
            if(sel) {
                dicts.forEach(d => { 
                    let opt = document.createElement('option'); 
                    opt.value = d; opt.text = d; 
                    if (d === 'DICT_6X6_250') opt.selected = true; 
                    sel.appendChild(opt); 
                });
            }
        });

        // 2. Initialize WebAssembly
        await initOpenCV();
        
        // 3. Update UI to Ready State
        const statusEl = document.getElementById('loadingStatus');
        statusEl.innerHTML = `<svg class="mr-2 h-5 w-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg><span class="font-medium text-sm text-emerald-700">OpenCV Ready</span>`;
        statusEl.className = "flex items-center bg-emerald-50 px-4 py-2 rounded-lg border border-emerald-200 shadow-sm w-full sm:w-auto justify-center";
        
        document.getElementById('mainTabs').classList.remove('pointer-events-none', 'opacity-50');

        // 4. Draw initial patterns
        drawCheckerboard(); 
        drawAruco(); 
        drawCharuco();

    } catch (err) {
        console.error("Initialization error:", err);
        const statusEl = document.getElementById('loadingStatus');
        statusEl.className = "flex items-center bg-red-50 px-4 py-2 rounded-lg border border-red-200 shadow-sm w-full md:w-auto";
        statusEl.innerHTML = `<span class="font-medium text-sm text-red-700">${err.message}</span>`;
    }
});