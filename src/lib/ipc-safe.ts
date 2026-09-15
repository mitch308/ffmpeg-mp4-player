// src/lib/ipc-safe.ts — 子进程 IPC 安全发送（崩溃防护）
// fork 默认走 JSON 序列化通道：消息含函数/循环引用等不可序列化内容时，
// process.send 会同步抛 DataCloneError；通道关闭竞态下同样可能抛错。
// 子进程里任何未捕获异常都会崩溃退出，因此发送 IPC 消息必须走此封装：
// 任何情况下都不抛出，最坏结果是丢弃或降级为一条可序列化的 warn 日志。
import { inspect } from 'util';

type Send = (msg: unknown) => void;

/**
 * 创建安全的 IPC 发送函数。
 * @param isConnected - 通道是否仍连接（进程内传 () => process.connected，便于测试注入）
 * @param send - 实际发送函数（进程内传 process.send 的绑定引用，便于测试注入）
 */
export function createSafeIpcSender(isConnected: () => boolean, send: Send): Send {
  return (payload: unknown): void => {
    if (!isConnected()) return; // 通道已关闭（父进程退出中）：静默丢弃
    try {
      // 预检可序列化性：与通道实际的 JSON 序列化同规则，函数/循环引用在此抛出
      JSON.stringify(payload);
      send(payload);
    } catch {
      // 不可序列化：降级为一条可序列化的 warn 日志（内容 inspect 后截断），不放大问题
      try {
        send({
          type: 'log',
          level: 'warn',
          message: `[child] IPC 消息不可序列化，已降级: ${inspect(payload).slice(0, 500)}`
        });
      } catch {
        // 降级消息也发不出去（通道中断竞态）：放弃，但不抛出
      }
    }
  };
}
