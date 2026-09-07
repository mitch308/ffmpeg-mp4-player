// src/lib/session-manager.ts
import { createFfmpegProcess } from './ffmpeg-process';
import { probe } from './ffprobe';
import { getCaps } from './hw-accel';
import { strategyChain } from './stream-strategy';
import type { ProbeResult } from './ffprobe';
import type { Strategy } from './stream-strategy';

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

export interface Session {
  id: string;
  url: string;
  probeResult: ProbeResult;
  chain: Strategy[];
  chainIndex: number;
  process: { pid: number; kill(): void } | null;
  lastActivity: number;
  timeoutId: NodeJS.Timeout | null;
}

const sessions = new Map<string, Session>();

/**
 * 创建会话：探测元数据 + 结合硬件能力计算策略链
 * @param {string} url
 * @returns {Promise<{id, url, probeResult, chain, chainIndex}>}
 */
export async function createSession(url: string): Promise<Session> {
  const id = generateId();
  const [probeResult, caps] = await Promise.all([probe(url), getCaps()]);
  const session: Session = {
    id,
    url,
    probeResult,
    chain: strategyChain(probeResult, caps),
    chainIndex: 0,
    process: null,
    lastActivity: Date.now(),
    timeoutId: null
  };
  sessions.set(id, session);
  scheduleCleanup(session);
  return session;
}

/**
 * 获取会话
 * @param {string} id
 * @returns {object|undefined}
 */
export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

/** 当前生效的策略 */
export function currentStrategy(session: Session): Strategy {
  return session.chain[Math.min(session.chainIndex, session.chain.length - 1)];
}

/**
 * 启动/重启转码流。
 * 策略失败时自动沿策略链降级重试（仅限尚未输出任何字节的情形，
 * 避免把两份 fMP4 混进同一响应流）。
 *
 * @param {object} session
 * @param {number} startTime
 * @param {(chunk: Buffer) => void} onData
 * @param {(err: Error) => void} onError
 * @param {(code: number|null) => void} onExit
 * @param {{createProc?: Function}} [opts] - 测试注入点
 */
export function startStream(
  session: Session,
  startTime: number,
  onData: (chunk: Buffer) => void,
  onError: (err: Error) => void,
  onExit: (code: number | null) => void,
  opts: { createProc?: typeof createFfmpegProcess } = {}
): { pid: number; kill(): void } {
  // 先停止旧进程
  stopStream(session);

  const createProc = opts.createProc || createFfmpegProcess;
  const strategy = currentStrategy(session);
  let bytesEmitted = 0;
  let proc: { pid: number; kill(): void } | null = null;

  proc = createProc({
    url: session.url,
    startTime,
    strategy,
    onData: (chunk) => {
      if (session.process !== proc) return; // 已被降级/替换的旧进程
      bytesEmitted += chunk.length;
      onData(chunk);
    },
    onError: (err) => {
      if (session.process !== proc) return;
      if (bytesEmitted === 0 && session.chainIndex < session.chain.length - 1) {
        session.chainIndex++;
        console.warn(
          `[session ${session.id}] 策略 ${strategy.label} 失败` +
          `(${String(err.message).slice(0, 120)})，降级为 ${currentStrategy(session).label}`
        );
        startStream(session, startTime, onData, onError, onExit, opts);
        return;
      }
      onError(err);
    },
    onExit: (code) => {
      if (session.process !== proc) return; // 旧进程自然退出不应影响新流
      // 进程自然退出（如播放至结尾 code=0），释放引用，
      // 否则 scheduleCleanup 会因 session.process 为 truthy 而无限续期，导致会话泄漏
      session.process = null;
      onExit(code);
    }
  });

  session.process = proc;
  touchSession(session);
  return proc;  // 供调用方在 close handler 中校验是否仍为当前进程，避免旧请求误杀新进程
}

/**
 * 停止当前转码流
 * @param {object} session
 */
export function stopStream(session: Session): void {
  if (session.process) {
    session.process.kill();
    session.process = null;
  }
}

/**
 * 销毁会话
 * @param {string} id
 */
export function destroySession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  stopStream(session);
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  sessions.delete(id);
}

/** 销毁全部会话（stop() 生命周期调用）：杀掉所有 ffmpeg 进程并清空 Map */
export function destroyAllSessions(): void {
  for (const id of Array.from(sessions.keys())) {
    destroySession(id);
  }
}

/**
 * 更新会话最后活动时间
 * @param {object} session
 */
export function touchSession(session: Session): void {
  if (!session) return;
  session.lastActivity = Date.now();
  // 重置超时计时器
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  scheduleCleanup(session);
}

/**
 * 获取会话总数
 * @returns {number}
 */
export function getSessionCount(): number {
  return sessions.size;
}

function scheduleCleanup(session: Session): void {
  session.timeoutId = setTimeout(() => {
    // 如果 session 正在 streaming（有活跃进程），不清理
    if (session.process) {
      scheduleCleanup(session); // 重新计时
      return;
    }
    destroySession(session.id);
  }, SESSION_TIMEOUT_MS);
  // 清理定时器不应阻止进程退出（HTTP 监听器已维持事件循环）
  session.timeoutId.unref && session.timeoutId.unref();
}

function generateId(): string {
  let id: string;
  do {
    id = Math.random().toString(36).substring(2, 10) +
         Date.now().toString(36);
  } while (sessions.has(id)); // 碰撞防御：极小概率撞上现存会话 id 时重新生成
  return id;
}
