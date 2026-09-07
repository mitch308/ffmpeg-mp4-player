# ffmpeg-mp4-player npm 包化改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将仓库从"内置二进制的自用服务"改造为可发布的 TypeScript npm 包：`startServer()` API 支持本进程/子进程启动、随机端口、可配置 ffmpeg/ffprobe 路径。

**Architecture:** 源码迁入 `src/`（`lib/*.ts` 机械转换 + 新增 `index/server/config/child/bin`），Vite lib mode 打包 ESM(`.mjs`)+CJS(`.cjs`) 双格式，`child.cjs`/`bin.cjs` 单独构建为 CJS。子进程模式经 fork + IPC 回报端口。express 与 `node:` 内置模块 external。

**Tech Stack:** TypeScript、Vite（lib mode）、vite-plugin-dts、vitest、express；测试用 ffmpeg 由 devDependency `ffmpeg-static`/`ffprobe-static` 提供。

**Spec:** `docs/superpowers/specs/2026-09-07-npm-package-refactor-design.md`（本计划从中展开，执行者需同读）

## Global Constraints

- Node ≥ 18；输出 ESM(`.mjs`) + CJS(`.cjs`) 双格式；`express` 与 `node:` 内置模块 external
- 注释、日志、测试名一律中文（沿用现有风格）
- 永不调用系统 ffmpeg/ffprobe，路径一律经 `src/lib/ffmpeg-path.ts` 解析链获取
- 不得改动以下踩坑逻辑的行为：策略链降级约束（仅未输出字节时降级）、`pipe:1`、fMP4 movflags、`-map_chapters -1`、AAC 标准声道布局、QSV 显式解码器、Windows 杀进程树 `taskkill /pid X /T /F`、前端水位线与自动恢复、全部 REST 路径与响应结构
- 执行环境是 Windows（win32/bash）：杀进程树必须走 taskkill 路径
- 每个任务结束必须全量测试（时点对应 `node --test` 或 `vitest`）全绿后 commit

## 全局类型约定（各任务共享）

```ts
// src/lib/ffprobe.ts
export interface AudioInfo { codec: string; channels: number; sampleRate: number; }
export interface ProbeResult {
  duration: number; width: number; height: number;
  codec: string; pixFmt: string; profile: string; fps: number;
  audio: AudioInfo | null;
}

// src/lib/hw-accel.ts
export interface Caps { encoder: string; mode: 'hybrid' | 'sw'; label: string; }
// EncoderProfile: { mode: 'hybrid'|'sw'; hwaccel: string|null; hwDecodableCodecs: string[];
//   encodeArgs: string[]; label: string; decoderByCodec?: Record<string,string> }

// src/lib/stream-strategy.ts（字段与现有 JS 对象一致，转换时对齐实际字段）
export interface Strategy {
  label: string;
  video: 'copy' | 'transcode';
  audio: 'copy' | 'aac' | 'none';
  encoder?: string;
  videoBitrate?: number;
  audioLayout?: string;
  hwDecode?: string;
  decoder?: string;
}

// src/lib/session-manager.ts
export interface Session {
  id: string; url: string; probeResult: ProbeResult;
  chain: Strategy[]; chainIndex: number;
  process: { pid: number; kill(): void } | null;
  lastActivity: number; timeoutId: NodeJS.Timeout | null;
}
```

---

### Task 1: 工程脚手架（依赖、tsconfig、Vite 三配置、vitest、package.json）

**Files:**
- Modify: `package.json`、`.gitignore`（追加 `dist/`）
- Create: `tsconfig.json`、`vite.config.ts`、`vite.config.child.ts`、`vite.config.bin.ts`、`vitest.config.ts`、`src/index.ts`（占位）

**Interfaces:**
- Produces: 构建链。`npm run build` 产出 `dist/index.mjs`、`dist/index.cjs`（含 .d.ts）、`dist/child.cjs`、`dist/bin.cjs`。后续所有任务依赖。

- [ ] **Step 1: 安装依赖**

```bash
npm i -D typescript vite vite-plugin-dts vitest @types/express @types/node ffmpeg-static ffprobe-static
```

（ffmpeg-static/ffprobe-static 安装时下载对应平台二进制，作为开发/测试用 ffmpeg。）

- [ ] **Step 2: 更新 package.json**

```json
{
  "name": "ffmpeg-mp4-player",
  "version": "2.0.0",
  "description": "Web video player powered by ffmpeg with MSE streaming (embeddable npm package)",
  "main": "server.js",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "default": "./dist/index.cjs"
    },
    "./package.json": "./package.json"
  },
  "bin": {
    "ffmpeg-mp4-player": "./dist/bin.cjs"
  },
  "files": [
    "dist",
    "public",
    "README.md"
  ],
  "scripts": {
    "start": "node server.js",
    "build": "vite build && vite build -c vite.config.child.ts && vite build -c vite.config.bin.ts",
    "test": "node --test \"test/*.test.js\"",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "express": "^4.21.0"
  }
}
```

说明：`main`/`start`/`test` 暂时保留旧值（旧代码过渡期可用，Task 2/6 更替）。ESM 产物命名 `.mjs`、CJS 命名 `.cjs`，因此**不设** `"type"` 字段，新旧代码互不干扰。

