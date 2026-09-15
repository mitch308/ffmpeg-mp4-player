// src/client/recovery.ts — 流恢复参数（纯逻辑，无 DOM 依赖，可 node 端单测）
//
// 恢复策略：流中断后先简单重连（瞬时网络抖动；服务端会话仍在），连续失败达到阈值
// 或遇 404（服务重启，旧 sessionId 失效）时重建会话（原 URL 重新 POST /api/sessions）。
// 重试按指数退避，上限约 47s 窗口（1+2+4+8×5），覆盖服务重启耗时；收到数据即清零计数。

export const RECOVERY_LIMIT = 8;
/** 连续失败达到该次数后，恢复动作升级为重建会话（而非同会话重连） */
export const REBUILD_AFTER_FAILURES = 2;

/** 第 streak 次恢复的重试延迟（毫秒）：1s/2s/4s/8s…封顶 8s */
export function recoveryDelayMs(streak: number): number {
  return Math.min(1000 * Math.pow(2, Math.max(0, streak - 1)), 8000);
}
