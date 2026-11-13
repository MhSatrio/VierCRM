import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The content script is injected on demand with chrome.scripting.executeScript, so it must be one self-contained classic script.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    lib: { entry: resolve(import.meta.dirname, 'src/content/content.ts'), formats: ['iife'], name: 'VierCRMContent', fileName: () => 'content.js' },
    rollupOptions: { output: { extend: true } },
  },
});
