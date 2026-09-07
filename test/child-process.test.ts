// test/child-process.test.ts — 子进程模式：fork + IPC 端口回报 + stop 杀进程树
import { describe, test, expect, afterEach } from 'vitest';
import { startServer } from '../src/index';
import { isPortFree } from '../src/lib/ports';
import { ensureSamples } from './helpers/samples';

let server: Awaited<ReturnType<typeof startServer>> | null = null;
afterEach(async () => { if (server) { await server.stop(); server = null; } });

describe('startServer 子进程模式', () => {
  test('启动返回端口且服务可用', async () => {
    server = await startServer({ childProcess: true, port: 0 });
    const res = await fetch(`${server.url}/api/status`);
    expect(res.ok).toBe(true);
    const body: any = await res.json();
    expect(body.hw).toBeDefined();
  });

  test('未配置端口时子进程随机选端口并回报给父进程', async () => {
    server = await startServer({ childProcess: true });
    expect(server.port).toBeGreaterThanOrEqual(20000);
    expect(server.port).toBeLessThanOrEqual(30000);
    expect(await fetch(`${server.url}/api/status`)).toBeTruthy();
  });

  test('stop() 杀掉子进程树，端口释放', async () => {
    const s = await startServer({ childProcess: true, port: 0 });
    const port = s.port;
    await s.stop();
    server = null;
    // 给端口释放留一点时间
    await new Promise((r) => setTimeout(r, 300));
    expect(await isPortFree(port, '127.0.0.1')).toBe(true);
  });

  test('子进程模式能完成一次真实转码会话', async () => {
    const samples = ensureSamples();
    server = await startServer({ childProcess: true, port: 0 });
    const create = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac })
    });
    expect(create.ok).toBe(true);
    const { sessionId } = (await create.json()) as { sessionId: string };
    const stream = await fetch(`${server.url}/api/sessions/${sessionId}/stream`);
    expect(stream.ok).toBe(true);
    const buf = Buffer.from(await stream.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // fMP4 init segment 以 ftyp box 开头
    expect(buf.subarray(4, 8).toString('ascii')).toBe('ftyp');
  });
});
