// test/pause-alive.test.ts — 暂停/断连场景下的进程与会话状态验证
//
// 用例 1（暂停保护）：空闲超时注入为 2 秒，客户端停读（模拟暂停）跨越多个超时周期后，
//   ffmpeg 进程必须仍然存活、会话不得被销毁（scheduleCleanup 见 process 非空即续期）；
//   阴性对照：断开连接（close → stopStream → process 置空）后，同一超时周期内会话确实被销毁。
// 用例 2（半开连接残留）：客户端静默死亡（无 FIN/RST 的半开连接，如断电/拔网线/休眠）时，
//   暂停中的连接探测不到对端死亡——ffmpeg 进程与会话将持续残留（本用例固化该现状）。
import { describe, test, expect, afterEach } from 'vitest';
import { startServer } from '../src/index';
import { getSessionCount, getSession, setSessionIdleTimeoutForTests } from '../src/lib/session-manager';
import http from 'http';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { getFfmpegPath } from '../src/lib/ffmpeg-path';

let server: Awaited<ReturnType<typeof startServer>> | null = null;
afterEach(async () => {
  setSessionIdleTimeoutForTests(5 * 60 * 1000); // 复位，避免污染其他测试
  if (server) { await server.stop(); server = null; }
});

/** 信号 0 探测进程存在性（Windows/POSIX 均支持） */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 轮询等待条件成立（超时抛错） */
async function waitFor(desc: string, cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${desc}`);
}

/**
 * 无限 mpegts 源服务：lavfi testsrc 实时编码经 HTTP 无限供应。
 * 不能用「读完即挂」的静态 stall 源——copy 策略下 ffmpeg 吐完初始数据就等输入，
 * 客户端第二次 read 会永久挂起；无限源保证数据持续产出，停读后背压链才真实成立。
 */
async function startSourceServer(): Promise<{ url: string; killAll(): void; close(): Promise<void> }> {
  const sources = new Set<ChildProcess>();
  const srcServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'video/mp2t');
    const src = spawn(getFfmpegPath(), [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-t', '3600', '-f', 'mpegts', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    sources.add(src);
    src.stdout.pipe(res);
    const cleanup = () => { sources.delete(src); try { src.kill('SIGKILL'); } catch { /* 已退出 */ } };
    _req.on('close', cleanup);
    res.on('close', cleanup);
  });
  await new Promise<void>((resolve) => srcServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(srcServer.address() as import('net').AddressInfo).port}/video.ts`;
  return {
    url,
    killAll: () => { for (const src of sources) { try { src.kill('SIGKILL'); } catch { /* 已退出 */ } } },
    close: () => new Promise((resolve) => srcServer.close(() => resolve()))
  };
}

