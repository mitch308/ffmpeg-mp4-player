// test/server.test.ts — startServer 本进程模式生命周期
import { describe, test, expect, afterEach } from 'vitest';
import { startServer } from '../src/index';
import { getSessionCount } from '../src/lib/session-manager';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { ensureSamples } from './helpers/samples';

let server: Awaited<ReturnType<typeof startServer>> | null = null;
afterEach(async () => { if (server) { await server.stop(); server = null; } });

describe('startServer 本进程模式', () => {
  test('显式端口启动，返回 port/url，/api/status 可访问', async () => {
    server = await startServer({ port: 0 }); // 0 = 由 listen 随机分配，仅测生命周期
    const res = await fetch(`${server.url}/api/status`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty('hw');
  });

  test('stop() 后端口不再可访问', async () => {
    const s = await startServer({ port: 0 });
    const url = s.url;
    await s.stop();
    server = null;
    await expect(fetch(`${url}/api/status`)).rejects.toThrow();
  });

  test('显式端口被占时报 EADDRINUSE，不静默换端口', async () => {
    const s = await startServer({ port: 0 });
    try {
      await expect(startServer({ port: s.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally { await s.stop(); }
  });

  test('未配置端口时从 20000–30000 随机选取', async () => {
    server = await startServer({ host: '127.0.0.1' });
    expect(server.port).toBeGreaterThanOrEqual(20000);
    expect(server.port).toBeLessThanOrEqual(30000);
  });

  test('二进制路径配置无效时启动即报错，不留下监听', async () => {
    await expect(startServer({ ffmpegPath: 'C:/不存在的ffmpeg.exe' }))
      .rejects.toThrow(/ffmpeg/);
    expect(getSessionCount()).toBe(0);
  });
});