- [ ] **Step 3: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: vite.config.ts（主库，双格式）**

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  // 库代码运行在 Node，禁止 Vite 把 process.env.NODE_ENV 替换为静态值
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
  build: {
    target: 'node18',
    lib: {
      entry: { index: 'src/index.ts' },
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? '[name].mjs' : '[name].cjs')
    },
    rollupOptions: { external: [/^node:/, 'express'] }
  },
  plugins: [dts({ entryRoot: 'src', include: ['src'] })]
});
```

- [ ] **Step 5: vite.config.child.ts（子进程入口，仅 CJS）**

```ts
// vite.config.child.ts
// 子进程入口单独构建：fork 需要确定的单文件路径，固定产出 dist/child.cjs
import { defineConfig } from 'vite';

export default defineConfig({
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
  build: {
    target: 'node18',
    emptyOutDir: false,
    lib: {
      entry: 'src/child.ts',
      formats: ['cjs'],
      fileName: () => 'child.cjs'
    },
    rollupOptions: { external: [/^node:/, 'express'] }
  }
});
```

- [ ] **Step 6: vite.config.bin.ts（CLI 入口，仅 CJS + shebang）**

```ts
// vite.config.bin.ts
import { defineConfig } from 'vite';

export default defineConfig({
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
  build: {
    target: 'node18',
    emptyOutDir: false,
    lib: {
      entry: 'src/bin.ts',
      formats: ['cjs'],
      fileName: () => 'bin.cjs'
    },
    rollupOptions: {
      external: [/^node:/, 'express'],
      output: { banner: '#!/usr/bin/env node' }
    }
  }
});
```

- [ ] **Step 7: vitest.config.ts**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 真实 ffmpeg 转码/硬件探测可能较慢
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
```

- [ ] **Step 8: 创建占位 src/index.ts 并验证构建**

```ts
// src/index.ts
export const placeholder = true;
```

运行 `npm run build`，验证产出 `dist/index.mjs`、`dist/index.cjs`、`dist/index.d.mts`、`dist/index.d.cts`。

- [ ] **Step 9: .gitignore 追加 `dist/`，commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vite.config.child.ts vite.config.bin.ts vitest.config.ts src/index.ts .gitignore
git commit -m "chore: TypeScript + Vite 构建脚手架（双格式 lib/child/bin 三入口）"

---

### Task 2: lib 层 TS 转换 + 二进制路径解析链 + 测试迁移 vitest

**Files:**
- Create: `src/lib/ffmpeg-path.ts`（重写）、`src/lib/ffprobe.ts`、`src/lib/ffmpeg-process.ts`、`src/lib/hw-accel.ts`、`src/lib/stream-strategy.ts`、`src/lib/session-manager.ts`、`test/ffmpeg-path.test.ts`、`test/helpers/samples.ts`
- Create（由同名 .js 迁移）: `test/stream-strategy.test.ts`、`test/ffmpeg-process.test.ts`、`test/ffprobe.test.ts`、`test/hw-accel.test.ts`、`test/hw-accel.detect.test.ts`、`test/hw-pipeline.test.ts`、`test/session-manager.test.ts`
- Delete: `lib/`（整个目录）、上述同名 `test/*.test.js`、`test/helpers/samples.js`
- Modify: `package.json`（`test` 脚本换为 `"npm run build && vitest run"`）

**Interfaces:**
- Consumes: Task 1 构建链与 vitest。
- Produces:
  - `configureBinaries(o: { ffmpegPath?: string | null; ffprobePath?: string | null }): void`（Task 3 的 startServer 调用）
  - `resolveBinaryPath(opts: { kind: 'ffmpeg' | 'ffprobe'; explicit?: string | null; env?: string | null; staticPath?: string | null }): string`（导出供单测）
  - `getFfmpegPath(): string` / `getFfprobePath(): string`（签名不变，其余模块调用点零改动）
  - `probe(url): Promise<ProbeResult>`、`buildArgs(url, startTime, strategy): string[]`、`createFfmpegProcess(opts)`、`strategyChain(probeResult, caps): Strategy[]`、`getCaps()/resetCaps()`、session-manager 全部旧导出 + 新增 `destroyAllSessions(): void`
  - 全局类型见计划头部「全局类型约定」

- [ ] **Step 1: 重写 src/lib/ffmpeg-path.ts（解析链，核心新代码）**

```ts
// src/lib/ffmpeg-path.ts
// ffmpeg/ffprobe 路径解析链（优先级从高到低）：
//   1. configureBinaries() 显式注入（startServer 启动时调用）
//   2. 环境变量 FFMPEG_PATH / FFPROBE_PATH
//   3. 宿主已安装的 ffmpeg-static / ffprobe-static 包（自动探测）
//   4. 报错（错误信息列出已尝试的来源，并指向 README 安装指引）
import { existsSync, accessSync, constants } from 'fs';
import { createRequire } from 'module';

// 兼容 ESM/CJS 双格式产物：CJS 构建中 Vite 会垫平 import.meta.url
const nodeRequire = createRequire(import.meta.url);

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

/** 校验路径存在且可执行（Windows 上 X_OK 恒通过，退化为存在性检查） */
function isExecutable(p: string): boolean {
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
```

注意：`staticPackagePath` 每次调用重新解析，保证 configureBinaries 清除后能回落到 static 包。旧实现中 `ffmpeg/<平台>/<架构>/` 的目录拼接逻辑整体删除。

- [ ] **Step 2: 新建 test/ffmpeg-path.test.ts**

