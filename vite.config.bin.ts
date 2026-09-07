// vite.config.bin.ts
import { defineConfig } from 'vite';

export default defineConfig({
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
  build: {
    target: 'node18',
    emptyOutDir: false,
    lib: {
      entry: 'src/bin.ts',
      formats: ['cjs'],
      fileName: () => 'bin.cjs'
    },
    rollupOptions: {
      external: [/^node:/, 'express'],
      output: { banner: '#!/usr/bin/env node' }
    }
  }
});
