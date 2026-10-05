import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Files served from public/ that the app needs offline (the build bundle lists the rest).
const PUBLIC_PRECACHE = [
  './', './index.html', './cv-worker.js', './cv-core.js', './favicon.svg', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  './opencv/opencv4.13.js', './opencv/opencv4.13_js.wasm',
];

// jsPDF's optional HTML/SVG renderers (html2canvas, DOMPurify, core-js) are split into lazy chunks
// that CaliBoard never loads — don't make every visitor download them.
const NEVER_PRECACHE = /(^|\/)(html2canvas|purify\.es|index\.es)-[\w-]+\.js$/;

/** Emits sw.js with the exact list of build assets to precache and a content-derived version. */
function serviceWorker() {
  return {
    name: 'caliboard-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !NEVER_PRECACHE.test(f)).map((f) => `./${f}`);
      const files = [...new Set([...PUBLIC_PRECACHE, ...assets])].sort();
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./src/sw.template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(files, null, 2));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// `npm run dev:https` serves over HTTPS with a self-signed certificate. Browsers only allow camera
// access on secure origins, so this is how you test on a phone over your local network.
export default defineConfig(({ mode }) => ({
  // Relative base so the static build works from any sub-path (e.g. username.github.io/cali-board/).
  base: './',
  plugins: [tailwindcss(), serviceWorker(), ...(mode === 'https' ? [basicSsl()] : [])],
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Never inline binaries (the 5 MB OpenCV WebAssembly file lives in public/opencv/).
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
  },
}));