```ts
// test/ffmpeg-path.test.ts — 路径解析链三级优先级
import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveBinaryPath,
  configureBinaries,
  getFfmpegPath,
  getFfprobePath
} from '../src/lib/ffmpeg-path';

let tmp = '';
function makeExe(name: string): string {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'ffmpeg-path-test-'));
  const p = join(tmp, name);
  writeFileSync(p, '#!/bin/sh\n');
  try { chmodSync(p, 0o755); } catch { /* Windows 无 chmod */ }
  return p;
}

afterEach(() => {
  configureBinaries({});
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = ''; }
});

describe('二进制路径解析链', () => {
  test('显式配置 > 环境变量 > static 包', () => {
    const a = makeExe('a.exe'), b = makeExe('b.exe'), c = makeExe('c.exe');
    expect(resolveBinaryPath({ kind: 'ffmpeg', explicit: a, env: b, staticPath: c })).toBe(a);
    expect(resolveBinaryPath({ kind: 'ffmpeg', explicit: null, env: b, staticPath: c })).toBe(b);
    expect(resolveBinaryPath({ kind: 'ffmpeg', explicit: null, env: null, staticPath: c })).toBe(c);
  });

  test('路径不存在时跳到下一级', () => {
    const b = makeExe('fallback.exe');
    expect(resolveBinaryPath({ kind: 'ffmpeg', explicit: join(tmp, '不存在'), env: b })).toBe(b);
  });

  test('全部落空抛错且错误信息含来源与 README 指引', () => {
    expect(() => resolveBinaryPath({ kind: 'ffprobe', explicit: join(tmp, '无') }))
      .toThrow(/FFMPEG_PATH|ffprobe-static|README/);
  });

  test('devDeps 已装 ffmpeg-static/ffprobe-static：默认解析应命中', () => {
    expect(getFfmpegPath()).toBeTruthy();
    expect(getFfprobePath()).toBeTruthy();
  });

  test('configureBinaries 注入后 getFfmpegPath 返回注入值', () => {
    const p = makeExe('my-ffmpeg.exe');
    configureBinaries({ ffmpegPath: p });
    expect(getFfmpegPath()).toBe(p);
  });
});
```

- [ ] **Step 3: 运行新测试确认可跑**

```bash
npx vitest run test/ffmpeg-path.test.ts
```
Expected: PASS（Step 1/2 已就位；若失败按报错修正后再继续）。

- [ ] **Step 4: 机械转换其余 5 个 lib 模块到 src/lib/（TS 化，逻辑零改动）**

通用规则：`require` → `import`；`module.exports = {...}` → `export {...}`；按「全局类型约定」补类型。逐文件要点：
- `src/lib/ffprobe.ts`：`probe(url: string): Promise<ProbeResult>`；ffprobe JSON 结构定义局部 `interface FfprobeStream { codec_type: string; codec_name?: string; pix_fmt?: string; profile?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; channels?: number; sample_rate?: number; }`；15s 超时逻辑不动
- `src/lib/hw-accel.ts`：导出 `PRIORITY: string[]`、`ENCODER_PROFILES: Record<string, EncoderProfile>`、`parseEncodersOutput(text: string): Set<string>`、`pickEncoder(available: Set<string>): string`、`detectCaps(): Promise<Caps>`、`getCaps(): Promise<Caps>`、`resetCaps(): void`；spawn/超时/unref 逻辑不动
- `src/lib/ffmpeg-process.ts`：`buildArgs(url: string, startTime: number, strategy: Strategy): string[]`、`createFfmpegProcess(opts: { url: string; startTime: number; strategy: Strategy; onData: (chunk: Buffer) => void; onError: (err: Error) => void; onExit: (code: number | null) => void }): { pid: number; kill(): void }`；kill 内 Windows taskkill / POSIX SIGKILL 分支一字不改
- `src/lib/stream-strategy.ts`：`strategyChain(probeResult: ProbeResult, caps: Caps): Strategy[]`，内部辅助函数私有化
- `src/lib/session-manager.ts`：旧导出不变，**新增**：

```ts
/** 销毁全部会话（stop() 生命周期调用）：杀掉所有 ffmpeg 进程并清空 Map */
function destroyAllSessions(): void {
  for (const id of Array.from(sessions.keys())) {
    destroySession(id);
  }
}
```
并将其加入 export 列表。

- [ ] **Step 5: 迁移测试助手与 7 个旧测试文件到 vitest/TS**

- `test/helpers/samples.js` → `test/helpers/samples.ts`：仅改导入路径 `'../../lib/ffmpeg-path'` → `'../../src/lib/ffmpeg-path'`，`ensureSamples()` 返回值补类型标注（`{ dir: string; h264Aac: string; h264NoAudio: string; h264Hi10: string; hevcHi10: string; hevc8: string }`）
- 7 个 `test/*.test.js` → 同名 `.test.ts`，通用规则：
  - `const { test } = require('node:test')` → `import { test } from 'vitest'`；断言保留 `import assert from 'node:assert/strict'`
  - 相对导入 `../lib/...` → `../src/lib/...`；`require` → `import`
  - `test/session-manager.test.ts`：`opts.createProc` 注入点签名不变，补类型 `(opts: { createProc?: typeof createFfmpegProcess })`
  - `test/hw-accel.detect.test.ts`、`test/hw-pipeline.test.ts`：环境相关跳过逻辑原样保留
- 删除对应旧 `.js` 文件

- [ ] **Step 6: package.json 的 `test` 脚本换成 `"npm run build && vitest run"`，全量跑测试**

```bash
npm test
```
Expected: 除硬件相关（无 GPU 环境自动跳过）外全部 PASS。hw 测试失败先确认是否环境问题（AGENTS.md 已注明），不得改代码迁就。

