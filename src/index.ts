// src/index.ts — npm 包公共 API
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { ChildProcess } from 'child_process';
import { fork } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { configureBinaries, getFfmpegPath, getFfprobePath, isExecutable } from './lib/ffmpeg-path';
import { destroyAllSessions } from './lib/session-manager';
import { pickFreePort } from './lib/ports';
import { killProcessTree } from './lib/kill-tree';
import { createApp } from './server';
import { PlayerServer, PlayerServerOptions, DEFAULT_HOST } from './config';

export type { PlayerServer, PlayerServerOptions } from './config';

const MAX_PORT_RETRIES = 5;

// 与 child.cjs 同目录：dist 产物下即包内 dist/child.cjs；
// 源码模式（vitest 跑 src/index.ts）无 dist 兄弟文件，退到源码树旁的 dist/
// CJS 产物中 esbuild 把 import.meta 垫成空对象（import.meta.url → undefined），退回 __filename
function resolveChildEntry(): string {
  const here = path.dirname(
    typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
  );
  const sibling = path.join(here, 'child.cjs');
  if (existsSync(sibling)) return sibling;
  return path.join(here, '../dist/child.cjs');
}

function listen(app: ReturnType<typeof createApp>, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // 空闲 keep-alive 与被未消费响应钉住的 socket 会无限期拖延 close 回调，
    // 必须主动断开剩余连接，否则 close() 永不完成
    server.closeAllConnections?.();
  });
}

/** 本进程模式：同进程内起 express，返回端口与 stop()（child.ts 与 startServer 共用） */
export async function startInProcess(options: PlayerServerOptions): Promise<PlayerServer> {
  const host = options.host ?? DEFAULT_HOST;
  const app = createApp({ staticPlayer: options.staticPlayer });
  const explicit = options.port != null;

  let lastErr: unknown = new Error('未知错误');
  for (let attempt = 0; attempt <= (explicit ? 0 : MAX_PORT_RETRIES); attempt++) {
    // 显式端口直接用（被占则 EADDRINUSE 报错，不静默换端口）；
    // 随机端口先探测空闲再绑定，竞态失败时重试
    const port = explicit
      ? options.port!
      : await pickFreePort(host);
    try {
      const server = await listen(app, port, host);
      // port 为 0 表示由 OS 分配临时端口：回读实际绑定端口，
      // 返回的 port/url 必须反映真实端口（否则调用方拿到 0 无法访问）
      const boundPort = (server.address() as AddressInfo).port;
      console.log(`ffmpeg-mp4-player 运行于 http://${host}:${boundPort}`);
      return {
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        stop: async () => {
          // 先销毁会话再关闭监听：活跃流会话的 HTTP 响应会钉住连接，
          // 而 closeServer 要等所有连接结束；destroyAllSessions 又只在
          // stop() 里被调用——两者互相等待，先关监听必死锁。必须先杀
          // ffmpeg（销毁会话断开响应），closeServer 才能等到连接归零
          destroyAllSessions();
          await closeServer(server);
        }
      };
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
      if (explicit) throw err;
    }
  }
  throw lastErr;
}

/** 子进程模式：fork dist/child.cjs，IPC 回报端口；stop() 杀进程树 */
async function startChildProcess(options: PlayerServerOptions): Promise<PlayerServer> {
  const childEntry = resolveChildEntry();
  if (!existsSync(childEntry)) {
    throw new Error(`未找到 ${childEntry}，请先执行 npm run build`);
  }

  const child: ChildProcess = fork(childEntry, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    detached: true, // POSIX 上使子进程成为组长，便于 kill(-pid) 杀全组
    env: {
      ...process.env,
      FFMPEG_PLAYER_CHILD_OPTIONS: JSON.stringify(options)
    }
  });

  const killChildIfAlive = async (): Promise<void> => {
    // 子进程可能在就绪后自行退出（IPC 断开即退出）；此时 pid 可能已被系统回收复用，
    // 无条件强杀会误杀无关进程。exitCode/signalCode 双检覆盖正常退出与被信号终止两种形态。
    if (child.pid == null || child.exitCode != null || child.signalCode != null) return;
    await killProcessTree(child.pid);
  };

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const onMessage = (msg: unknown) => {
        const m = msg as { type?: string; port?: number; message?: string };
        if (m?.type === 'ready' && typeof m.port === 'number') resolve(m.port);
        else if (m?.type === 'error') reject(new Error(m.message ?? '子进程启动失败'));
      };
      child.on('message', onMessage);
      child.once('exit', (code) =>
        reject(new Error(`子进程在就绪前退出（退出码 ${code}）`))
      );
    });
    const host = options.host ?? DEFAULT_HOST;
    console.log(`ffmpeg-mp4-player（子进程模式）运行于 http://${host}:${port}`);
    return {
      port,
      url: `http://${host}:${port}`,
      stop: async () => {
        await killChildIfAlive();
      }
    };
  } catch (err) {
    // 启动失败兜底清理，不留半启动子进程
    await killChildIfAlive();
    throw err;
  }
}

/**
 * 启动播放服务。
 * 启动前先解析 ffmpeg/ffprobe 路径（缺失立即抛错，不留半启动状态）。
 */
export async function startServer(options: PlayerServerOptions = {}): Promise<PlayerServer> {
  // 显式配置的路径是硬契约：路径不可用时立即报错。
  // 解析链对无效路径会静默降级到下一级（环境变量/static 包，devDeps 装了 static 包就能解析成功），
  // 但调用方明确传入的路径失效属于配置错误，不能悄悄换用别的来源
  for (const [name, p] of [
    ['ffmpegPath', options.ffmpegPath],
    ['ffprobePath', options.ffprobePath]
  ] as const) {
    if (p != null && !isExecutable(p)) {
      throw new Error(`配置的 ${name} 不可用（文件不存在或不可执行）: ${p}`);
    }
  }

  configureBinaries({
    ffmpegPath: options.ffmpegPath ?? null,
    ffprobePath: options.ffprobePath ?? null
  });
  // 触发解析链校验：任一二进制缺失在此抛出明确错误
  getFfmpegPath();
  getFfprobePath();

  if (options.childProcess) return startChildProcess(options);
  return startInProcess(options);
}
