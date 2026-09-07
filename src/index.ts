// src/index.ts — npm 包公共 API
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { configureBinaries, getFfmpegPath, getFfprobePath, isExecutable } from './lib/ffmpeg-path';
import { destroyAllSessions } from './lib/session-manager';
import { pickFreePort } from './lib/ports';
import { createApp } from './server';
import { PlayerServer, PlayerServerOptions, DEFAULT_HOST } from './config';

export type { PlayerServer, PlayerServerOptions } from './config';

const MAX_PORT_RETRIES = 5;

function listen(app: ReturnType<typeof createApp>, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
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
          await closeServer(server);
          destroyAllSessions();
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

/** 子进程模式：Task 4 实现（本任务先留占位实现，直接抛错） */
async function startChildProcess(options: PlayerServerOptions): Promise<PlayerServer> {
  void options;
  throw new Error('childProcess 模式将在 Task 4 实现');
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