- [ ] **Step 7: 删除旧 lib/ 目录，commit**

```bash
git rm -r lib test/*.test.js test/helpers/samples.js
git add -A
git commit -m "refactor: lib 层 TS 化 + ffmpeg/ffprobe 路径解析链（配置>环境变量>static包），测试迁移 vitest"
```

---

### Task 3: server 工厂 + startServer（本进程模式）+ 随机端口

**Files:**
- Create: `src/config.ts`、`src/lib/ports.ts`、`src/server.ts`、`src/index.ts`（替换占位）、`test/ports.test.ts`、`test/server.test.ts`、`test/e2e.test.ts`
- Delete: `server.js`、`test/e2e.test.js`

**Interfaces:**
- Consumes: Task 2 的 `configureBinaries`、`getFfmpegPath/getFfprobePath`、`destroyAllSessions`
- Produces（Task 4/5 依赖，签名必须一致）:
  - `interface PlayerServerOptions { port?: number; host?: string; childProcess?: boolean; ffmpegPath?: string; ffprobePath?: string; staticPlayer?: boolean; }`
  - `interface PlayerServer { port: number; url: string; stop(): Promise<void>; }`
  - `startInProcess(options: PlayerServerOptions): Promise<PlayerServer>`（导出，Task 4 的 child.ts 调用）
  - `startServer(options?: PlayerServerOptions): Promise<PlayerServer>`
  - `createApp(options?: { staticPlayer?: boolean }): Express`
  - `isPortFree(port: number, host: string): Promise<boolean>`、`pickFreePort(host: string): Promise<number>`

- [ ] **Step 1: src/config.ts（类型与默认值）**

```ts
// src/config.ts — 公共配置类型与默认值
export interface PlayerServerOptions {
  /** 监听端口；未配置时从 20000–30000 区间随机选取空闲端口 */
  port?: number;
  /** 绑定地址，默认 127.0.0.1 */
  host?: string;
  /** true 时 fork 子进程运行服务，默认 false */
  childProcess?: boolean;
  /** ffmpeg 可执行文件路径；不传走解析链（显式配置 > 环境变量 > static 包） */
  ffmpegPath?: string;
  /** ffprobe 可执行文件路径；不传走解析链 */
  ffprobePath?: string;
  /** 是否托管 public/ 播放器页面，默认 true */
  staticPlayer?: boolean;
}

export interface PlayerServer {
  /** 最终监听端口 */
  port: number;
  /** http://host:port */
  url: string;
  /** 关闭服务；本进程模式销毁全部会话，子进程模式杀进程树 */
  stop(): Promise<void>;
}

export const DEFAULT_HOST = '127.0.0.1';
```

- [ ] **Step 2: 先写 test/ports.test.ts**

```ts
// test/ports.test.ts — 空闲端口探测与随机选取
import { describe, test, expect } from 'vitest';
import net from 'net';
import { isPortFree, pickFreePort, PORT_RANGE_START, PORT_RANGE_END } from '../src/lib/ports';

describe('端口选取', () => {
  test('空闲端口返回 true，被占端口返回 false', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    );
    // server 未关闭时该端口被占用
    expect(await isPortFree(port, '127.0.0.1')).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await isPortFree(port, '127.0.0.1')).toBe(true);
  });

  test('pickFreePort 返回值落在 20000–30000 且确实空闲', async () => {
    const port = await pickFreePort('127.0.0.1');
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(port).toBeLessThanOrEqual(PORT_RANGE_END);
    expect(await isPortFree(port, '127.0.0.1')).toBe(true);
  });
});
```

运行 `npx vitest run test/ports.test.ts` 确认失败（模块不存在）。

- [ ] **Step 3: 实现 src/lib/ports.ts**

```ts
// src/lib/ports.ts — 空闲端口探测与随机选取
// 选 20000–30000：避开特权端口、常见服务端口与开发常用端口（3000/8080 等），
// 降低与宿主环境其他服务冲突的概率
import net from 'net';

export const PORT_RANGE_START = 20000;
export const PORT_RANGE_END = 30000;

export function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** 在不常用区间随机挑一个空闲端口；探测与真正 listen 之间存在竞态，由调用方重试兜底 */
export async function pickFreePort(host: string): Promise<number> {
  const span = PORT_RANGE_END - PORT_RANGE_START + 1;
  for (let i = 0; i < 20; i++) {
    const port = PORT_RANGE_START + Math.floor(Math.random() * span);
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`在 ${PORT_RANGE_START}-${PORT_RANGE_END} 区间内未找到空闲端口`);
}
```

运行 `npx vitest run test/ports.test.ts`，Expected: PASS。

- [ ] **Step 4: src/server.ts（express app 工厂，自 server.js 转换，路由零改动）**

```ts
// src/server.ts — express app 工厂：从旧 server.js 转换，不再自行 listen
import express, { Express } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createSession,
  getSession,
  startStream,
  stopStream,
  destroySession,
  touchSession,
  getSessionCount,
  currentStrategy
} from './lib/session-manager';
import { getCaps } from './lib/hw-accel';

// 兼容三种运行位置：src（vitest）→ 仓库根；dist/index.mjs → 包根；dist/index.cjs → 包根
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../../public');

export function createApp(options: { staticPlayer?: boolean } = {}): Express {
  const app = express();

  // 启动即探测硬件能力（结果缓存，供会话决策与状态查询）
  const hwCapsPromise = getCaps();

  app.use(express.json());
  if (options.staticPlayer !== false) {
    app.use(express.static(publicDir));
  }

  // 以下路由与旧 server.js 逐行一致（createSession/getSession/startStream/stopStream/
  // destroySession/touchSession/getSessionCount/currentStrategy 的用法、CORS 头、
  // close handler 的 session.process === myProc 校验均不动），仅把模块导入换成 src/lib/*.ts
  // ……（原 26–128 行的路由代码原样搬入）

  return app;
}
```

