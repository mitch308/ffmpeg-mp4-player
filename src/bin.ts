// src/bin.ts — CLI 入口：npx ffmpeg-mp4-player 即起服务
// 库模式（被 import）不注册信号处理，信号交给宿主；仅 CLI 自己处理
import { startServer } from './index';

function parseArgs(argv: string[]): { port?: number; host?: string } {
  const out: { port?: number; host?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (argv[i] === '--host' && argv[i + 1]) out.host = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = await startServer({
    port: args.port ?? (process.env.PORT ? Number(process.env.PORT) : undefined),
    host: args.host ?? process.env.HOST,
    ffmpegPath: process.env.FFMPEG_PATH,
    ffprobePath: process.env.FFPROBE_PATH
  });
  console.log(`ffmpeg-mp4-player 运行于 ${server.url}（Ctrl+C 停止）`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`收到 ${signal}，正在停止…`);
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error(`启动失败: ${err.message}`);
  process.exit(1);
});
