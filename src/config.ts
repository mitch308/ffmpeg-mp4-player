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
  /** 前端读泵高水位（秒）：缓冲领先播放头超过该值暂停读取。默认 45；需大于低水位 */
  readHighWaterSec?: number;
  /** 前端读泵低水位（秒）：缓冲领先回落到该值以下恢复读取。默认 15；需大于 0 且小于高水位 */
  readLowWaterSec?: number;
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
  /** 进入空闲（无任何会话且持续 10s 确认期）；边缘触发，恢复繁忙后重新武装 */
  idle: [];
  /** 从空闲态恢复繁忙（IDLE 态出现新会话时立即发出；确认期内建会不算——从未离开过繁忙态） */
  busy: [];
}

/** 读泵默认水位线（秒）：领先播放头超过高水位暂停读取，回落到低水位以下恢复。
 * 数值与播放器端 pumpReader 的默认值一致，勿单方面改动（见 AGENTS.md 踩坑记录）。 */
export const DEFAULT_READ_HIGH_WATER_SEC = 45;
export const DEFAULT_READ_LOW_WATER_SEC = 15;

/** 服务状态快照（server.getStatus() 返回值） */
export interface PlayerServerStatus {
  /** 最终监听端口 */
  port: number;
  /** http://host:port */
  url: string;
  /** 子进程 pid；本进程模式为 null */
  pid: number | null;
  /** 是否子进程模式 */
  childProcess: boolean;
  /** 是否已 stop()（幂等关闭后恒为 true） */
  stopped: boolean;
  /** 是否处于已确认空闲态（同 isIdle()） */
  idle: boolean;
  /** 当前活跃会话数（子进程模式经 IPC 同步，存在毫秒级滞后） */
  activeSessions: number;
  /** 硬件编码能力 */
  hw: { encoder: string; label: string; mode: string };
  /** 服务运行时长（秒，自实例创建起算） */
  uptimeSec: number;
}

/** 解析并校验读泵水位线配置（非法配置抛错，不静默回退默认值） */
export function resolveWaterConfig(options: Pick<PlayerServerOptions, 'readHighWaterSec' | 'readLowWaterSec'>): {
  readHighWaterSec: number;
  readLowWaterSec: number;
} {
  const high = options.readHighWaterSec ?? DEFAULT_READ_HIGH_WATER_SEC;
  const low = options.readLowWaterSec ?? DEFAULT_READ_LOW_WATER_SEC;
  const valid =
    Number.isFinite(high) && Number.isFinite(low) &&
    high > 0 && low > 0 && high <= 600 && low <= 600 && low < high;
  if (!valid) {
    throw new Error(
      `无效的读泵水位线配置: readHighWaterSec=${options.readHighWaterSec}, ` +
      `readLowWaterSec=${options.readLowWaterSec}（需 0 < low < high ≤ 600，单位秒）`
    );
  }
  return { readHighWaterSec: high, readLowWaterSec: low };
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
  private idleFlag = false;
  private readonly startedAt = Date.now();

  constructor(
    port: number,
    url: string,
    pid: number | null,
    private readonly doStop: () => Promise<void>,
    /** 状态快照的模式相关部分（childProcess/activeSessions/hw），由 index 按模式注入 */
    private readonly statusProvider: () => Promise<{
      childProcess: boolean;
      activeSessions: number;
      hw: { encoder: string; label: string; mode: string };
    }>
  ) {
    super();
    this.port = port;
    this.url = url;
    this.pid = pid;
  }

  /** 当前是否处于已确认空闲态（无会话且确认期已过；确认期内返回 false） */
  isIdle(): boolean {
    return this.idleFlag;
  }

  /** 仅供库内部更新空闲状态（状态机经此同步；外部不应调用） */
  _setIdle(idle: boolean): void {
    this.idleFlag = idle;
  }

  /** 主动查询服务状态快照（会话数/硬件信息/运行时长等） */
  async getStatus(): Promise<PlayerServerStatus> {
    const extra = await this.statusProvider();
    return {
      port: this.port,
      url: this.url,
      pid: this.pid,
      childProcess: extra.childProcess,
      stopped: this.stopped,
      idle: this.idleFlag,
      activeSessions: extra.activeSessions,
      hw: extra.hw,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000)
    };
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
