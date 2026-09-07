// vite.config.child.ts
// 子进程入口单独构建：fork 需要确定的单文件路径，固定产出 dist/child.cjs
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
    // public/ 经 package files 直接发布，拷进 dist/ 只会让包体积翻倍（详见 vite.config.ts）
    copyPublicDir: false,
    lib: {
      entry: 'src/child.ts',
      formats: ['cjs'],
      fileName: () => 'child.cjs'
    },
    rollupOptions: { external: isExternal }
  }
});
