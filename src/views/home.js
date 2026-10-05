import { html, render } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const TASKS = [
  { href: '#/calibrate', icon: 'aperture', title: 'Calibrate a camera', text: 'Webcam, phone, action cam, DSLR or drone. Live capture or upload photos. Pinhole and fisheye lenses.', primary: true },
  { href: '#/targets', icon: 'printer', title: 'Make a target', text: 'Checkerboard, ChArUco, AprilTag grids and marker sheets. Exact-size vector PDF, SVG or PNG — or show it on a screen.' },
  { href: '#/calibrate/demo', icon: 'sparkles', title: 'Try it without a camera', text: 'A virtual camera with a known lens lets you learn the whole workflow and see how close the result gets to the truth.' },
  { href: '#/stereo', icon: 'stereo', title: 'Stereo pair', text: 'Find the rotation and baseline between two cameras, rectify, and export for depth estimation.' },
  { href: '#/validate', icon: 'axes', title: 'Validate & measure', text: 'Check a calibration live: pose axes on the board, distance, reprojection error and undistorted video.' },
  { href: '#/library', icon: 'library', title: 'Saved calibrations', text: 'Everything you calibrate is stored in this browser. Re-export to OpenCV, ROS, Kalibr, COLMAP or JSON any time.' },
];

export default {
  title: 'Home',
  mount(root) {
    render(root, html`
      <section class="grid items-center gap-8 py-4 lg:grid-cols-[1.2fr_1fr] lg:py-10">
        <div>
          <p class="eyebrow">Camera calibration, serverless</p>
          <h1 class="mt-2 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">Calibrate any camera, right in your browser.</h1>
          <p class="mt-4 max-w-xl text-lg muted">Print a target, wave it in front of your camera and get its focal length, principal point and lens distortion — with the accuracy of OpenCV and nothing to install.</p>
          <div class="mt-6 flex flex-wrap gap-3">
            <a class="btn btn-primary btn-lg" href="#/calibrate">${icon('aperture')} Start calibrating</a>
            <a class="btn btn-secondary btn-lg" href="#/targets">${icon('printer')} Get a target</a>
          </div>
          <ul class="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm muted">
            <li class="flex items-center gap-1.5">${icon('shield', 'size-4 text-emerald-600')} Private — images never leave your device</li>
            <li class="flex items-center gap-1.5">${icon('cpu', 'size-4 text-indigo-600')} OpenCV 4.13 in WebAssembly</li>
            <li class="flex items-center gap-1.5">${icon('download', 'size-4 text-slate-500')} Works offline once loaded</li>
          </ul>
        </div>
        <ol class="card card-pad grid gap-4" aria-label="How it works">
          ${[
            ['1', 'Print or display a target', 'Exact physical size matters for distances; check it with a ruler.'],
            ['2', 'Capture 15–30 varied views', 'Cover the whole frame, tilt the board, change distance. CaliBoard tells you what is missing.'],
            ['3', 'Calibrate, inspect, export', 'See reprojection error per image, remove outliers, preview undistortion, export in the format you need.'],
          ].map(([n, t, d]) => html`
            <li class="flex gap-3">
              <span class="grid size-8 shrink-0 place-items-center rounded-full bg-indigo-600 text-sm font-bold text-white" aria-hidden="true">${n}</span>
              <div><p class="font-semibold">${t}</p><p class="text-sm muted">${d}</p></div>
            </li>`)}
        </ol>
      </section>

      <section aria-labelledby="tasks-h" class="mt-6">
        <h2 id="tasks-h" class="sr-only">What do you want to do?</h2>
        <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          ${TASKS.map((t) => html`
            <li>
              <a href="${t.href}" class="card card-pad group flex h-full flex-col gap-2 transition-shadow hover:shadow-md ${t.primary ? 'ring-2 ring-indigo-500/60' : ''}">
                <span class="grid size-10 place-items-center rounded-xl ${t.primary ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}">${icon(t.icon, 'size-5')}</span>
                <span class="mt-1 flex items-center gap-1 font-semibold">${t.title} ${icon('chevronRight', 'size-4 opacity-0 transition-opacity group-hover:opacity-100')}</span>
                <span class="text-sm muted">${t.text}</span>
              </a>
            </li>`)}
        </ul>
      </section>

      <section class="mt-10 grid gap-4 md:grid-cols-3" aria-label="Supported features">
        ${[
          ['Targets', 'Checkerboard · ChArUco (incl. legacy layout) · ArUco & AprilTag grids · 22 dictionaries · tiled PDF with scale bar'],
          ['Models', 'Pinhole with 0–14 distortion coefficients (radial, tangential, rational, thin-prism, tilted) · Kannala–Brandt fisheye'],
          ['Exports', 'OpenCV YAML · ROS camera_info · Kalibr camchain · COLMAP cameras.txt · JSON · Python & C++ snippets'],
        ].map(([t, d]) => html`<div class="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><p class="eyebrow">${t}</p><p class="mt-1 text-sm">${d}</p></div>`)}
      </section>`);
  },
};