实现说明：搬入旧 `server.js` 第 26–128 行的全部路由代码（`/api/sessions` POST/GET stream/DELETE、`/api/status`），行为零改动；删除原文件末尾的 `app.listen`。

- [ ] **Step 5: src/index.ts（startServer，本进程模式 + 端口重试）**

```ts
// src/index.ts — npm 包公共 API
import type { Server } from 'http';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { configureBinaries, getFfmpegPath, getFfprobePath } from './lib/ffmpeg-path';
import { destroyAllSessions } from './lib/session-manager';
import { isPortFree, pickFreePort } from './lib/ports';
import { createApp } from './server';
import { PlayerServer, PlayerServerOptions, DEFAULT_HOST } from './config';

export type { PlayerServer, PlayerServerOptions } from './config';

const MAX_PORT_RETRIES = 5;

function listen(app: ReturnType<typeof createApp>, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 本进程模式：同进程内起 express，返回端口与 stop()（child.ts 与 startServer 共用） */
export async function startInProcess(options: PlayerServerOptions): Promise<PlayerServer> {
  const host = options.host ?? DEFAULT_HOST;
  const app = createApp({ staticPlayer: options.staticPlayer });
  const explicit = options.port != null;

  let lastErr: unknown = new Error('未知错误');
  for (let attempt = 0; attempt <= (explicit ? 0 : MAX_PORT_RETRIES); attempt++) {
    // 显式端口直接用（被占则 EADDRINUSE 报错，不静默换端口）；
    // 随机端口先探测空闲再绑定，竞态失败时重试
    const port = explicit
      ? options.port!
      : await pickFreePort(host);
    try {
      const server = await listen(app, port, host);
      console.log(`ffmpeg-mp4-player 运行于 http://${host}:${port}`);
      return {
        port,
        url: `http://${host}:${port}`,
        stop: async () => {
          await closeServer(server);
          destroyAllSessions();
        }
      };
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
      if (explicit) throw err;
    }
  }
  throw lastErr;
}

/** 子进程模式：Task 4 实现（本任务先留占位实现，直接抛错） */
async function startChildProcess(options: PlayerServerOptions): Promise<PlayerServer> {
  throw new Error('childProcess 模式将在 Task 4 实现');
}

/**
 * 启动播放服务。
 * 启动前先解析 ffmpeg/ffprobe 路径（缺失立即抛错，不留半启动状态）。
 */
export async function startServer(options: PlayerServerOptions = {}): Promise<PlayerServer> {
  configureBinaries({
    ffmpegPath: options.ffmpegPath ?? null,
    ffprobePath: options.ffprobePath ?? null
  });
  // 触发解析链校验：任一二进制缺失在此抛出明确错误
  getFfmpegPath();
  getFfprobePath();

  if (options.childProcess) return startChildProcess(options);
  return startInProcess(options);
}
```

- [ ] **Step 6: 先写 test/server.test.ts**

```ts
// test/server.test.ts — startServer 本进程模式生命周期
import { describe, test, expect, afterEach } from 'vitest';
import { startServer } from '../src/index';
import { getSessionCount } from '../src/lib/session-manager';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { ensureSamples } from './helpers/samples';

let server: Awaited<ReturnType<typeof startServer>> | null = null;
afterEach(async () => { if (server) { await server.stop(); server = null; } });

