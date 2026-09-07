// src/child.ts — 子进程模式入口：由父进程 fork，通过 IPC 回报端口
// 父进程通过环境变量 FFMPEG_PLAYER_CHILD_OPTIONS 传入 JSON 序列化的启动配置
import { startInProcess } from './index';
import { PlayerServerOptions } from './config';
import { configureBinaries, getFfmpegPath, getFfprobePath, isExecutable } from './lib/ffmpeg-path';

function fail(message: string): never {
  process.send?.({ type: 'error', message });
  process.exit(1);
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
  configureBinaries({
    ffmpegPath: options.ffmpegPath ?? null,
    ffprobePath: options.ffprobePath ?? null
  });
  getFfmpegPath();
  getFfprobePath();
} catch (err) {
  fail(`子进程二进制路径校验失败: ${(err as Error).message}`);
}

// 此处模块级 override 已就位，startInProcess 内部的解析链读到的是本子进程的配置
startInProcess(options)
  .then((server) => {
    process.send?.({ type: 'ready', port: server.port });
  })
  .catch((err: Error) => fail(`子进程启动失败: ${err.message}`));
