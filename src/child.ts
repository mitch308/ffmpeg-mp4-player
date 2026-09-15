// src/child.ts — 子进程模式入口：由父进程 fork，通过 IPC 回报端口
// 父进程通过环境变量 FFMPEG_PLAYER_CHILD_OPTIONS 传入 JSON 序列化的启动配置
import { startInProcess } from './index';
import { PlayerServerOptions, resolveWaterConfig, resolveKeepAliveSec } from './config';
import { configureBinaries, getFfmpegPath, getFfprobePath, isExecutable } from './lib/ffmpeg-path';
import { configureLogger, type LogLevel } from './lib/logger';
import { createSafeIpcSender } from './lib/ipc-safe';
import { getCaps } from './lib/hw-accel';
import { onSessionCountChange } from './lib/session-manager';

// IPC 安全发送：消息不可序列化 / 通道关闭竞态时降级或静默，绝不抛错杀死子进程
const sendIpc = createSafeIpcSender(
  () => process.connected === true,
  process.send?.bind(process) ?? (() => {})
);

function fail(message: string): never {
  sendIpc({ type: 'error', message });
  process.exit(1);
}

/**
 * 子进程日志出口：不写自身 console（stdio inherit，会造成父进程重复输出），
 * 改经 IPC 送回父进程，由父进程当前配置的日志函数（自定义或默认 console）统一输出。
 * 须在 startInProcess 之前配置（后者不会重置 logger）。
 */
function configureIpcLogger(): void {
  configureLogger((level: LogLevel, message: string) => {
    sendIpc({ type: 'log', level, message });
  });
}

const raw = process.env.FFMPEG_PLAYER_CHILD_OPTIONS;
if (!raw) fail('缺少 FFMPEG_PLAYER_CHILD_OPTIONS 环境变量');

let options: PlayerServerOptions;
try {
  options = JSON.parse(raw);
} catch (err) {
  fail(`FFMPEG_PLAYER_CHILD_OPTIONS 不是合法 JSON: ${(err as Error).message}`);
}

// 父进程死亡时（IPC 通道断开）自动退出，避免孤儿服务
process.on('disconnect', () => process.exit(0));

// 二进制路径契约：镜像 startServer 的完整校验（父进程预校验只是提前报错的便利，
// 子进程可在 startServer 之外被直接 fork，因此此处才是权威校验点）：
// 1. 显式配置的路径不可用是硬错误——resolveBinaryPath 会静默降级到环境变量/static 包，
//    导致配置的路径被悄悄换掉（需求 5：显式路径不可用必须报错，不能换错二进制）
// 2. 解析链（显式 > 环境变量 > static 包）完全落空同样报错
try {
  for (const [name, p] of [
    ['ffmpegPath', options.ffmpegPath],
    ['ffprobePath', options.ffprobePath]
  ] as const) {
    if (p != null && !isExecutable(p)) {
      fail(`配置的 ${name} 不可用（文件不存在或不可执行）: ${p}`);
    }
  }
  // 水位线/keepalive 配置校验与父进程 startServer 同镜像（子进程可被直接 fork，此处是权威校验点）
  resolveWaterConfig(options);
  resolveKeepAliveSec(options);
  configureBinaries({
    ffmpegPath: options.ffmpegPath ?? null,
    ffprobePath: options.ffprobePath ?? null
  });
  getFfmpegPath();
  getFfprobePath();
} catch (err) {
  fail(`子进程二进制路径校验失败: ${(err as Error).message}`);
}

// 此处模块级 override 已就位，startInProcess 内部的解析链读到的是本子进程的配置。
// 空闲状态机在子进程内运行：状态转变经 IPC 上报父进程发事件；
// 确认延迟可经环境变量注入（测试用），未设置走默认值
configureIpcLogger();
const envConfirm = Number(process.env.FFMPEG_PLAYER_IDLE_CONFIRM_MS);
// 会话数变化持续上报（含订阅时的当前值），供父进程 getStatus() 展示
const unsubSessionCount = onSessionCountChange((count) => sendIpc({ type: 'sessions', count }));
startInProcess(options, {
  onIdleChange: (idle) => sendIpc({ type: 'idle', idle }),
  idleConfirmMs: Number.isFinite(envConfirm) && envConfirm > 0 ? envConfirm : undefined
})
  .then(async (server) => {
    // 硬件能力随 ready 一次性上报（createApp 启动时已探测缓存）
    const hw = await getCaps();
    sendIpc({ type: 'ready', port: server.port, hw });
  })
  .catch((err: Error) => fail(`子进程启动失败: ${err.message}`));