describe('startServer 本进程模式', () => {
  test('显式端口启动，返回 port/url，/api/status 可访问', async () => {
    server = await startServer({ port: 0 }); // 0 = 由 listen 随机分配，仅测生命周期
    const res = await fetch(`${server.url}/api/status`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty('hw');
  });

  test('stop() 后端口不再可访问', async () => {
    const s = await startServer({ port: 0 });
    const url = s.url;
    await s.stop();
    server = null;
    await expect(fetch(`${url}/api/status`)).rejects.toThrow();
  });

  test('显式端口被占时报 EADDRINUSE，不静默换端口', async () => {
    const s = await startServer({ port: 0 });
    try {
      await expect(startServer({ port: s.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally { await s.stop(); }
  });

  test('未配置端口时从 20000–30000 随机选取', async () => {
    server = await startServer({ host: '127.0.0.1' });
    expect(server.port).toBeGreaterThanOrEqual(20000);
    expect(server.port).toBeLessThanOrEqual(30000);
  });

  test('二进制路径配置无效时启动即报错，不留下监听', async () => {
    await expect(startServer({ ffmpegPath: 'C:/不存在的ffmpeg.exe' }))
      .rejects.toThrow(/ffmpeg/);
    expect(getSessionCount()).toBe(0);
  });
});
```

运行 `npx vitest run test/server.test.ts`，Expected: PASS。

- [ ] **Step 7: 迁移 e2e 测试**

`test/e2e.test.js` → `test/e2e.test.ts`：不再 spawn `server.js` 子进程，改为直接调用 `startServer({ port: 0 })`（in-process）；其余断言（创建会话 → 拉 init/媒体 segment → ffprobe 校验产物）原样保留，导入路径 `../lib/...` → `../src/lib/...`，`require` → `import`，`test` 来自 vitest，`afterAll` 中 `await server.stop()`。删除 `server.js` 与旧 `test/e2e.test.js`。

- [ ] **Step 8: 全量测试 + commit**

```bash
npm test
git add -A
git commit -m "feat: startServer API（本进程模式）+ 随机空闲端口选取 + server 工厂化"
```

---

### Task 4: 子进程模式（fork + IPC 端口回报 + 杀进程树）

**Files:**
- Create: `src/lib/kill-tree.ts`、`src/child.ts`、`test/child-process.test.ts`
- Modify: `src/index.ts`（实现 startChildProcess 替换占位）

**Interfaces:**
- Consumes: Task 3 的 `startInProcess`、`PlayerServerOptions/PlayerServer`
- Produces:
  - `killProcessTree(pid: number): Promise<void>`（win32 用 `taskkill /pid X /T /F`，POSIX 用进程组 SIGKILL）
  - `startServer({ childProcess: true })` 完整可用：子进程经 IPC 回报 `{ type: 'ready', port }`；stop() 杀子进程树

- [ ] **Step 1: src/lib/kill-tree.ts**

```ts
// src/lib/kill-tree.ts — 跨平台杀进程树
import { spawn } from 'child_process';

/**
 * 杀掉以 pid 为根的整棵进程树。
 * Windows：taskkill /T /F（直接 proc.kill() 会留孤儿进程，见踩坑记录）；
 * POSIX：fork 需以 detached:true 启动使其成为进程组长，然后 kill(-pid) 杀全组。
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      try {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        tk.on('error', () => resolve()); // 进程可能已退出
        tk.on('close', () => resolve());
      } catch {
        resolve();
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
      }
      resolve();
    }
  });
}
```

- [ ] **Step 2: src/child.ts（子进程入口）**

```ts
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
```

- [ ] **Step 3: src/index.ts 中实现 startChildProcess（替换占位）**

```ts
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { killProcessTree } from './lib/kill-tree';
import type { ChildProcess } from 'child_process';

// 与 child.cjs 同目录：dist 下即包内 dist/child.cjs
const here = path.dirname(fileURLToPath(import.meta.url));

/** 子进程模式：fork dist/child.cjs，IPC 回报端口；stop() 杀进程树 */
async function startChildProcess(options: PlayerServerOptions): Promise<PlayerServer> {
  const childEntry = path.join(here, 'child.cjs');
  if (!existsSync(childEntry)) {
    throw new Error(`未找到 ${childEntry}，请先执行 npm run build`);
  }

  const child: ChildProcess = fork(childEntry, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    detached: true, // POSIX 上使子进程成为组长，便于 kill(-pid) 杀全组
    env: {
      ...process.env,
      FFMPEG_PLAYER_CHILD_OPTIONS: JSON.stringify(options)
    }
  });

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const onMessage = (msg: unknown) => {
        const m = msg as { type?: string; port?: number; message?: string };
        if (m?.type === 'ready' && typeof m.port === 'number') resolve(m.port);
        else if (m?.type === 'error') reject(new Error(m.message ?? '子进程启动失败'));
      };
      child.on('message', onMessage);
      child.once('exit', (code) =>
        reject(new Error(`子进程在就绪前退出（退出码 ${code}）`))
      );
    });
    const host = options.host ?? DEFAULT_HOST;
    console.log(`ffmpeg-mp4-player（子进程模式）运行于 http://${host}:${port}`);
    return {
      port,
      url: `http://${host}:${port}`,
      stop: async () => {
        if (child.pid != null) await killProcessTree(child.pid);
      }
    };
  } catch (err) {
    // 启动失败兜底清理，不留半启动子进程
    if (child.pid != null) await killProcessTree(child.pid);
    throw err;
  }
}
```

注意：Task 3 的占位 `startChildProcess` 与新增 import 全部替换；`startInProcess` 需在 index.ts 中 export（Task 3 已导出）。

- [ ] **Step 4: 先写 test/child-process.test.ts**

```ts
// test/child-process.test.ts — 子进程模式：fork + IPC 端口回报 + stop 杀进程树
import { describe, test, expect, afterEach } from 'vitest';
import { startServer } from '../src/index';
import { isPortFree } from '../src/lib/ports';
import { ensureSamples } from './helpers/samples';

let server: Awaited<ReturnType<typeof startServer>> | null = null;
afterEach(async () => { if (server) { await server.stop(); server = null; } });

describe('startServer 子进程模式', () => {
  test('启动返回端口且服务可用', async () => {
    server = await startServer({ childProcess: true, port: 0 });
    const res = await fetch(`${server.url}/api/status`);
    expect(res.ok).toBe(true);
    expect((await res.json()).hw).toBeDefined();
  });

  test('未配置端口时子进程随机选端口并回报给父进程', async () => {
    server = await startServer({ childProcess: true });
    expect(server.port).toBeGreaterThanOrEqual(20000);
    expect(server.port).toBeLessThanOrEqual(30000);
    expect(await fetch(`${server.url}/api/status`)).toBeTruthy();
  });

  test('stop() 杀掉子进程树，端口释放', async () => {
    const s = await startServer({ childProcess: true, port: 0 });
    const port = s.port;
    await s.stop();
    server = null;
    // 给端口释放留一点时间
    await new Promise((r) => setTimeout(r, 300));
    expect(await isPortFree(port, '127.0.0.1')).toBe(true);
  });

  test('子进程模式能完成一次真实转码会话', async () => {
    const samples = ensureSamples();
    server = await startServer({ childProcess: true, port: 0 });
    const create = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac })
    });
    expect(create.ok).toBe(true);
    const { sessionId } = await create.json();
    const stream = await fetch(`${server.url}/api/sessions/${sessionId}/stream`);
    expect(stream.ok).toBe(true);
    const buf = Buffer.from(await stream.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // fMP4 init segment 以 ftyp box 开头
    expect(buf.subarray(4, 8).toString('ascii')).toBe('ftyp');
  });
});
```

- [ ] **Step 5: 构建并运行测试**

```bash
npm test
```
Expected: PASS。注意 `npm test` 已含 build，`fork` 找到的是最新构建的 `dist/child.cjs`。

- [ ] **Step 6: commit**

```bash
git add -A
git commit -m "feat: 子进程启动模式（fork + IPC 端口回报 + 跨平台杀进程树）"
```

---

### Task 5: CLI（bin.cjs）

**Files:**
- Create: `src/bin.ts`、`test/bin.test.ts`
- Modify: 无（`bin` 字段与 `vite.config.bin.ts` 已在 Task 1 就位）

**Interfaces:**
- Consumes: Task 3/4 的 `startServer`
- Produces: `ffmpeg-mp4-player` 可执行命令：`--port`/`--host` 参数 + `PORT`/`HOST`/`FFMPEG_PATH`/`FFPROBE_PATH` 环境变量；SIGINT/SIGTERM 优雅退出

- [ ] **Step 1: src/bin.ts**

```ts
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
```

（CJS 产物不能有顶层 await，故包一层 `main()`。）

- [ ] **Step 2: 先写 test/bin.test.ts**

```ts
// test/bin.test.ts — CLI 冒烟：spawn dist/bin.cjs，探活后 SIGINT 退出
import { describe, test, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { isPortFree } from '../src/lib/ports';

// npm test 已先 build，dist/bin.cjs 为最新产物
const BIN = path.join(__dirname, '..', 'dist', 'bin.cjs');

describe('CLI', () => {
  test('--port 启动、/api/status 探活、SIGINT 后端口释放且进程退出', async () => {
    // 先占一个随机空闲端口再让给 CLI，避免竞态
    const port = await (async () => {
      // 从不常用区间取值：与 pickFreePort 逻辑一致由服务端自行处理，这里手动探测
      let p = 20000 + Math.floor(Math.random() * 10000);
      while (!(await isPortFree(p, '127.0.0.1'))) p = 20000 + Math.floor(Math.random() * 10000);
      return p;
    })();

    const child = spawn(process.execPath, [BIN, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      // 等待服务就绪
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/status`);
          up = res.ok;
        } catch { /* 未就绪 */ }
      }
      expect(up).toBe(true);
    } finally {
      child.kill('SIGINT');
    }
    // 进程应退出且端口释放
    const exited = await Promise.race([
      new Promise<boolean>((r) => child.once('exit', () => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000))
    ]);
    expect(exited).toBe(true);
    expect(await isPortFree(port, '127.0.0.1')).toBe(true);
  }, 30000);

  test('二进制路径无效时 CLI 报错退出（退出码非 0）', async () => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, FFMPEG_PATH: 'C:/不存在/ffmpeg.exe' },
      stdio: 'ignore'
    });
    const code = await new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    expect(code).not.toBe(0);
  });
});
```

- [ ] **Step 3: 构建并运行测试 + commit**

```bash
npm test
git add -A
git commit -m "feat: CLI 入口（--port/--host 与环境变量配置，信号优雅退出）"
```

---

### Task 6: 移除内置二进制 + README 重写 + 收尾

**Files:**
- Delete: `ffmpeg/`、`ffprobe/`（共约 744MB）
- Create: `README.md`
- Modify: `package.json`（`main`/`start` 收尾）、`AGENTS.md`

**Interfaces:**
- Consumes: 前 5 个任务的全部成果
- Produces: 可 `npm publish` 的最终包形态

- [ ] **Step 1: 删除内置二进制与遗留文件**

```bash
git rm -r ffmpeg ffprobe
git rm server.js   # 若 Task 3 已删则跳过
```

- [ ] **Step 2: package.json 收尾**

把 `"main": "server.js"` 一行删除；`scripts.start` 改为 `"node dist/bin.cjs"`。其余字段保持 Task 1 状态。

- [ ] **Step 3: 重写 README.md（完整内容）**

````markdown
# ffmpeg-mp4-player

基于 ffmpeg 的 Web 视频播放服务：输入视频文件 URL，服务端转码/直通为 fMP4（H.264 + AAC），浏览器经 MSE 播放，支持精确 seek、硬件加速、多并发会话。

## 安装

```bash
npm install ffmpeg-mp4-player
```

需要 Node ≥ 18。

## 获取 ffmpeg / ffprobe（必需）

本包**不内置** ffmpeg/ffprobe 二进制，也不提供下载功能。启动前需确保 ffmpeg 与 ffprobe 可用，三种方式任选：

### 方式一（推荐）：ffmpeg-static / ffprobe-static

```bash
npm install ffmpeg-static ffprobe-static
```

装上即可，本包会自动从宿主 node_modules 探测到它们，零配置。

### 方式二：手动下载

- Windows: https://www.gyan.dev/ffmpeg/builds/ （release full）
- Linux: https://johnvansickle.com/ffmpeg/ 或发行版包管理器
- macOS: `brew install ffmpeg` 或 https://evermeet.cx/ffmpeg/

下载后解压，记下 `ffmpeg`/`ffprobe`（Windows 为 `.exe`）的路径，按下文配置。

### 方式三：环境变量

```bash
export FFMPEG_PATH=/path/to/ffmpeg
export FFPROBE_PATH=/path/to/ffprobe
```

三级来源优先级：**显式配置 > 环境变量 > static 包自动探测**；全部落空时启动报错并给出指引。

## 快速开始（API）

```js
const { startServer } = require('ffmpeg-mp4-player');
// ESM: import { startServer } from 'ffmpeg-mp4-player';

const server = await startServer({
  port: 8080,            // 可省略：从 20000–30000 随机选空闲端口
  // childProcess: true, // 子进程模式（隔离运行，崩溃不影响宿主）
  // ffmpegPath: '/path/to/ffmpeg',
  // ffprobePath: '/path/to/ffprobe',
});
console.log(`播放器页面: ${server.url}`);

// 退出前优雅停止（销毁会话、杀 ffmpeg/子进程）
await server.stop();
```

返回的 `server.port` 是最终监听端口（显式端口被占会直接报错，不静默换端口）。

## CLI

```bash
npx ffmpeg-mp4-player --port 8080 --host 0.0.0.0
# 或
PORT=8080 FFMPEG_PATH=/path/to/ffmpeg npx ffmpeg-mp4-player
```

## 配置项

| 项 | 类型 | 默认 | 说明 |
|----|------|------|------|
| `port` | number | 随机（20000–30000） | 监听端口 |
| `host` | string | `127.0.0.1` | 绑定地址 |
| `childProcess` | boolean | `false` | 子进程模式启动 |
| `ffmpegPath` | string | 解析链 | ffmpeg 可执行文件路径 |
| `ffprobePath` | string | 解析链 | ffprobe 可执行文件路径 |
| `staticPlayer` | boolean | `true` | 托管内置网页播放器（访问根路径） |

## HTTP API

- `POST /api/sessions` `{ "url": "..." }` → `{ sessionId, duration, width, height, codec, audioCodec, streamMode, ... }`
- `GET /api/sessions/:id/stream?start=秒` → fMP4 流（`video/mp4`）
- `DELETE /api/sessions/:id` → 销毁会话
- `GET /api/status` → `{ activeSessions, hw: { encoder, label, mode } }`

## 许可

MIT
````

- [ ] **Step 4: 更新 AGENTS.md（保持开发者文档与实际一致）**

需要改动的段落：
- 「常用命令」：`npm test` 改为「运行 vitest（先构建）」；`npm start` 改为「`node dist/bin.cjs`；开发时先 `npm run build`」；新增 `npm run build`
- 「内置的 ffmpeg/ffprobe」一节替换为：「二进制不入库。测试用 ffmpeg 来自 devDependency `ffmpeg-static`/`ffprobe-static`；运行时路径经 `src/lib/ffmpeg-path.ts` 解析链（显式配置 > `FFMPEG_PATH`/`FFPROBE_PATH` 环境变量 > static 包）。绝不要调用系统 ffmpeg 或硬编码路径。」
- 「架构」首行改为：`src/index.ts`（startServer API）→ `src/server.ts`（Express app 工厂）→ `src/lib/session-manager.ts` → `src/lib/ffmpeg-process.ts`；补充「子进程模式经 `src/child.ts` fork + IPC 回报端口；杀进程树统一走 `src/lib/kill-tree.ts`」
- 「测试」一节改为：「vitest 运行 `test/*.test.ts`；样本生成与 e2e 均拉真实 ffmpeg（来自 ffmpeg-static）；`test/build` 由 `npm test` 自动完成」

- [ ] **Step 5: 全量测试 + commit**

```bash
npm test
git add -A
git commit -m "feat: 移除内置二进制，README/AGENTS 重写，npm 包形态收尾"
```

- [ ] **Step 6: 发布前人工验收（不 commit）**

```bash
npm pack --dry-run   # 确认只含 dist/public/README，无 ffmpeg/ffprobe（体积应 < 1MB）
node dist/bin.cjs    # 手动起一次服务，浏览器打开播放器页面放一个本地样本
```

---

## Self-Review 记录

1. **Spec 覆盖**：需求 1（移除二进制+下载指引）→ Task 2/6；需求 2/3（初始化方法、子进程开关）→ Task 3/4；需求 4（端口）→ Task 3；需求 5（路径配置）→ Task 2；补充项 6（生命周期 stop）→ Task 3/4；7（下载指引）→ Task 6 README（调整为 static 包推荐）；8（解析链）→ Task 2；9（IPC 回报）→ Task 4；10（staticPlayer）→ Task 3；11（测试二进制）→ Task 1/2；12（双格式/exports/bin）→ Task 1/5。无遗漏。
2. **占位符扫描**：无 TBD/TODO；`src/server.ts` 的路由段以「原 26–128 行原样搬入」表达，源文件在仓库内可直接对照，非占位。
3. **类型一致性**：`configureBinaries`（Task 2 定义 = Task 3 调用）、`startInProcess`（Task 3 定义 = Task 4 child.ts 调用）、`killProcessTree`（Task 4 定义 = 同任务 index.ts 调用）、`PlayerServerOptions/PlayerServer`（Task 3 定义 = Task 4/5 使用）签名一致。
