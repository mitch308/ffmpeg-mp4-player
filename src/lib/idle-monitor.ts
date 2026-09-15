// src/lib/idle-monitor.ts — 会话空闲/繁忙状态机
// 口径：sessions Map 为空且持续 confirmMs 后进入 IDLE（边缘触发，onChange(true) 发一次）；
// IDLE 态出现新会话立即回 BUSY（onChange(false) 发一次）。
// BUSY 态下会话增删不产生状态变化（确认期内建会不算繁忙转变——从未离开过 BUSY）。
// 服务启动时 Map 为空视为 BUSY，经确认期后进入 IDLE（"起了服务但没人用"也是空闲信号）。
//
// 确认期的意义：吸收"关旧页面立刻开新页面"这类会话间隙，防止误发 idle。

export interface IdleMonitorOptions {
  /** 进入空闲的确认时长（毫秒） */
  confirmMs: number;
  /** 订阅会话数量变化（create/destroy 后触发，参数为当前会话数），返回退订函数 */
  watch: (cb: (count: number) => void) => () => void;
  /** 读取当前会话数（订阅后立即评估初始状态：启动时 Map 为空也要走确认期进 IDLE） */
  getCount: () => number;
  /** 状态转变回调：true=进入空闲，false=恢复繁忙 */
  onChange: (idle: boolean) => void;
}

export interface IdleMonitor {
  /** 当前是否处于已确认空闲态（确认期内不算） */
  isIdle(): boolean;
  /** 停止监控（取消确认定时器并退订），stop() 生命周期调用 */
  stop(): void;
}

let confirmDelayMsDefault = 10_000;

/** 仅供测试调整空闲确认延迟（本进程模式的默认值；子进程经环境变量注入） */
export function setIdleConfirmDelayForTests(ms: number): void {
  confirmDelayMsDefault = ms;
}

/** 本进程模式默认确认延迟 */
export function getIdleConfirmDelayMs(): number {
  return confirmDelayMsDefault;
}

export function createIdleMonitor(opts: IdleMonitorOptions): IdleMonitor {
  let idle = false;
  let timer: NodeJS.Timeout | null = null;

  const onCount = (count: number): void => {
    if (count > 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (idle) {
        idle = false;
        opts.onChange(false);
      }
      return;
    }
    // Map 已空：未确认过空闲且无在途确认定时器时启动确认期
    if (idle || timer) return;
    timer = setTimeout(() => {
      timer = null;
      idle = true;
      opts.onChange(true);
    }, opts.confirmMs);
    // 确认定时器不阻止进程退出（HTTP 监听器维持事件循环）
    timer.unref?.();
  };

  // 订阅并立即评估初始状态：启动时无会话也必须进入确认期（无变更事件可依赖）
  const unwatch = opts.watch(onCount);
  onCount(opts.getCount());

  return {
    isIdle: () => idle,
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      unwatch();
    }
  };
}
