import { html, render, $, on, fmt } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { vision } from '../engine/vision.js';
import { defaultTarget, normalizeTarget, layoutTarget, detectorSpec, objectPoints } from '../targets/targets.js';
import { SyntheticCamera, randomPoses, boardCornersObject } from '../calib/synthetic.js';
import { projectPoint } from '../calib/camera-model.js';
import { LENSES } from '../sources/virtual.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOC = [
  ['start', 'Quick start'], ['good', 'Getting a great calibration'], ['targets', 'Which target?'], ['models', 'Which lens model?'],
  ['results', 'Reading the results'], ['stereo', 'Stereo tips'], ['trouble', 'Troubleshooting'], ['privacy', 'Privacy & offline use'],
  ['engine', 'Engine & self-test'], ['keys', 'Keyboard'],
];

export default {
  title: 'Guide',
  mount(root, params) {
    render(root, html`
      <div class="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="Guide sections" class="lg:sticky lg:top-20 lg:self-start">
          <p class="eyebrow mb-2">On this page</p>
          <ul class="space-y-1 text-sm">${TOC.map(([id, t]) => html`<li><a class="block rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white" href="#/help/${id}" data-jump="${id}">${t}</a></li>`)}</ul>
        </nav>
        <article class="prose-sm max-w-3xl space-y-10 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:tracking-tight [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:my-1 [&_p]:my-2 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
          <header>
            <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Calibration guide</h1>
            <p class="mt-2 muted">Everything you need to get accurate intrinsics — and to know when you have them.</p>
          </header>

          <section id="start" aria-labelledby="h-start">
            <h2 id="h-start">Quick start</h2>
            <ol>
              <li><a class="text-indigo-600 underline dark:text-indigo-400" href="#/targets">Make a target</a> (the default ChArUco board fits A4/Letter) and print it at <strong>100 % / Actual size</strong>. Check the 50 mm scale bar, then glue it flat onto something rigid.</li>
              <li>Open <a class="text-indigo-600 underline dark:text-indigo-400" href="#/calibrate">Calibrate</a>, start your camera (or upload 15–40 photos), and move the target around. Auto-capture keeps only steady, new positions.</li>
              <li>When the coverage bars are full, press <strong>Calibrate</strong>. Inspect the result, then export it in the format you need.</li>
            </ol>
            <p>No camera at hand? Use the <a class="text-indigo-600 underline dark:text-indigo-400" href="#/calibrate/demo">virtual camera</a>: it simulates a real lens, and the result page compares your estimate with the truth.</p>
          </section>

          <section id="good" aria-labelledby="h-good">
            <h2 id="h-good">Getting a great calibration</h2>
            <ul>
              <li><strong>Flat and rigid beats everything.</strong> A curled sheet of paper adds systematic error no algorithm can remove. Foam board, acrylic, glass or a monitor are ideal.</li>
              <li><strong>Fill the frame, including the corners.</strong> Distortion is strongest at the edges; if the target never reaches them, the model is guessing there. Watch the coverage overlay.</li>
              <li><strong>Tilt the target</strong> 30–45° in different directions. Head-on views alone cannot separate the focal length from the distance.</li>
              <li><strong>Vary the distance</strong> — some views filling the frame, some at half size.</li>
              <li><strong>Hold still</strong> while capturing and use good, diffuse light: motion blur and glare move corners.</li>
              <li><strong>Lock the camera</strong>: fixed focus/zoom, stabilisation off, the resolution you will actually use. Intrinsics change with all of them.</li>
              <li>15–30 well-spread views are plenty. More near-duplicates do not help.</li>
            </ul>
          </section>

          <section id="targets" aria-labelledby="h-targets">
            <h2 id="h-targets">Which target?</h2>
            <div class="overflow-x-auto" tabindex="0" role="region" aria-label="Target comparison table"><table class="table">
              <thead><tr><th>Target</th><th>Partly visible OK?</th><th>Corner accuracy</th><th>Best for</th></tr></thead>
              <tbody>
                <tr><td>ChArUco</td><td>Yes</td><td>Excellent (chessboard corners)</td><td>Almost everything; stereo; wide-angle and fisheye lenses</td></tr>
                <tr><td>Checkerboard</td><td>No — the whole board must be visible</td><td>Excellent</td><td>Narrow lenses; classic OpenCV workflows</td></tr>
                <tr><td>Marker grid (ArUco/AprilTag)</td><td>Yes</td><td>Good (edge-fitted marker corners)</td><td>Kalibr-style pipelines, robotics</td></tr>
              </tbody></table></div>
            <p>Your printed target must match the settings exactly: type, squares, <strong>dictionary</strong>, first id and (for ChArUco) the legacy layout flag. Sizes only affect distances, not focal length or distortion — but they must be right for stereo and pose estimation.</p>
          </section>

          <section id="models" aria-labelledby="h-models">
            <h2 id="h-models">Which lens model?</h2>
            <ul>
              <li><strong>Standard (k1, k2, p1, p2)</strong> — the right choice for most cameras. Start here.</li>
              <li><strong>Standard + k3</strong> — wide-angle lenses (≳ 90°), when the standard model leaves residuals that grow towards the corners. Only with views that reach the corners.</li>
              <li><strong>Rational</strong> — strong, complex distortion (cheap wide lenses). Needs many well-spread views or it over-fits.</li>
              <li><strong>Fisheye (Kannala–Brandt)</strong> — fisheye and ultra-wide lenses (≈ 120°–200°).</li>
              <li><strong>Radial only / No distortion</strong> — telephoto lenses or images that are already rectified.</li>
            </ul>
            <p>If a more complex model lowers the error only marginally, keep the simpler one — it generalises better. CaliBoard warns you when a model folds back inside the image.</p>
          </section>

          <section id="results" aria-labelledby="h-results">
            <h2 id="h-results">Reading the results</h2>
            <ul>
              <li><strong>Reprojection error (RMS)</strong> — the typical distance between a detected corner and where the calibrated model predicts it. &lt; 0.3 px is excellent, &lt; 0.6 px good, up to ~1 px usable. Low RMS alone does not prove accuracy: always check coverage and uncertainty too.</li>
              <li><strong>± values</strong> — 1σ uncertainties from the solver. Focal length better than ±0.3 % is a solid calibration.</li>
              <li><strong>Per-view errors</strong> — one bar much taller than the rest means a bad image (blur, a bent target, a misdetection). Exclude it and recalibrate.</li>
              <li><strong>Residual plot</strong> — should be a round, centred cloud. Stretched or offset clouds point to rolling-shutter motion, a non-flat target or the wrong model.</li>
              <li><strong>Distortion map</strong> — how straight lines bend through your lens and how far pixels move; useful to sanity-check against what you see.</li>
              <li><strong>Validate</strong> — the ultimate test: the cube must stay glued to the board, and measuring a known distance on the board should match a ruler.</li>
            </ul>
          </section>

          <section id="stereo" aria-labelledby="h-stereo">
            <h2 id="h-stereo">Stereo tips</h2>
            <ul>
              <li>Calibrate each camera’s intrinsics first, at the same resolution, then capture pairs where <em>both</em> cameras see the board.</li>
              <li>The board must be still while capturing — webcams are not hardware-synchronised.</li>
              <li>Use ChArUco or a marker grid: matching by id is unambiguous.</li>
              <li>Check the <strong>rectification error</strong>: after rectification, matching points must share a row. Well below 1 px is good.</li>
              <li>The baseline is in the units of your target (millimetres). Measure the target carefully.</li>
            </ul>
          </section>

          <section id="trouble" aria-labelledby="h-trouble">
            <h2 id="h-trouble">Troubleshooting</h2>
            ${[
              ['The camera does not start', 'Camera access needs a secure page (https:// or localhost) and your permission. Check the browser’s site settings, close other apps using the camera, and try another resolution. On a phone over Wi-Fi, run the dev server with “npm run dev:https”.'],
              ['The target is not detected', 'Check that the dictionary, the number of squares/markers and the first id match the print exactly. For ChArUco boards from older tools, try “Legacy layout”. Avoid glare and make sure the white border around the target is visible.'],
              ['The error is high (> 1 px)', 'Usually motion blur, glare or a bent target. (Wrong target sizes do not raise the error — they only scale distances.) Exclude the worst views, use better light, hold still, or try a different lens model.'],
              ['The principal point is far from the centre', 'Common with digitally stabilised or cropped video, and with too few tilted views. Turn stabilisation off and add views tilted in all directions.'],
              ['Different results every time', 'Too few or too similar views. Follow the coverage bars until they are full, and include views close to the corners.'],
              ['“OpenCV rejected the input”', 'This OpenCV build stops on invalid input instead of reporting details. The engine restarts automatically; try removing views with very few points or use a simpler lens model.'],
            ].map(([q, a]) => html`<details class="rounded-xl border border-slate-200 p-3 dark:border-slate-800"><summary class="cursor-pointer font-medium">${q}</summary><p class="text-sm muted">${a}</p></details>`)}
          </section>

          <section id="privacy" aria-labelledby="h-privacy">
            <h2 id="h-privacy">Privacy & offline use</h2>
            <p>CaliBoard is a static website. All image processing happens in your browser with OpenCV compiled to WebAssembly — no image, video or result is ever uploaded. Captured views and saved calibrations live in this browser’s storage (IndexedDB) until you delete them.</p>
            <p>After the first visit the app works offline, and you can install it from the browser menu (“Install app” / “Add to Home Screen”).</p>
          </section>

          <section id="engine" aria-labelledby="h-engine">
            <h2 id="h-engine">Engine & self-test</h2>
            <div id="engine-info" class="text-sm"></div>
            <p class="text-sm">The self-test renders a known virtual lens, runs detection and calibration exactly like a real session, and checks that the recovered focal length matches the truth.</p>
            <button type="button" class="btn btn-primary mt-2" data-selftest>${icon('cpu')} Run self-test</button>
            <div id="selftest" class="mt-3" aria-live="polite"></div>
          </section>

          <section id="keys" aria-labelledby="h-keys">
            <h2 id="h-keys">Keyboard</h2>
            <ul>
              <li><kbd class="rounded border px-1.5 text-xs">Space</kbd> — capture a view (Calibrate, Stereo), when no button or field is focused.</li>
              <li><kbd class="rounded border px-1.5 text-xs">Enter</kbd> on a bar of the per-view chart — inspect that view.</li>
              <li><kbd class="rounded border px-1.5 text-xs">←</kbd> <kbd class="rounded border px-1.5 text-xs">→</kbd> <kbd class="rounded border px-1.5 text-xs">↑</kbd> <kbd class="rounded border px-1.5 text-xs">↓</kbd> and <kbd class="rounded border px-1.5 text-xs">+</kbd>/<kbd class="rounded border px-1.5 text-xs">−</kbd> — orbit and zoom the 3-D pose view.</li>
              <li><kbd class="rounded border px-1.5 text-xs">Esc</kbd> — leave the full-screen target or close a dialog.</li>
            </ul>
          </section>
        </article>
      </div>`);

    on(root, 'click', '[data-jump]', (e, a) => { e.preventDefault(); history.replaceState(null, '', `#/help/${a.dataset.jump}`); $(`#${a.dataset.jump}`, root)?.scrollIntoView({ behavior: 'smooth' }); });
    on(root, 'click', '[data-selftest]', (e, b) => selfTest(root, b));
    renderEngine(root);
    vision.addEventListener('change', this._onEngine = () => renderEngine(root));
    if (params[0]) requestAnimationFrame(() => $(`#${params[0]}`, root)?.scrollIntoView());
  },
  unmount() { if (this._onEngine) vision.removeEventListener('change', this._onEngine); },
};

