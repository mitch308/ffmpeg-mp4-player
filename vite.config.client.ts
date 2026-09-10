// vite.config.client.ts — 播放器前端构建：src/client → dist/client（express 静态服务）。
// 独立于主库三配置（lib/child/bin 均针对 Node 运行时）；前端产物经 server.ts 的
// 静态 fallback（public/ → dist/client/）对外服务。
import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/client', import.meta.url)),
  base: '/',
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: { player: fileURLToPath(new URL('./src/client/player.html', import.meta.url)) }
    }
  }
});
