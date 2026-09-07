// vite.config.bin.ts
import { defineConfig } from 'vite';
import { builtinModules } from 'module';

// Node 内置模块（裸名与 node: 前缀都要）与 express 一律外置（详见 vite.config.ts 同注释）
const isExternal = (id: string): boolean =>
  id === 'express' || id.startsWith('node:') || builtinModules.includes(id);

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
      external: isExternal,
      output: { banner: '#!/usr/bin/env node' }
    }
  }
});
