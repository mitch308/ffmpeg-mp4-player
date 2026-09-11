// test/server.test.ts — startServer 本进程模式生命周期
import { describe, test, expect, afterEach } from 'vitest';
import { startServer } from '../src/index';
import { getSessionCount } from '../src/lib/session-manager';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import { ensureSamples } from './helpers/samples';
import { getFfmpegPath } from '../src/lib/ffmpeg-path';

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

  test('stop() 在存在活跃流会话时也能返回（先销毁会话再关闭监听）', async () => {
    // 源必须永不 EOF，否则 ffmpeg 播完自然退出、流关闭、无法复现死锁：
    // 把 1 秒样本 remux 成 faststart mp4，经一个"读到底也不 end 响应"的
    // 阻塞 HTTP 服务提供，ffmpeg 读完文件后会一直阻塞在读取上
    const samples = ensureSamples();
    const dir = mkdtempSync(path.join(tmpdir(), 'ffmpeg-player-stall-'));
    const faststartPath = path.join(dir, 'faststart.mp4');
    execFileSync(getFfmpegPath(), [
      '-v', 'error',
      '-i', samples.h264Aac,
      '-c', 'copy', '-movflags', '+faststart',
      '-y', faststartPath
    ], { stdio: 'pipe' });
    const fileBytes = readFileSync(faststartPath);

    const stallServer = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'video/mp4');
      res.write(fileBytes); // 刻意不 end()：chunked 响应保持打开，ffmpeg 读阻塞
    });
    await new Promise<void>((resolve) => stallServer.listen(0, '127.0.0.1', resolve));
    const stallUrl = `http://127.0.0.1:${(stallServer.address() as import('net').AddressInfo).port}/video.mp4`;

    const player = await startServer({ port: 0 });
    let stream: Response | null = null;
    try {
      const create = await fetch(`${player.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: stallUrl })
      });
      expect(create.ok).toBe(true);
      const { sessionId } = (await create.json()) as { sessionId: string };

      // 流响应头到达即说明 ffmpeg 已写出 init segment、会话处于活跃流状态
      stream = await fetch(`${player.url}/api/sessions/${sessionId}/stream`);
      expect(stream.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 300)); // 等待流稳定建立

      // stop() 必须能在 3 秒内返回；旧实现会因 close 回调永不触发而超时
      const stopPromise = player.stop().catch(() => {});
      let timedOut = false;
      await Promise.race([
        stopPromise,
        new Promise((_, reject) => setTimeout(() => { timedOut = true; reject(new Error('stop() 3 秒未返回（死锁）')); }, 3000))
      ]);
      expect(timedOut).toBe(false);
    } finally {
      await stream?.body?.cancel().catch(() => {});
      await Promise.race([
        player.stop().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000))
      ]);
      stallServer.close();
      stallServer.closeAllConnections?.();
    }
  });

  test('POST /api/sessions 响应含画质档列表与硬编可用性', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples();
    const res = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac })
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.qualities)).toBe(true);
    expect(body.qualities).toContain('origin');
    expect(typeof body.hwAvailable).toBe('boolean');
    expect(body.requestedQuality).toBe('origin');
    expect(body.requestedMode).toBe('auto');
  });

  test('POST 非法 quality/mode → 400', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples();
    for (const body of [
      { url: samples.h264Aac, quality: '4k' },
      { url: samples.h264Aac, mode: 'gpu' }
    ]) {
      const res = await fetch(`${server.url}/api/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      expect(res.status).toBe(400);
    }
  });

  test('画质档不可用（低清源选高画质）→ 400 且会话不留存', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples(); // 320x240 样本
    const res = await fetch(`${server.url}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac, quality: '1080p' })
    });
    expect(res.status).toBe(400);
    expect(getSessionCount()).toBe(0);
  });

  test('GET /stream 非法 quality/mode 参数 → 400', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples();
    const create = await fetch(`${server.url}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac })
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await fetch(`${server.url}/api/sessions/${sessionId}/stream?start=0&quality=4k`);
    expect(res.status).toBe(400);
  });

  test('GET /stream 请求源不可用的画质档 → 400（错误信息含源分辨率）', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples(); // 320x240 源，无 720p 档
    const create = await fetch(`${server.url}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac })
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await fetch(`${server.url}/api/sessions/${sessionId}/stream?start=0&quality=720p`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('320x240');
  });

  test('静态服务覆盖 public/（demo 页）', async () => {
    server = await startServer({ port: 0 });
    const demo = await fetch(`${server.url}/index.html`);
    expect(demo.ok).toBe(true);
  });

  test('dist/client/ 静态服务可访问 player.html（前端构建产物）', async () => {
    server = await startServer({ port: 0 });
    // 依赖本任务建立的构建链产出 dist/client/player.html
    const player = await fetch(`${server.url}/player.html`);
    expect(player.ok).toBe(true);
    // 断言构建产物特征（带 hash 的 /assets/player-*.js 引用）而非源码模板的
    // ./player-entry.ts——若命中后者，说明静态服务指向了未编译的前端源码目录
    const html = await player.text();
    expect(html).toContain('/assets/player-');
    expect(html).not.toContain('player-entry.ts');
  });
});
