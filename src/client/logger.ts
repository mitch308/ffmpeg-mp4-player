// src/client/logger.ts — 前端统一日志
// 双通道输出：console（浏览器可查）+ 批量 POST /api/logs（服务端统一输出）。
// 格式与服务端一致：`[fmp4][<tag>] <消息>`，服务端以 [fmp4][client <tag>] 前缀落盘，
// 前后端日志在同一输出流按会话串联。
// 上报策略：普通日志攒批（2s 或满 20 条）；error 立即上报且 keepalive（页面卸载不丢）；
// 上报失败静默丢弃——日志通道自身不能反过来制造错误。

type Level = 'info' | 'warn' | 'error';

interface Entry {
  level: Level;
  tag: string;
  message: string;
}

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 20;

let queue: Entry[] = [];
let timer: number | null = null;

function flush(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const entries = queue;
  queue = [];
  try {
    fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      keepalive: true
    }).catch(() => { /* 上报失败静默 */ });
  } catch { /* 同上 */ }
}

function schedule(): void {
  if (timer !== null) return;
  timer = window.setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

function emit(level: Level, tag: string, message: string): void {
  const line = `[fmp4][${tag}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  queue.push({ level, tag, message });
  if (level === 'error' || queue.length >= FLUSH_BATCH_SIZE) flush();
  else schedule();
}

// 页面隐藏/卸载时兜底冲刷（pagehide 比 beforeunload 在移动端后台切换更可靠）
window.addEventListener('pagehide', flush);

export const clientLog = {
  info: (tag: string, message: string) => emit('info', tag, message),
  warn: (tag: string, message: string) => emit('warn', tag, message),
  error: (tag: string, message: string) => emit('error', tag, message)
};
