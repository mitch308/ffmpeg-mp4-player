// vite.config.child.ts
// 子进程入口单独构建：fork 需要确定的单文件路径，固定产出 dist/child.cjs
import { defineConfig } from 'vite';

export default defineConfig({
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
  build: {
    target: 'node18',
    emptyOutDir: false,
    lib: {
      entry: 'src/child.ts',
      formats: ['cjs'],
      fileName: () => 'child.cjs'
    },
    rollupOptions: { external: [/^node:/, 'express'] }
  }
});
