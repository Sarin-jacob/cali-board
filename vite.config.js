import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` serves over HTTPS with a self-signed certificate. Browsers only allow camera
// access on secure origins, so this is how you test on a phone over your local network.
export default defineConfig(({ mode }) => ({
  // Relative base so the static build works from any sub-path (e.g. username.github.io/cali-board/).
  base: './',
  plugins: [tailwindcss(), ...(mode === 'https' ? [basicSsl()] : [])],
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Never inline binaries (the 5 MB OpenCV WebAssembly file lives in public/opencv/).
    assetsInlineLimit: 0,
  },
  server: {
    host: true,
  },
}));