async function createSession(playerUrl: string, srcUrl: string): Promise<string> {
  const create = await fetch(`${playerUrl}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: srcUrl })
  });
  expect(create.ok).toBe(true);
  return ((await create.json()) as { sessionId: string }).sessionId;
}

describe('暂停读取流时的进程与会话状态', () => {
  test('空闲超时 2s 下暂停 7s：ffmpeg 存活、会话不销毁；断连后同周期内销毁', async () => {
    setSessionIdleTimeoutForTests(2000);
    const src = await startSourceServer();
    server = await startServer({ port: 0 });
    const sessionId = await createSession(server.url, src.url);

    // 读两块（init segment + 若干媒体数据）模拟起播缓冲
    const stream = await fetch(`${server.url}/api/sessions/${sessionId}/stream`);
    expect(stream.ok).toBe(true);
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(false);

    // ===== 正向：模拟暂停 7s（>3 个超时周期），会话必须存活 =====
    await new Promise((r) => setTimeout(r, 7000));
    const session = getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.process).not.toBeNull();
    expect(isPidAlive(session!.process!.pid)).toBe(true);
    expect(getSessionCount()).toBe(1);
    console.log(`[验证] 空闲超时 2s 下暂停 7s（跨 3 个周期）后 ffmpeg pid=${session!.process!.pid} 存活，会话未销毁`);

    // ===== 阴性对照：断开连接（同真实断连路径 close → stopStream → process 置空）=====
    const pid = session!.process!.pid;
    await reader.cancel().catch(() => { /* 已断开 */ });
    // 会话在 2s 超时后销毁
    await waitFor('断连后会话销毁', () => getSession(sessionId) === undefined, 10000);
    expect(getSessionCount()).toBe(0);
    console.log(`[验证] 断连后会话 ${sessionId} 在空闲超时后销毁`);
    // ffmpeg 进程确实被杀（taskkill 异步，轮询等待）
    await waitFor('断连后 ffmpeg 进程退出', () => !isPidAlive(pid), 10000);

    src.killAll();
    await src.close();
  }, 60000);

  test('半开连接（客户端静默死亡）：暂停中的 ffmpeg 进程与会话残留', async () => {
    setSessionIdleTimeoutForTests(2000);
    const src = await startSourceServer();
    server = await startServer({ port: 0 });
    const sessionId = await createSession(server.url, src.url);

    // TCP 冻结代理：客户端经代理连服务端，冻结后双向停止转发但保持 socket 打开——
    // 服务端视角即「无 FIN/RST 的半开连接」，等效于客户端断电/拔网线后的 TCP 状态
    const playerPort = server.port;
    let frozen = false;
    const clientSocks: net.Socket[] = [];
    const upstreamSocks: net.Socket[] = [];
    const proxy = net.createServer((clientSock) => {
      clientSocks.push(clientSock);
      const upstream = net.connect(playerPort, '127.0.0.1');
      upstreamSocks.push(upstream);
      clientSock.on('data', (d) => { if (!frozen) upstream.write(d); });
      upstream.on('data', (d) => { if (!frozen) clientSock.write(d); });
      const cleanup = () => { try { clientSock.destroy(); } catch { /* 已断开 */ } try { upstream.destroy(); } catch { /* 已断开 */ } };
      clientSock.on('close', cleanup);
      upstream.on('close', cleanup);
      clientSock.on('error', cleanup);
      upstream.on('error', cleanup);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as net.AddressInfo).port;

    // 原始 socket 发起流请求（经代理），读够响应头 + 若干媒体数据后冻结代理模拟死亡
    const received: Buffer[] = [];
    let gotData: () => void = () => {};
    const gotDataPromise = new Promise<void>((r) => { gotData = r; });
    const sock = net.connect(proxyPort, '127.0.0.1');
    sock.on('data', (d) => {
      received.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      if (!frozen && Buffer.concat(received).length > 4096) gotData();
    });
    await new Promise<void>((resolve) => sock.once('connect', resolve));
    sock.write(
      `GET /api/sessions/${sessionId}/stream?start=0 HTTP/1.1\r\n` +
      `Host: 127.0.0.1\r\nConnection: close\r\n\r\n`
    );
    await gotDataPromise;
    frozen = true; // 客户端「死亡」：不再读写，但不发 FIN/RST
    console.log(`[验证] 已收到 ${Buffer.concat(received).length} 字节后冻结连接（模拟半开死亡）`);

    // 服务端此刻应已建立 ffmpeg 进程
    const session = getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.process).not.toBeNull();
    const pid = session!.process!.pid;
    await waitFor('流进程启动', () => isPidAlive(pid), 10000);

    // 等待远超多个空闲超时周期（2s × 4）：半开连接探测不到死亡 → 进程与会话残留
    await new Promise((r) => setTimeout(r, 8000));
    expect(getSession(sessionId)).toBeDefined();
    expect(session!.process).not.toBeNull();
    expect(isPidAlive(pid)).toBe(true);
    console.log(`[验证] 半开连接 8s（4 个空闲超时周期）后 ffmpeg pid=${pid} 仍存活，会话仍存在——确认残留`);

    // 残留边界：server.stop() 销毁全部会话，ffmpeg 被杀，不留孤儿
    await server!.stop();
    server = null;
    await waitFor('stop() 后残留 ffmpeg 退出', () => !isPidAlive(pid), 10000);
    console.log('[验证] server.stop() 后残留 ffmpeg 已被杀（残留边界 = 服务生命周期）');

    sock.destroy();
    for (const s of [...clientSocks, ...upstreamSocks]) { try { s.destroy(); } catch { /* 已断开 */ } }
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    src.killAll();
    await src.close();
  }, 60000);
});
