// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 真实 ffmpeg 转码/硬件探测可能较慢
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
