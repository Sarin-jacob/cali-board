import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
    plugins:[
        tailwindcss()
    ],
    // Use relative base path so assets resolve correctly on GitHub Pages (username.github.io/repo-name)
    base: './',
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        // Ensure large WebAssembly binaries aren't inlined as base64 strings
        assetsInlineLimit: 0,
    },
    server: {
        port: 80,
        host: '0.0.0.0',
    }
});