// test/child-process.test.ts — 子进程模式：fork + IPC 端口回报 + stop 杀进程树
import { describe, test, expect, afterEach } from 'vitest';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { startServer } from '../src/index';
import { isPortFree } from '../src/lib/ports';
import { getSessionCount } from '../src/lib/session-manager';
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

  test('自定义日志函数在子进程模式下同样生效（子进程日志经 IPC 转发）', async () => {
    const received: Array<{ level: string; message: string }> = [];
    server = await startServer({
      childProcess: true,
      port: 0,
      logger: (level, message) => received.push({ level, message })
    });
    // IPC 保序且子进程的「运行于」日志先于 ready 发出：startServer 返回时必已送达。
    // 排除父进程自己的「（子进程模式）运行于」，仅断言来自子进程的日志
    const fromChild = received.filter(
      (r) => r.message.includes('运行于') && !r.message.includes('（子进程模式）')
    );
    expect(fromChild.length).toBeGreaterThan(0);
    expect(fromChild[0].message).toMatch(/^\[fmp4\]\[server\] 运行于 http:\/\//);
  });

  test('子进程模式下生命周期事件同样发出（childProcess: true）', async () => {
    const events: string[] = [];
    let startPayload: { childProcess: boolean } | null = null;
    server = await startServer({ childProcess: true, port: 0 });
    server.on('start', (p) => { events.push('start'); startPayload = { childProcess: p.childProcess }; });
    server.on('stop', () => events.push('stop'));
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(['start']);
    expect(startPayload!.childProcess).toBe(true);
    await server.stop();
    expect(events).toEqual(['start', 'stop']);
  });

  test('子进程意外退出 → crash 事件，崩溃后实例仍可 stop() 清理', async () => {
    server = await startServer({ childProcess: true, port: 0 });
    expect(server.pid).not.toBeNull();
    const crashPromise = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      server!.on('crash', (p) => resolve(p));
      setTimeout(() => reject(new Error('5 秒内未收到 crash 事件')), 5000);
    });
    // 强杀子进程模拟崩溃（Windows 上 SIGKILL 表现为 code=1，POSIX 为 signal=SIGKILL）
    process.kill(server!.pid!, 'SIGKILL');
    const payload = await crashPromise;
    expect(payload.signal === 'SIGKILL' || (payload.code !== null && payload.code !== 0)).toBe(true);
    // 崩溃后实例仍可 stop() 清理（子进程已死，killChildIfAlive 无操作）
    await server.stop();
    server = null;
  });

  test('stop() 发起的子进程退出不触发 crash', async () => {
    server = await startServer({ childProcess: true, port: 0 });
    let crashed = false;
    server.on('crash', () => { crashed = true; });
    await server.stop();
    await new Promise((r) => setTimeout(r, 500));
    expect(crashed).toBe(false);
    server = null;
  });

  test('显式 ffmpegPath 无效时 startServer 拒绝启动（父进程预校验，session 数保持 0）', async () => {
    await expect(
      startServer({ childProcess: true, ffmpegPath: 'C:/不存在的ffmpeg.exe' })
    ).rejects.toThrow(/ffmpeg/);
    expect(getSessionCount()).toBe(0);
  });

  test('子进程侧同样校验显式路径：无效 ffmpegPath 经 IPC 回报 error 并以非零码退出', async () => {
    // 直接 fork dist/child.cjs 绕过父进程预校验，专测子进程自身的 configure+校验契约
    const childEntry = fileURLToPath(new URL('../dist/child.cjs', import.meta.url));
    const child = fork(childEntry, [], {
      stdio: 'ignore',
      env: { ...process.env, FFMPEG_PLAYER_CHILD_OPTIONS: JSON.stringify({ ffmpegPath: 'C:/不存在的ffmpeg.exe' }) }
    });
    const message = await new Promise<{ type: string; message?: string }>((resolve, reject) => {
      child.once('message', (msg) => resolve(msg as { type: string; message?: string }));
      child.once('error', reject);
    });
    // 防泄漏：若子进程误报 ready（已起服务），立即杀掉再让断言失败
    if (message.type !== 'error') child.kill();
    expect(message.type).toBe('error');
    expect(message.message).toMatch(/ffmpeg/);
    const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    expect(code).not.toBe(0);
  });
});
