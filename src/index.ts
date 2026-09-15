// src/index.ts — npm 包公共 API
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { ChildProcess } from 'child_process';
import { fork } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { configureBinaries, getFfmpegPath, getFfprobePath, isExecutable } from './lib/ffmpeg-path';
import { configureLogger, emitRaw, type LogLevel } from './lib/logger';
import { getSessionCount, onSessionCountChange } from './lib/session-manager';
import { createIdleMonitor, getIdleConfirmDelayMs } from './lib/idle-monitor';
import { destroyAllSessions } from './lib/session-manager';
import { pickFreePort } from './lib/ports';
import { killProcessTree } from './lib/kill-tree';
import { createApp } from './server';
import {
  PlayerServer, PlayerServerOptions, DEFAULT_HOST, resolveWaterConfig, type PlayerServerStatus
} from './config';
import { getCaps } from './lib/hw-accel';
import { log } from './lib/logger';

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

/** 本进程模式：同进程内起 express，返回端口与 stop()（child.ts 与 startServer 共用）
 * internal 仅供库内部使用：子进程模式经此接管空闲状态上报（经 IPC 转发父进程）并注入确认延迟 */
export async function startInProcess(
  options: PlayerServerOptions,
  internal: { onIdleChange?: (idle: boolean) => void; idleConfirmMs?: number } = {}
): Promise<PlayerServer> {
  const host = options.host ?? DEFAULT_HOST;
  const water = resolveWaterConfig(options);
  const app = createApp({ staticPlayer: options.staticPlayer, playerConfig: water });
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
      log.info('server', `运行于 http://${host}:${boundPort}`);
      const instance = new PlayerServer(
        boundPort,
        `http://${host}:${boundPort}`,
        null,
        async () => {
          // 先销毁会话再关闭监听：活跃流会话的 HTTP 响应会钉住连接，
          // 而 closeServer 要等所有连接结束；destroyAllSessions 又只在
          // stop() 里被调用——两者互相等待，先关监听必死锁。必须先杀
          // ffmpeg（销毁会话断开响应），closeServer 才能等到连接归零
          destroyAllSessions();
          await closeServer(server);
          // 空闲状态机退订并取消确认定时器：stop 后不得再发 idle/busy 事件
          monitor.stop();
        },
        async () => ({
          childProcess: false,
          // stop() 后会话已清空；进程内状态直接读 Map
          activeSessions: getSessionCount(),
          hw: await getCaps()
        })
      );
      // 空闲/繁忙状态机：口径 = 无任何会话（暂停/断连期间会话始终存在，不误判，
      // 见 test/pause-alive.test.ts）。子进程模式经 internal.onIdleChange 交父进程发事件
      const monitor = createIdleMonitor({
        confirmMs: internal.idleConfirmMs ?? getIdleConfirmDelayMs(),
        watch: onSessionCountChange,
        getCount: () => getSessionCount(),
        onChange: (idle) => {
          instance._setIdle(idle);
          if (internal.onIdleChange) {
            internal.onIdleChange(idle);
            return;
          }
          if (idle) {
            log.info('server', '空闲（无活跃会话）');
            instance.emit('idle');
          } else {
            log.info('server', '恢复繁忙（新会话接入）');
            instance.emit('busy');
          }
        }
      });
      // listen 成功后的意外 error（罕见，如运行期 EADDRINUSE 变体）：仅记 error 日志，
      // 不发事件——本进程模式与宿主同生共死，服务层可捕获的 error 没有独立于日志的
      // 事件语义；启动期的 error（EADDRINUSE 重试等）发生在此监听挂上之前，不受影响
      server.on('error', (err) => {
        log.error('server', `HTTP 服务异常: ${err.message}`);
      });
      // start 延迟一拍发出：await startServer() 的续体是微任务，先于 setImmediate
      // （宏任务）执行，调用方在 await 之后挂的 on('start') 不会错过事件
      setImmediate(() =>
        instance.emit('start', { port: boundPort, url: instance.url, host, childProcess: false })
      );
      return instance;
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
    // 子进程状态缓存：会话数（'sessions' 消息持续上报）与硬件能力（ready 消息携带），
    // 供 getStatus() 使用；硬件缺失时回退父进程自行探测
    let childSessionCount = 0;
    let childHw: PlayerServerStatus['hw'] | null = null;
    // handler 先于 instance 就绪注册：确认期短于子进程硬件探测时长时，
    // idle 消息可能先于 ready 到达——缓存至实例就绪后补发，不得丢弃
    let instance: PlayerServer | null = null;
    let pendingIdle: boolean | null = null;
    const applyIdle = (srv: PlayerServer, idle: boolean): void => {
      srv._setIdle(idle);
      if (idle) {
        log.info('server', '空闲（无活跃会话，子进程上报）');
        srv.emit('idle');
      } else {
        log.info('server', '恢复繁忙（新会话接入，子进程上报）');
        srv.emit('busy');
      }
    };
    const port = await new Promise<number>((resolve, reject) => {
      const onMessage = (msg: unknown) => {
        const m = msg as {
          type?: string; port?: number; message?: string; level?: string;
          idle?: boolean; count?: number; hw?: PlayerServerStatus['hw'];
        };
        if (m?.type === 'ready' && typeof m.port === 'number') {
          if (m.hw) childHw = m.hw;
          resolve(m.port);
        }
        else if (m?.type === 'error') reject(new Error(m.message ?? '子进程启动失败'));
        else if (m?.type === 'sessions' && typeof m.count === 'number') {
          childSessionCount = m.count; // getStatus() 的会话数快照来源
        }
        else if (m?.type === 'idle') {
          if (!instance) {
            pendingIdle = m.idle === true; // 实例未就绪：缓存，就绪后补发
            return;
          }
          // 子进程空闲状态机经 IPC 上报：父进程镜像状态并发事件
          applyIdle(instance, m.idle === true);
        }
        else if (m?.type === 'log') {
          // 子进程日志经 IPC 转发：走本进程配置的日志出口（自定义函数或默认 console）。
          // IPC 保序，且子进程 '运行于' 日志先于 ready 发出，resolve 时已送达
          emitRaw(
            m.level === 'warn' || m.level === 'error' ? (m.level as LogLevel) : 'info',
            typeof m.message === 'string' ? m.message : ''
          );
        }
      };
      child.on('message', onMessage);
      child.once('exit', (code) =>
        reject(new Error(`子进程在就绪前退出（退出码 ${code}）`))
      );
    });
    const host = options.host ?? DEFAULT_HOST;
    log.info('server', `（子进程模式）运行于 http://${host}:${port}`);
    let stopping = false;
    const inst = new PlayerServer(
      port,
      `http://${host}:${port}`,
      child.pid ?? null,
      async () => {
        stopping = true;
        await killChildIfAlive();
      },
      async () => ({
        childProcess: true,
        // 会话在子进程内，父进程用 IPC 上报的缓存计数（毫秒级滞后）
        activeSessions: childSessionCount,
        hw: childHw ?? await getCaps()
      })
    );
    instance = inst;
    // 补发实例就绪前到达的空闲状态（见上方 pendingIdle 注释）。
    // 与 start 事件同理延迟一拍：此时 startServer 尚未 resolve，调用方还没挂监听
    if (pendingIdle !== null) {
      const idle = pendingIdle;
      setImmediate(() => applyIdle(inst, idle));
    }
    // 意外退出（未被 stop() 发起）= 崩溃：发 crash 事件。本监听在 ready 之后才挂上，
    // 启动期退出由上方启动 Promise 的 exit → reject 路径处理，不经此事件
    child.on('exit', (code, signal) => {
      if (stopping) return;
      const message = `子进程意外退出（code=${code} signal=${signal}）`;
      log.error('server', message);
      inst.emit('crash', { code, signal, message });
    });
    // 与本进程模式一致：start 延迟一拍，await 后挂监听不丢事件
    setImmediate(() =>
      inst.emit('start', { port, url: inst.url, host, childProcess: true })
    );
    return inst;
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
  // 日志收口：注入自定义日志函数（不传复位为默认 console）；须最先配置，
  // 使后续路径校验/启动过程的日志都走同一出口
  configureLogger(options.logger);

  // 读泵水位线配置是硬契约：非法立即报错，不静默回退默认值
  resolveWaterConfig(options);

  // 显式配置的路径是硬契约：路径不可用时立即报错。
  // 解析链对无效路径会静默降级到下一级（环境变量/static 包，devDeps 装了 static 包就能解析成功），
  // 但调用方明确传入的路径失效属于配置错误，不能悄悄换用别的来源
  for (const [name, p] of [
    ['ffmpegPath', options.ffmpegPath],
    ['ffprobePath', options.ffprobePath]
  ] as const) {
    if (p != null && !isExecutable(p)) {
      log.error('server', `配置的 ${name} 不可用（文件不存在或不可执行）: ${p}`);
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
