// test/pause-alive.test.ts — 验证「客户端暂停读取流 ≠ 会话空闲」：
// 空闲超时注入为 2 秒，客户端停读（模拟暂停）跨越多个超时周期后，
// ffmpeg 进程必须仍然存活、会话不得被销毁（scheduleCleanup 见 process 非空即续期）；
// 阴性对照：断开连接（close → stopStream → process 置空）后，同一超时周期内会话确实被销毁
import { describe, test, expect, afterEach } from 'vitest';
import { startServer } from '../src/index';
import { getSessionCount, getSession, setSessionIdleTimeoutForTests } from '../src/lib/session-manager';
import http from 'http';
import { spawn } from 'child_process';
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

describe('暂停读取流时的进程与会话状态', () => {
  test('空闲超时 2s 下暂停 7s：ffmpeg 存活、会话不销毁；断连后同周期内销毁', async () => {
    // 空闲超时压到 2 秒：暂停 7s = 跨越 3 个超时周期，真实覆盖「超时点到达时进程是否存活」
    setSessionIdleTimeoutForTests(2000);

    // 无限源：lavfi testsrc 实时编码 mpegts 经 HTTP 无限供应。
    // 不能用「读完即挂」的静态 stall 源——copy 策略下 ffmpeg 吐完初始数据就等输入，
    // 客户端第二次 read 会永久挂起，走不到暂停那一步；无限源保证数据持续产出，
    // 客户端停读后背压链（TCP → Node 缓冲 → ffmpeg stdout）才真实成立
    const sources = new Set<ReturnType<typeof spawn>>();
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
    const srcUrl = `http://127.0.0.1:${(srcServer.address() as import('net').AddressInfo).port}/video.ts`;

    server = await startServer({ port: 0 });
    const create = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: srcUrl })
    });
    expect(create.ok).toBe(true);
    const { sessionId } = (await create.json()) as { sessionId: string };

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

    for (const src of sources) { try { src.kill('SIGKILL'); } catch { /* 已退出 */ } }
    srcServer.close();
    srcServer.closeAllConnections?.();
  }, 60000);
});
