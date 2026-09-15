// src/lib/logger.ts — 统一日志模块
// 所有服务端日志经此输出，格式恒为 `[fmp4][<标签>] <消息>`：
// - 固定前缀 `fmp4` 便于全量检索；标签携带组件与上下文（如 `session:<id>`、`ffmpeg pid=N session:<id>`），
//   按会话 `grep "session:<id>"` 即可串起整条生命周期（创建/起播/降级/退出/销毁）。
// - 默认输出到 console（info→log / warn→warn / error→error）；
//   经 startServer({ logger }) 可注入自定义日志函数（子进程模式下无法序列化，仅默认 console）。

export type LogLevel = 'info' | 'warn' | 'error';

/** 自定义日志函数：接收级别与格式化后的完整消息（含 [fmp4] 前缀） */
export type LogFn = (level: LogLevel, message: string) => void;

function defaultLogFn(level: LogLevel, message: string): void {
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);
}

let logFn: LogFn = defaultLogFn;

/** 注入自定义日志函数；无参调用复位为默认 console 输出 */
export function configureLogger(fn?: LogFn): void {
  logFn = fn ?? defaultLogFn;
}

function emit(level: LogLevel, tag: string, message: string): void {
  logFn(level, `[fmp4][${tag}] ${message}`);
}

export const log = {
  info: (tag: string, message: string) => emit('info', tag, message),
  warn: (tag: string, message: string) => emit('warn', tag, message),
  error: (tag: string, message: string) => emit('error', tag, message)
};

/**
 * 直接调用当前日志函数输出一条已格式化的消息（含 [fmp4] 前缀）。
 * 子进程模式专用：子进程日志经 IPC 转发回父进程后，由此走父进程配置的
 * 日志出口（自定义函数或默认 console），保证两种模式行为一致。
 */
export function emitRaw(level: LogLevel, message: string): void {
  logFn(level, message);
}
