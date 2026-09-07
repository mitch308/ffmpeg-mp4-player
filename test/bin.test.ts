// test/bin.test.ts — CLI 冒烟：spawn dist/bin.cjs，探活后 SIGINT 退出
import { describe, test, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { isPortFree } from '../src/lib/ports';

// npm test 已先 build，dist/bin.cjs 为最新产物
const BIN = path.join(__dirname, '..', 'dist', 'bin.cjs');

describe('CLI', () => {
  test('--port 启动、/api/status 探活、SIGINT 后端口释放且进程退出', async () => {
    // 先占一个随机空闲端口再让给 CLI，避免竞态
    const port = await (async () => {
      // 从不常用区间取值：与 pickFreePort 逻辑一致由服务端自行处理，这里手动探测
      let p = 20000 + Math.floor(Math.random() * 10000);
      while (!(await isPortFree(p, '127.0.0.1'))) p = 20000 + Math.floor(Math.random() * 10000);
      return p;
    })();

    const child = spawn(process.execPath, [BIN, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      // 等待服务就绪
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/status`);
          up = res.ok;
        } catch { /* 未就绪 */ }
      }
      expect(up).toBe(true);
    } finally {
      child.kill('SIGINT');
    }
    // 进程应退出且端口释放
    const exited = await Promise.race([
      new Promise<boolean>((r) => child.once('exit', () => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000))
    ]);
    expect(exited).toBe(true);
    expect(await isPortFree(port, '127.0.0.1')).toBe(true);
  }, 30000);

  test('二进制路径无效时 CLI 报错退出（退出码非 0）', async () => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, FFMPEG_PATH: 'C:/不存在/ffmpeg.exe' },
      stdio: 'ignore'
    });
    const code = await new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    expect(code).not.toBe(0);
  });
});
