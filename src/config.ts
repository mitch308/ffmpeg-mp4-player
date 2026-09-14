// src/config.ts — 公共配置类型与默认值
import { EventEmitter } from 'events';
import type { LogFn } from './lib/logger';

export interface PlayerServerOptions {
  /** 监听端口；未配置时从 20000–30000 区间随机选取空闲端口 */
  port?: number;
  /** 绑定地址，默认 127.0.0.1 */
  host?: string;
  /** true 时 fork 子进程运行服务，默认 false */
  childProcess?: boolean;
  /** ffmpeg 可执行文件路径；不传走解析链（显式配置 > 环境变量 > static 包） */
  ffmpegPath?: string;
  /** ffprobe 可执行文件路径；不传走解析链 */
  ffprobePath?: string;
  /** 是否托管 public/ 播放器页面，默认 true */
  staticPlayer?: boolean;
  /**
   * 自定义日志函数（接收 level 与格式化后的消息，含统一前缀 [fmp4]）；
   * 不传默认输出到 console。
   * childProcess: true 时同样生效：函数无法跨进程序列化，子进程日志经 IPC
   * 转发回父进程，由此函数统一输出（stderr 等非 logger 通道输出仍走 stdio inherit）。
   */
  logger?: LogFn;
}

/** 服务生命周期事件负载映射 */
export interface PlayerServerEventMap {
  /** 服务就绪（listen 成功 / 子进程回报端口）。startServer resolve 后异步发出，await 后挂监听可收到 */
  start: [{ port: number; url: string; host: string; childProcess: boolean }];
  /** 首次 stop() 成功完成后发出（会话已销毁/子进程已杀、监听已关闭）；重复 stop 不再发出 */
  stop: [];
  /**
   * 服务异常崩溃：仅子进程模式——子进程意外退出（非 stop() 发起）时发出。
   * 本进程模式与宿主同生共死，不发 crash：服务层可捕获的 error 走日志，
   * 宿主进程级崩溃（uncaughtException/OOM）需宿主自行监听 process 事件兜底。
   */
  crash: [{ code: number | null; signal: string | null; message: string }];
}

/**
 * 播放服务实例：服务元信息 + 生命周期事件（on/once/off，TS 类型约束为已知事件）。
 * stop() 幂等：仅首次调用执行真实关闭，此后直接返回。
 */
export class PlayerServer extends EventEmitter {
  /** 最终监听端口 */
  readonly port: number;
  /** http://host:port */
  readonly url: string;
  /** 子进程模式的子进程 pid；本进程模式为 null（与宿主同进程） */
  readonly pid: number | null;

  private stopped = false;

  constructor(
    port: number,
    url: string,
    pid: number | null,
    private readonly doStop: () => Promise<void>
  ) {
    super();
    this.port = port;
    this.url = url;
    this.pid = pid;
  }

  /** 关闭服务；首次调用执行关闭并发出 stop 事件，重复调用幂等返回 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.doStop();
    this.stopped = true;
    this.emit('stop');
  }

  override on<E extends keyof PlayerServerEventMap>(
    event: E,
    listener: (...args: PlayerServerEventMap[E]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override once<E extends keyof PlayerServerEventMap>(
    event: E,
    listener: (...args: PlayerServerEventMap[E]) => void
  ): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  override off<E extends keyof PlayerServerEventMap>(
    event: E,
    listener: (...args: PlayerServerEventMap[E]) => void
  ): this;
  override off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  /** 仅供库内部发出已知生命周期事件，外部不应调用 */
  override emit<E extends keyof PlayerServerEventMap>(
    event: E,
    ...args: PlayerServerEventMap[E]
  ): boolean {
    return super.emit(event, ...(args as never[]));
  }
}

export const DEFAULT_HOST = '127.0.0.1';
