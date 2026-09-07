// src/child.ts — 子进程模式入口：由父进程 fork，通过 IPC 回报端口
// 父进程通过环境变量 FFMPEG_PLAYER_CHILD_OPTIONS 传入 JSON 序列化的启动配置
import { startInProcess } from './index';
import { PlayerServerOptions } from './config';

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

startInProcess(options)
  .then((server) => {
    process.send?.({ type: 'ready', port: server.port });
  })
  .catch((err: Error) => fail(`子进程启动失败: ${err.message}`));
