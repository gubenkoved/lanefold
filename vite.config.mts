import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./src/webview', import.meta.url));

// The webview bundle is loaded by an HTML page the extension generates (with a CSP nonce),
// so the build emits stable names: dist/webview/main.js + dist/webview/main.css.
// `vite build` is the release build; `--mode dev` (npm run build:webview) adds source maps.
export default defineConfig(({ mode }) => ({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/webview', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: mode === 'dev',
    // The licenses of everything bundled (React, motion, codicons…) ship with the extension.
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    reportCompressedSize: false,
    // One bundle read from disk when the view opens: its size costs no download, and splitting it
    // would only add requests through the webview's resource loader.
    chunkSizeWarningLimit: 2048,
    rolldownOptions: {
      input: fileURLToPath(new URL('./src/webview/main.tsx', import.meta.url)),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css')) ? 'main.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
