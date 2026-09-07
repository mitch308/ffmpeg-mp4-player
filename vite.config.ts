// vite.config.ts
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  // 库代码运行在 Node，禁止 Vite 把 process.env.NODE_ENV 替换为静态值
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
  build: {
    target: 'node18',
    lib: {
      entry: { index: 'src/index.ts' },
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? '[name].mjs' : '[name].cjs')
    },
    rollupOptions: { external: [/^node:/, 'express'] }
  },
  // outDirs 双格式声明：esm → index.d.mts，cjs → index.d.cts（vite-plugin-dts 5.x 默认只产出 index.d.ts）
  plugins: [
    dts({
      entryRoot: 'src',
      include: ['src'],
      outDirs: [
        { dir: 'dist', moduleFormat: 'esm' },
        { dir: 'dist', moduleFormat: 'cjs' }
      ]
    })
  ]
});