function renderEngine(root) {
  const box = $('#engine-info', root);
  if (!box) return;
  const i = vision.info;
  render(box, vision.ready ? html`<dl class="kv">
      <dt>OpenCV</dt><dd>${i.version} (WebAssembly)</dd>
      <dt>Modules</dt><dd>${i.modules.join(', ')}</dd>
      <dt>Worker decoding</dt><dd>${i.offscreenCanvas ? 'OffscreenCanvas available' : 'main-thread fallback'}</dd>
      <dt>Restarts</dt><dd>${vision.restarts}</dd>
      ${i.missing.length ? html`<dt>Missing</dt><dd class="text-rose-700 dark:text-rose-400">${i.missing.join(', ')}</dd>` : ''}
    </dl>` : html`<p class="muted">${vision.state === 'error' ? `The engine failed to load: ${vision.error}` : 'The engine is loading…'}</p>`);
}

async function selfTest(root, btn) {
  const out = $('#selftest', root);
  btn.disabled = true;
  const log = [];
  const say = (t) => { log.push(t); render(out, html`<ul class="space-y-1 text-sm">${log.map((l) => html`<li>${l}</li>`)}</ul>`); };
  try {
    const t0 = performance.now();
    await vision.start();
    say('Engine ready.');
    const lens = LENSES.webcam.calib;
    const target = normalizeTarget(defaultTarget('charuco'));
    const layout = await layoutTarget(target);
    const cam = new SyntheticCamera({ calib: lens, target, layout, texScale: 6, supersample: 1 });
    const poses = randomPoses(12, { calib: lens, target, layout, seed: 5, project: projectPoint, corners: boardCornersObject(target, layout) });
    say(`Rendered a virtual ${lens.imageSize.width}×${lens.imageSize.height} lens; analysing 12 views…`);
    const views = [];
    for (let i = 0; i < poses.length; i++) {
      const rgba = cam.render(poses[i], { rgba: true, noise: 1.5, seed: i });
      const bmp = await createImageBitmap(new ImageData(rgba, lens.imageSize.width, lens.imageSize.height));
      const det = await vision.call('analyze', { source: bmp, spec: detectorSpec(target) }, [bmp]);
      if (det.found) views.push({ obj: objectPoints(target, det.ids), img: det.points });
      await sleep(0);
    }
    say(`Detected the target in ${views.length} of 12 views.`);
    const res = await vision.call('calibrate', { req: { views, imageSize: lens.imageSize, model: 'pinhole', distortion: 'standard4' } });
    const err = Math.abs(res.K[0] / lens.K[0] - 1) * 100;
    const pass = views.length >= 10 && err < 0.5 && res.rms < 0.6;
    say(html`Calibrated in ${fmt(res.ms, 0)} ms: RMS ${fmt(res.rms, 3)} px, fx ${fmt(res.K[0], 2)} (true ${lens.K[0]}, error ${fmt(err, 3)} %).`);
    say(html`<strong class="${pass ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}">${pass ? '✓ Self-test passed' : '✗ Self-test failed'}</strong> — total ${fmt((performance.now() - t0) / 1000, 1)} s.`);
  } catch (err) {
    say(html`<span class="text-rose-700 dark:text-rose-400">✗ ${err.message}</span>`);
  } finally {
    btn.disabled = false;
  }
}
