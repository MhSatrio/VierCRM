import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Extension pages (side panel, full-page app) + the background service worker. The content script is built separately
// (vite.content.config.ts) because content scripts cannot be ES modules.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
        app: resolve(import.meta.dirname, 'app.html'),
        background: resolve(import.meta.dirname, 'src/background/background.ts'),
      },
      output: { manualChunks(id) { if (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return 'react'; }, entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
});
