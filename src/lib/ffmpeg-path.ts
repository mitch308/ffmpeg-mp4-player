// src/lib/ffmpeg-path.ts
// ffmpeg/ffprobe 路径解析链（优先级从高到低）：
//   1. configureBinaries() 显式注入（startServer 启动时调用）
//   2. 环境变量 FFMPEG_PATH / FFPROBE_PATH
//   3. 宿主已安装的 ffmpeg-static / ffprobe-static 包（自动探测）
//   4. 报错（错误信息列出已尝试的来源，并指向 README 安装指引）
import { existsSync, accessSync, constants } from 'fs';
import { createRequire } from 'module';

// 兼容 ESM/CJS 双格式产物（裸写 require 会被打包器的互操作 shim 劫持，故统一走 createRequire）：
// - CJS（dist/index.cjs）：__filename 真实存在，以其为解析基准
// - ESM（源码 / vitest / dist/index.mjs）：__filename 未定义，以 import.meta.url 为解析基准
// createRequire 两种基准都接受，裸说明符从产物所在目录向上找 node_modules
const nodeRequire = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url
);

export interface BinaryOverrides {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
}

const overrides: BinaryOverrides = {};

/** startServer 启动时注入显式配置；undefined 字段表示该级不存在 */
export function configureBinaries(next: BinaryOverrides): void {
  overrides.ffmpegPath = next.ffmpegPath ?? null;
  overrides.ffprobePath = next.ffprobePath ?? null;
}

/** 校验路径存在且可执行（Windows 上 X_OK 恒通过，退化为存在性检查）。导出供 startServer 校验显式配置 */
export function isExecutable(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 从 static 包解析二进制路径：ffmpeg-static 导出路径字符串；ffprobe-static 导出 { path } */
function staticPackagePath(moduleName: string): string | null {
  try {
    const mod = nodeRequire(moduleName);
    const p = typeof mod === 'string' ? mod : mod?.path;
    return typeof p === 'string' && isExecutable(p) ? p : null;
  } catch {
    return null; // 未安装该包 → 此级跳过
  }
}

/**
 * 解析单个二进制路径（导出供单测：各级来源均可注入）
 * 按显式配置 > 环境变量 > static 包顺序，路径存在且可执行即返回；全部落空抛错。
 */
export function resolveBinaryPath(opts: {
  kind: 'ffmpeg' | 'ffprobe';
  explicit?: string | null;
  env?: string | null;
  staticPath?: string | null;
}): string {
  const tried: string[] = [];
  for (const [source, p] of [
    ['显式配置', opts.explicit],
    ['环境变量', opts.env],
    ['static 包', opts.staticPath]
  ] as const) {
    if (p) {
      tried.push(`${source}: ${p}`);
      if (isExecutable(p)) return p;
    }
  }
  throw new Error(
    `未找到可用的 ${opts.kind} 可执行文件。已按顺序尝试：\n` +
    (tried.length ? tried.map((t) => `  - ${t}`).join('\n') + '\n' : '  （各级来源均未提供路径）\n') +
    '请任选其一：1) npm i ffmpeg-static ffprobe-static（自动探测）；' +
    '2) 手动下载后通过 startServer({ ffmpegPath, ffprobePath }) 配置；' +
    '3) 设置环境变量 FFMPEG_PATH / FFPROBE_PATH。详见 README。'
  );
}

export function getFfmpegPath(): string {
  return resolveBinaryPath({
    kind: 'ffmpeg',
    explicit: overrides.ffmpegPath,
    env: process.env.FFMPEG_PATH || null,
    staticPath: staticPackagePath('ffmpeg-static')
  });
}

export function getFfprobePath(): string {
  return resolveBinaryPath({
    kind: 'ffprobe',
    explicit: overrides.ffprobePath,
    env: process.env.FFPROBE_PATH || null,
    staticPath: staticPackagePath('ffprobe-static')
  });
}
