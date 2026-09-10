# 播放器 UI 改版 + iframe 嵌入 + 画质/解码设置 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 播放器 UI 参照 etsme-h5 VideoPlayer 组件重做（PC/TV 双主题），前端改为 TS + Vite 构建，支持 iframe 嵌入（URL 参数），并落实真功能的画质阶梯（720p/1080p/2K/原画质）与硬解/软解设置。

**Architecture:** 服务端新增 `src/lib/quality.ts` 纯函数档位模块；`strategyChain` 扩展 `{quality, mode}` 选项（显式模式跳过直通、阶梯画质携带缩放与固定码率）；流请求级参数持久化到会话。前端源码 `src/client/`（TS），经新增 `vite.config.client.ts` 构建到 `dist/client/`，server 静态服务按 `public/` → `dist/client/` 顺序 fallback。demo 页改 iframe 嵌入。

**Tech Stack:** TypeScript、Vite（多配置）、vitest、express；前端无运行时框架（纯 TS + DOM）；测试用 ffmpeg 来自 devDependency `ffmpeg-static`/`ffprobe-static`。

**Spec:** `docs/superpowers/specs/2026-09-10-player-ui-iframe-design.md`（本计划从中展开，执行者需同读）

## Global Constraints

- 注释、日志、测试名一律中文（沿用现有风格）
- Node ≥ 18；永不调用系统 ffmpeg/ffprobe，路径一律经 `src/lib/ffmpeg-path.ts` 解析链
- 不得改动踩坑逻辑的行为：策略链降级约束（仅未输出字节时降级）、`pipe:1`、fMP4 movflags、`-map_chapters -1`、AAC 标准声道布局、QSV 显式解码器、Windows 杀进程树 `taskkill /pid X /T /F`、前端水位线（45s/15s）与自动恢复（`handleStreamFailure` 连续 4 次）、全部既有 REST 路径
- 输出不变式：视频恒 H.264，音频为 AAC（拷贝或转码）或不存在
- 执行环境是 Windows（win32/bash）
- 每个任务结束 `npm test` 全绿后 commit；前端任务加 `npm run typecheck` 验证
- 参考组件源码位于 `C:\workspace\etsme-h5\app-base\components\src\components\file-preview\video-preview\`（下称 `<ref>`），样式/交互值以它为准

## 全局类型约定（各任务共享）

```ts
// src/lib/quality.ts（Task 1 新增）
export type QualityId = '720p' | '1080p' | '2k' | 'origin';
export type TranscodeMode = 'auto' | 'hw' | 'sw';
export const QUALITY_TIERS: Record<Exclude<QualityId, 'origin'>, { height: number; kbps: number }>;
export const QUALITY_LABELS: Record<QualityId, string>;
export function availableQualities(probe: ProbeResult): QualityId[];   // 降序（高→低），origin 恒在末位
export function dimsFor(level: Exclude<QualityId, 'origin'>, probe: ProbeResult): { width: number; height: number };
export function bitrateKbps(level: Exclude<QualityId, 'origin'>): number;
export function parseQuality(v: unknown): QualityId | null;            // 非法返回 null
export function parseMode(v: unknown): TranscodeMode | null;

// src/lib/stream-strategy.ts（Task 2 扩展）
export interface Strategy {
  label: string; video: 'copy' | 'transcode'; audio: 'copy' | 'aac' | 'none';
  encoder?: string | null; videoBitrate?: number; audioLayout?: string | null;
  hwDecode?: string | null; decoder?: string | null;
  scale?: { width: number; height: number; vf: string } | null;  // 仅阶梯画质；vf 为完整 -vf 值
}
export interface StrategyOpts { quality?: QualityId; mode?: TranscodeMode; }
export function strategyChain(probe: ProbeResult, caps: Caps, opts?: StrategyOpts): Strategy[];

// src/lib/session-manager.ts（Task 4 扩展）
export interface Session {
  id: string; url: string; probeResult: ProbeResult; caps: Caps;
  requestedQuality: QualityId; requestedMode: TranscodeMode;
  chain: Strategy[]; chainIndex: number;
  process: { pid: number; kill(): void } | null;
  lastActivity: number; timeoutId: NodeJS.Timeout | null;
}
export async function createSession(url: string, opts?: { quality?: QualityId; mode?: TranscodeMode }): Promise<Session>;
export function startStream(session: Session, startTime: number, onData: (c: Buffer) => void,
  onError: (e: Error) => void, onExit: (code: number | null) => void,
  opts?: { createProc?: typeof createFfmpegProcess; quality?: QualityId; mode?: TranscodeMode });

// src/client/player-core.ts（Task 8 新增；注意前端展示序 origin 在前）
export type QualityId = 'origin' | '720p' | '1080p' | '2k';
export type ModeId = 'auto' | 'hw' | 'sw';
export interface SessionMeta { sessionId: string; duration: number; width: number; height: number;
  codec: string; audioCodec: string | null; pixFmt: string; streamMode: string; encoder: string | null;
  qualities: QualityId[]; hwAvailable: boolean; }
export interface PlayerCoreCallbacks { onStatus?(msg: string): void; onError?(msg: string): void; onLoading?(loading: boolean): void; }
export class PlayerCore {
  readonly video: HTMLVideoElement; readonly meta: SessionMeta;
  quality: QualityId; mode: ModeId;
  static async create(url: string, opts?: { quality?: QualityId; mode?: ModeId }, cb?: PlayerCoreCallbacks): Promise<PlayerCore>;
  start(startAt?: number, autoplay?: boolean): void;
  seek(t: number): void;
  restartWith(quality?: QualityId, mode?: ModeId): void;
  destroy(): Promise<void>;
}

// src/client/player-ui.ts（Task 9 新增）
export function mountPlayerUI(opts: { root: HTMLElement; core: PlayerCore; title?: string; ui?: 'pc' | 'tv'; callbacks: PlayerCoreCallbacks }): void;
```

---

### Task 1: 画质档位纯函数模块 `src/lib/quality.ts`

**Files:**
- Create: `src/lib/quality.ts`
- Test: `test/quality.test.ts`

**Interfaces:**
- Consumes: `ProbeResult`（`src/lib/ffprobe.ts`，含 `width/height`）
- Produces: `QualityId`/`TranscodeMode`/`QUALITY_TIERS`/`QUALITY_LABELS`/`availableQualities`/`dimsFor`/`bitrateKbps`/`parseQuality`/`parseMode`

- [ ] **Step 1: 写失败测试**

```ts
// test/quality.test.ts — 画质档位定义与解析（纯函数）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  availableQualities, dimsFor, parseQuality, parseMode, QUALITY_TIERS
} from '../src/lib/quality';
import type { ProbeResult } from '../src/lib/ffprobe';

const probe = (over?: Partial<ProbeResult>): ProbeResult => Object.assign({
  duration: 10, width: 1920, height: 1080, codec: 'h264', pixFmt: 'yuv420p',
  profile: 'High', fps: 30, audio: null
}, over) as ProbeResult;

test('可用档位：只展示严格低于源高度的档位 + 原画质（降序）', () => {
  assert.deepStrictEqual(availableQualities(probe({ width: 3840, height: 2160 })), ['2k', '1080p', '720p', 'origin']);
  assert.deepStrictEqual(availableQualities(probe()), ['720p', 'origin']);           // 1080 源：720p 严格更低
  assert.deepStrictEqual(availableQualities(probe({ width: 1280, height: 720 })), ['origin']); // 720 源无更低档
  assert.deepStrictEqual(availableQualities(probe({ width: 640, height: 360 })), ['origin']);
  assert.deepStrictEqual(availableQualities(probe({ width: 2560, height: 1440 })), ['720p', 'origin']); // 1440 源不含 2k
});

test('缩放尺寸：等比、偶数对齐、不放大', () => {
  assert.deepStrictEqual(dimsFor('720p', probe()), { width: 1280, height: 720 });
  assert.deepStrictEqual(dimsFor('720p', probe({ width: 2560, height: 1440 })), { width: 1280, height: 720 });
  // 4:3 源 → 高度 720，宽度按比例
  assert.deepStrictEqual(dimsFor('720p', probe({ width: 1440, height: 1080 })), { width: 960, height: 720 });
  // 奇数取偶
  const d = dimsFor('720p', probe({ width: 1365, height: 768 }));
  assert.strictEqual(d.width % 2, 0);
  assert.strictEqual(d.height % 2, 0);
  // 未知尺寸按 16:9 兜底
  assert.deepStrictEqual(dimsFor('720p', probe({ width: 0, height: 0 })), { width: 1280, height: 720 });
});

test('码率阶梯固定值', () => {
  assert.strictEqual(QUALITY_TIERS['720p'].kbps, 2500);
  assert.strictEqual(QUALITY_TIERS['1080p'].kbps, 5000);
  assert.strictEqual(QUALITY_TIERS['2k'].kbps, 10000);
});

test('参数解析：合法值原样返回，非法值 null', () => {
  assert.strictEqual(parseQuality('720p'), '720p');
  assert.strictEqual(parseQuality('origin'), 'origin');
  assert.strictEqual(parseQuality('4k'), null);
  assert.strictEqual(parseQuality(undefined), null);
  assert.strictEqual(parseMode('hw'), 'hw');
  assert.strictEqual(parseMode('sw'), 'sw');
  assert.strictEqual(parseMode('auto'), 'auto');
  assert.strictEqual(parseMode('gpu'), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/quality.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/lib/quality.ts`**

```ts
// src/lib/quality.ts — 画质档位定义、可用性过滤与缩放尺寸计算（纯函数，便于单测）。
// 前端"画质"菜单与此处的阶梯单一来源；服务端转码码率与缩放尺寸均由本模块产出。
import type { ProbeResult } from './ffprobe';

export type QualityId = '720p' | '1080p' | '2k' | 'origin';
export type TranscodeMode = 'auto' | 'hw' | 'sw';

/** 档位 → 目标高度与固定码率（kbps）。阶梯码率经确认：720p→2.5M / 1080p→5M / 2K→10M */
export const QUALITY_TIERS: Record<Exclude<QualityId, 'origin'>, { height: number; kbps: number }> = {
  '720p': { height: 720, kbps: 2500 },
  '1080p': { height: 1080, kbps: 5000 },
  '2k': { height: 1440, kbps: 10000 }
};

/** 展示名（响应 qualities 供前端菜单直接渲染） */
export const QUALITY_LABELS: Record<QualityId, string> = {
  '720p': '720P', '1080p': '1080P', '2k': '2K', origin: '原画质'
};

// 菜单展示顺序：从高到低，origin 恒在末位
const LADDER_DESC: Array<Exclude<QualityId, 'origin'>> = ['2k', '1080p', '720p'];

/** 可用档位：只展示严格低于源高度的档位（不放大）+ 原画质 */
export function availableQualities(probe: ProbeResult): QualityId[] {
  const list: QualityId[] = LADDER_DESC.filter(t => (probe.height || 0) > QUALITY_TIERS[t].height);
  list.push('origin');
  return list;
}

/**
 * 缩放目标尺寸：按源宽高比等比缩放到档位高度，宽高向下取偶（硬件编码器要求）。
 * 显式算出数值而不依赖 ffmpeg 滤镜的 -2 表达式：scale_qsv 等硬件滤镜需要具体数字。
 */
export function dimsFor(level: Exclude<QualityId, 'origin'>, probe: ProbeResult): { width: number; height: number } {
  const target = QUALITY_TIERS[level].height;
  const srcW = probe.width || 0;
  const srcH = probe.height || 0;
  if (!(srcW > 0) || !(srcH > 0)) {
    // 未知尺寸按 16:9 兜底（与 targetBitrateKbps 的兜底口径一致）
    const height = even(target);
    return { width: even(Math.round(height * 16 / 9)), height };
  }
  const height = even(Math.min(target, srcH)); // 不放大
  const width = even(Math.round((srcW * height) / srcH));
  return { width, height };
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** 档位固定码率（kbps） */
export function bitrateKbps(level: Exclude<QualityId, 'origin'>): number {
  return QUALITY_TIERS[level].kbps;
}

/** 解析请求中的画质参数；非档位值一律 null（调用方转 400） */
export function parseQuality(v: unknown): QualityId | null {
  return v === '720p' || v === '1080p' || v === '2k' || v === 'origin' ? v : null;
}

/** 解析转码/解码模式参数 */
export function parseMode(v: unknown): TranscodeMode | null {
  return v === 'auto' || v === 'hw' || v === 'sw' ? v : null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/quality.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/lib/quality.ts test/quality.test.ts
git commit -m "feat: 画质档位纯函数模块（阶梯码率/可用性过滤/缩放尺寸）"
```

---

### Task 2: `strategyChain` 扩展 `{quality, mode}` 选项

**Files:**
- Modify: `src/lib/stream-strategy.ts`
- Modify: `src/lib/hw-accel.ts`（EncoderProfile 增 `scaleHwFilter?` 字段，qsv = `'scale_qsv'`）
- Test: `test/stream-strategy.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `bitrateKbps`/`dimsFor`/`QualityId`/`TranscodeMode`
- Produces: `strategyChain(probe, caps, opts?)`；`Strategy.scale?: { width: number; height: number; vf: string } | null`

- [ ] **Step 1: 追加失败测试（test/stream-strategy.test.ts 末尾）**

```ts
// ===== 画质档位与解码模式（strategyChain opts）=====

test('不带 opts 时行为与旧版完全一致（回归）', () => {
  const chain = strategyChain(probe(), NVENC);
  assert.strictEqual(chain.length, 2);
  assert.strictEqual(chain[0].label, 'copy');
  assert.strictEqual(chain[1].encoder, 'h264_nvenc');
  assert.strictEqual((chain[1] as any).scale, undefined);
});

test('origin + auto 显式传入同样保持旧行为', () => {
  const chain = strategyChain(probe(), NVENC, { quality: 'origin', mode: 'auto' });
  assert.strictEqual(chain.length, 2);
  assert.strictEqual(chain[0].label, 'copy');
});

test('阶梯画质跳过直通：固定码率 + 缩放尺寸', () => {
  // 1080p 源选 720p：码率 2500k，缩放到 1280x720
  const chain = strategyChain(probe(), NVENC, { quality: '720p' });
  assert.strictEqual(chain.length, 1, '阶梯画质无 copy');
  const s = chain[0];
  assert.strictEqual(s.video, 'transcode');
  assert.strictEqual(s.videoBitrate, 2500);
  assert.ok(s.scale, '应携带缩放');
  assert.strictEqual(s.scale!.width, 1280);
  assert.strictEqual(s.scale!.height, 720);
  // nvenc 混合管线帧在系统内存 → 普通 scale 滤镜
  assert.strictEqual(s.scale!.vf, 'scale=1280:720');
});

test('阶梯画质 + sw 模式：libx264 也用固定码率，label=sw', () => {
  const chain = strategyChain(probe({ codec: 'hevc' }), NVENC, { quality: '720p', mode: 'sw' });
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].encoder, 'libx264');
  assert.strictEqual(chain[0].label, 'sw');
  assert.strictEqual(chain[0].videoBitrate, 2500);
});

test('mode=sw 跳过直通（可直通源也强制转码）', () => {
  const chain = strategyChain(probe(), NVENC, { mode: 'sw' });
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].encoder, 'libx264');
  assert.strictEqual(chain[0].label, 'sw');
  const baseline = strategyChain(probe(), NVENC);
  assert.strictEqual(chain[0].videoBitrate, baseline[1].videoBitrate, 'origin 转码码率仍走启发式');
});

test('mode=hw 跳过直通，硬件编码器优先', () => {
  const chain = strategyChain(probe(), NVENC, { mode: 'hw' });
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].encoder, 'h264_nvenc');
  assert.strictEqual(chain[0].label, 'hw');
});

test('mode=hw 但部署机无硬编 → 等价 libx264', () => {
  const chain = strategyChain(probe({ codec: 'hevc' }), SW, { mode: 'hw' });
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].encoder, 'libx264');
});

test('QSV 显式解码路径缩放用 scale_qsv 滤镜（帧驻留 GPU）', () => {
  // hevc 8bit 源 + qsv：decoder=hevc_qsv → GPU 帧 → scale_qsv
  const chain = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p', width: 2560, height: 1440 }), QSV, { quality: '1080p' });
  const s = chain[0];
  assert.strictEqual(s.decoder, 'hevc_qsv');
  assert.ok(s.scale!.vf.startsWith('scale_qsv=1920:1080'), `vf=${s.scale!.vf}`);
});

test('QSV 但源不可硬解（10bit）→ 软解帧在内存 → 普通 scale', () => {
  const chain = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p10le', width: 2560, height: 1440 }), QSV, { quality: '1080p' });
  const s = chain[0];
  assert.strictEqual(s.decoder, null);
  assert.strictEqual(s.scale!.vf, 'scale=1920:1080');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/stream-strategy.test.ts`
Expected: FAIL（strategyChain 不接受第三参 / scale 不存在）

- [ ] **Step 3: 实现**

`src/lib/hw-accel.ts`：`EncoderProfile` 接口追加字段，并在 `h264_qsv` profile 中赋值：

```ts
export interface EncoderProfile {
  mode: 'hybrid' | 'sw';
  hwaccel: string | null;
  hwDecodableCodecs: string[];
  encodeArgs: string[];
  label: string;
  decoderByCodec?: Record<string, string>;
  /** 显式硬件解码器路径帧驻留 GPU，普通 scale 滤镜无法处理；指定该厂商的硬件缩放滤镜（如 scale_qsv） */
  scaleHwFilter?: string;
}
```

```ts
// h264_qsv profile 的 decoderByCodec 之后追加：
    // 显式解码器输出 qsv GPU 帧，缩放必须走硬件 vpp 滤镜（普通 scale 会报格式转换错误）
    scaleHwFilter: 'scale_qsv',
```

`src/lib/stream-strategy.ts` 全量替换为：

```ts
// src/lib/stream-strategy.ts
// 格式自适应决策：根据源视频探针结果 + 部署机硬件能力 + 播放请求参数（画质档/解码模式），
// 产出按优先级排列的播放策略链。纯函数，不触碰进程/IO，便于单测。
import { ENCODER_PROFILES, type EncoderProfile, type Caps } from './hw-accel';
import type { ProbeResult } from './ffprobe';
import { bitrateKbps, dimsFor, type QualityId, type TranscodeMode } from './quality';

// 字段与旧 JS 策略对象一致：copy 策略会显式携带 null（测试断言 null 而非缺省）
export interface Strategy {
  label: string;
  video: 'copy' | 'transcode';
  audio: 'copy' | 'aac' | 'none';
  encoder?: string | null;
  videoBitrate?: number;
  audioLayout?: string | null;
  hwDecode?: string | null;
  decoder?: string | null;
  /** 画质档缩放（仅阶梯画质）：vf 为完整 -vf 值（含滤镜名与尺寸） */
  scale?: { width: number; height: number; vf: string } | null;
}

/** 播放请求参数：quality=画质档（默认 origin）、mode=转码/解码模式（默认 auto = 现行自动策略） */
export interface StrategyOpts {
  quality?: QualityId;
  mode?: TranscodeMode;
}

/**
 * 直通（remux）资格：浏览器 MSE 可直接解码的 H.264 8bit 4:2:0。
 * 10bit（yuv420p10le）、422/444 等一概转码。
 */
function copyEligible(probeResult: ProbeResult): boolean {
  return probeResult.codec === 'h264' && probeResult.pixFmt === 'yuv420p';
}

/** 音频策略：AAC 拷贝、其余转 AAC（播放端永远拿到 AAC）、无音频关闭 */
function audioStrategy(probeResult: ProbeResult): 'copy' | 'aac' | 'none' {
  if (!probeResult.audio) return 'none';
  return probeResult.audio.codec === 'aac' ? 'copy' : 'aac';
}

/**
 * AAC 转码的目标声道布局：
 * ffmpeg AAC 编码器对 5.1(side) 等非标准映射布局会写出 channelConfiguration=0
 * （声道信息放 PCE）的 ASC，Chrome MSE 的 MP4 解析器拒绝这种 extradata
 * （CHUNK_DEMUXER_ERROR_APPEND_FAILED）。强制映射为 AAC 标准布局
 * （6 声道 → 5.1 back、8 声道 → 7.1 back，均已实测被 Chrome 接受）。
 */
function audioLayout(probeResult: ProbeResult): string | null {
  if (!probeResult.audio) return null;
  const ch = probeResult.audio.channels || 0;
  if (ch <= 2) return null;
  return ch <= 6 ? '5.1' : '7.1';
}

/**
 * 硬解资格：编码器硬件支持该编码，且源为 8bit 4:2:0。
 *
 * 只允许 8bit（yuv420p）：输出恒为 H.264（8bit），而 qsv/cuda 硬解的 10bit 帧
 * 留在 GPU（P010/qsv 表面），既无法被 H.264 硬件编码器接受，也不能自动转换；
 * 10bit 源走软解（帧在内存，自动 swscale 转 8bit）+ 硬件编码。
 * 硬解提示不可用时 ffmpeg 自动回退软解，编码不受影响。
 */
function hwDecodable(profile: EncoderProfile, probeResult: ProbeResult): boolean {
  if (!profile.hwaccel) return false;
  if (!profile.hwDecodableCodecs.includes(probeResult.codec)) return false;
  return probeResult.pixFmt === 'yuv420p';
}

/**
 * 转码目标码率（kbps）：0.1 bits/pixel 启发式。
 * 1080p30 ≈ 6.2Mbps、4K30 ≈ 25Mbps、4K60 ≈ 50Mbps。
 * 不指定时硬件编码器（qsv 等）默认走极低码率目标，是 4K 发糊的根因。
 */
function targetBitrateKbps(probeResult: ProbeResult): number {
  const { width = 0, height = 0, fps = 0 } = probeResult;
  if (!(width > 0) || !(height > 0)) return 6000; // 未知尺寸按 1080p 档
  const kbps = width * height * (fps > 0 ? fps : 30) * 0.1 / 1000;
  return Math.round(Math.min(Math.max(kbps, 1500), 60000));
}

/** 构造转码策略：按编码器 profile 决定硬解方式与编码器 */
function transcodeStrategy(probeResult: ProbeResult, caps: Caps, quality: QualityId, mode: TranscodeMode): Strategy {
  // 显式 sw 模式强制 libx264；其余按探测到的最优编码器（无硬编时 caps.encoder 即 libx264）
  const encoder = mode === 'sw' ? 'libx264' : caps.encoder;
  const profile = ENCODER_PROFILES[encoder] || ENCODER_PROFILES.libx264;
  const canHwDecode = hwDecodable(profile, probeResult);
  // 显式硬件解码器（如 hevc_qsv）：优先于 -hwaccel 提示使用。
  // 实测 qsv 上 -hwaccel 提示 + 硬件编码器组合存在每帧表面泄漏
  // （内存 ~48MB/s 增长，数分钟后 ffmpeg 崩溃），显式解码器则稳定。
  const decoder = canHwDecode ? (profile.decoderByCodec?.[probeResult.codec] || null) : null;

  // 阶梯画质：固定码率 + 等比缩放；origin：现行启发式码率 + 不缩放
  const ladder = quality !== 'origin';
  const videoBitrate = ladder ? bitrateKbps(quality) : targetBitrateKbps(probeResult);

  let scale: Strategy['scale'] = null;
  if (ladder) {
    const { width, height } = dimsFor(quality as Exclude<QualityId, 'origin'>, probeResult);
    // 显式解码器帧驻留 GPU（qsv 表面），普通 scale 滤镜会报格式转换错误，须用厂商硬件缩放滤镜；
    // 混合提示路径（-hwaccel 无 output_format 限定）帧自动回落系统内存，普通 scale 即可
    const filter = decoder ? (profile.scaleHwFilter || 'scale') : 'scale';
    scale = { width, height, vf: `${filter}=${width}:${height}` };
  }

  return {
    label: profile.mode === 'sw' ? 'sw' : 'hw',
    video: 'transcode',
    encoder,
    hwDecode: canHwDecode ? profile.hwaccel : null,
    decoder,
    videoBitrate,
    scale,
    audio: audioStrategy(probeResult),
    audioLayout: audioStrategy(probeResult) === 'aac' ? audioLayout(probeResult) : null
  };
}

/**
 * 策略链：直通资格时 [copy, 转码]，否则 [转码]。
 * 上游失败时按序取下一个重试（见 session-manager）。
 *
 * 直通豁免规则：显式选择了解码模式（hw/sw）或指定了阶梯画质时跳过 copy——
 * 直通不经任何解码，与"解码设置"语义冲突；阶梯画质必然重编码。
 *
 * @param {object} probeResult - ffprobe 结果（codec/pixFmt/audio）
 * @param {{encoder: string, mode: string}} caps - hw-accel 探测结果
 * @param {StrategyOpts} [opts] - 画质档与解码模式（缺省 = 完全旧行为）
 */
export function strategyChain(probeResult: ProbeResult, caps: Caps, opts: StrategyOpts = {}): Strategy[] {
  const quality = opts.quality ?? 'origin';
  const mode = opts.mode ?? 'auto';
  const copyAllowed = quality === 'origin' && mode === 'auto';

  const chain: Strategy[] = [];
  if (copyAllowed && copyEligible(probeResult)) {
    chain.push({
      label: 'copy',
      video: 'copy',
      encoder: null,
      hwDecode: null,
      audio: audioStrategy(probeResult),
      audioLayout: null
    });
  }
  chain.push(transcodeStrategy(probeResult, caps, quality, mode));
  return chain;
}
```

- [ ] **Step 4: 运行测试确认通过（含旧行为回归）**

Run: `npx vitest run test/stream-strategy.test.ts test/quality.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/stream-strategy.ts src/lib/hw-accel.ts test/stream-strategy.test.ts
git commit -m "feat: 策略链支持画质档与解码模式（阶梯码率/缩放/直通豁免）"
```

---

### Task 3: `buildArgs` 支持缩放滤镜与 libx264 阶梯码率

**Files:**
- Modify: `src/lib/ffmpeg-process.ts`（buildArgs 的转码分支）
- Test: `test/ffmpeg-process.test.ts`（追加用例）

**Interfaces:**
- Consumes: `Strategy.scale.vf`（完整 -vf 值）、`Strategy.videoBitrate`
- Produces: 命令行含 `-vf <vf>`；带 scale 的 libx264 策略用 `-b:v/-maxrate/-bufsize` 而非 `-crf`

- [ ] **Step 1: 追加失败测试**

```ts
// ===== 画质档：缩放滤镜与 libx264 固定码率 =====

const swLadder: Strategy = {
  label: 'sw', video: 'transcode', encoder: 'libx264', hwDecode: null,
  audio: 'none', videoBitrate: 2500, scale: { width: 1280, height: 720, vf: 'scale=1280:720' }
};
const qsvLadder: Strategy = {
  label: 'hw', video: 'transcode', encoder: 'h264_qsv', hwDecode: 'qsv', decoder: 'hevc_qsv',
  audio: 'aac', videoBitrate: 5000, scale: { width: 1920, height: 1080, vf: 'scale_qsv=1920:1080' }
};

test('阶梯画质（libx264）：固定码率模式，不用 CRF', () => {
  const a = buildArgs('u', 0, swLadder);
  assert.ok(idx(a, '-b:v') !== -1 && a[idx(a, '-b:v') + 1] === '2500k', JSON.stringify(a));
  assert.ok(idx(a, '-maxrate') !== -1 && parseInt(a[idx(a, '-maxrate') + 1]) > 2500);
  assert.strictEqual(idx(a, '-crf'), -1, '阶梯码率下 libx264 不用 CRF');
});

test('阶梯画质：-vf 滤镜按策略 vf 值输出', () => {
  assert.ok(buildArgs('u', 0, swLadder).includes('scale=1280:720'));
  const a = buildArgs('u', 0, qsvLadder);
  assert.ok(a.includes('scale_qsv=1920:1080'), 'QSV 显式解码帧在 GPU，须用 scale_qsv');
  // -vf 与 -af 可共存（音频声道布局滤镜独立）
  const i = idx(a, '-vf');
  assert.ok(i !== -1 && a[i + 1] === 'scale_qsv=1920:1080');
});

test('origin 转码（无 scale）：libx264 保持 CRF、无 -vf（回归）', () => {
  const a = buildArgs('u', 0, swStrat);
  assert.ok(idx(a, '-crf') !== -1);
  assert.strictEqual(idx(a, '-vf'), -1);
});

test('直通路径无 -vf（回归）', () => {
  assert.strictEqual(idx(buildArgs('u', 0, copyStrat), '-vf'), -1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/ffmpeg-process.test.ts`
Expected: FAIL（-vf / 阶梯码率断言失败）

- [ ] **Step 3: 实现修改 buildArgs 转码分支**

`src/lib/ffmpeg-process.ts` 中 `if (strategy.video === 'copy') {...} else {...}` 的 else 分支替换为：

```ts
  } else {
    const profile = ENCODER_PROFILES[strategy.encoder as string] || ENCODER_PROFILES.libx264;
    // 阶梯画质（带 scale）→ 固定码率模式，libx264 也不例外（画质档=明确码率契约）；
    // origin 软转码保持 CRF 23 质量优先（与原行为一致）
    const kbps = strategy.videoBitrate || 6000;
    const maxrate = Math.round(kbps * 1.5);
    if (strategy.encoder === 'libx264' && !strategy.scale) {
      outputOpts.push(
        '-c:v', strategy.encoder,
        ...profile.encodeArgs,
        '-crf', '23',
        '-force_key_frames', 'expr:eq(n,0)',
        '-threads', '0', '-bufsize', '2M'
      );
    } else {
      // 硬件编码器不会自动做质量自适应，必须显式指定码率控制，
      // 否则 qsv 等默认极低码率目标导致高分辨率发糊
      outputOpts.push(
        '-c:v', strategy.encoder!,
        ...profile.encodeArgs,
        '-b:v', `${kbps}k`,
        '-maxrate', `${maxrate}k`,
        '-bufsize', `${maxrate * 2}k`,
        '-force_key_frames', 'expr:eq(n,0)'
      );
    }
    // 画质档缩放：vf 值由 stream-strategy 组装（含厂商滤镜选择）
    if (strategy.scale) {
      outputOpts.push('-vf', strategy.scale.vf);
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/ffmpeg-process.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/ffmpeg-process.ts test/ffmpeg-process.test.ts
git commit -m "feat: buildArgs 支持画质档缩放滤镜与 libx264 固定码率"
```

---

### Task 4: `session-manager` 请求参数持久化与策略链重算

**Files:**
- Modify: `src/lib/session-manager.ts`
- Test: `test/session-manager.test.ts`（追加用例）

**Interfaces:**
- Consumes: `strategyChain(probe, caps, opts)`、`QualityId`/`TranscodeMode`
- Produces: `createSession(url, {quality?, mode?})`；`startStream(..., {quality?, mode?})`；`Session.caps/requestedQuality/requestedMode`

- [ ] **Step 1: 追加失败测试**

```ts
// ===== 画质档/解码模式：会话参数与策略链重算 =====

test('createSession 携带 quality/mode：链按参数计算', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Aac, { quality: '720p', mode: 'sw' });
  assert.strictEqual(session.requestedQuality, '720p');
  assert.strictEqual(session.requestedMode, 'sw');
  assert.strictEqual(session.chain.length, 1, '显式参数跳过直通');
  assert.strictEqual(session.chain[0].encoder, 'libx264');
  destroySession(session.id);
});

test('startStream 显式参数与当前设置不同 → 重算链并重置降级进度', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Hi10, { mode: 'hw' }); // 单策略转码（硬编优先）

  const calls: string[] = [];
  const factory = fakeFactory([{ data: 10 }], calls);
  startStream(session, 0, () => {}, () => {}, () => {}, { createProc: factory, mode: 'sw' });

  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(session.requestedMode, 'sw');
  assert.strictEqual(session.chain[0].encoder, 'libx264', '链已按新参数重算');
  assert.deepStrictEqual(calls, ['sw']);
  destroySession(session.id);
});

test('startStream 不带参数 → 沿用会话当前设置', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Aac); // [copy, 转码]
  const calls: string[] = [];
  const factory = fakeFactory([{ data: 10 }], calls);
  startStream(session, 0, () => {}, () => {}, () => {}, { createProc: factory });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(session.chainIndex, 0);
  destroySession(session.id);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/session-manager.test.ts`
Expected: FAIL（createSession/startStream 不接受参数）

- [ ] **Step 3: 实现**

`src/lib/session-manager.ts` 文件头 import 区追加：

```ts
import type { Caps } from './hw-accel';
import { type QualityId, type TranscodeMode } from './quality';
```

`Session` 接口替换为：

```ts
export interface Session {
  id: string;
  url: string;
  probeResult: ProbeResult;
  caps: Caps;                                   // 会话创建时的硬件能力快照（重算链用，避免 startStream 异步化）
  requestedQuality: QualityId;                  // 当前画质档（流请求参数持久化于此）
  requestedMode: TranscodeMode;                 // 当前解码模式
  chain: Strategy[];
  chainIndex: number;
  process: { pid: number; kill(): void } | null;
  lastActivity: number;
  timeoutId: NodeJS.Timeout | null;
}
```

`createSession` 替换为：

```ts
/**
 * 创建会话：探测元数据 + 结合硬件能力与播放参数计算策略链
 * @param {string} url
 * @param {{quality?: QualityId, mode?: TranscodeMode}} [opts] - 画质档/解码模式（缺省 origin/auto = 旧行为）
 * @returns {Promise<Session>}
 */
export async function createSession(
  url: string,
  opts: { quality?: QualityId; mode?: TranscodeMode } = {}
): Promise<Session> {
  const id = generateId();
  const [probeResult, caps] = await Promise.all([probe(url), getCaps()]);
  const requestedQuality = opts.quality ?? 'origin';
  const requestedMode = opts.mode ?? 'auto';
  const session: Session = {
    id,
    url,
    probeResult,
    caps,
    requestedQuality,
    requestedMode,
    chain: strategyChain(probeResult, caps, { quality: requestedQuality, mode: requestedMode }),
    chainIndex: 0,
    process: null,
    lastActivity: Date.now(),
    timeoutId: null
  };
  sessions.set(id, session);
  scheduleCleanup(session);
  return session;
}
```

`startStream` 签名与开头替换（函数体其余部分不动）：

```ts
export function startStream(
  session: Session,
  startTime: number,
  onData: (chunk: Buffer) => void,
  onError: (err: Error) => void,
  onExit: (code: number | null) => void,
  opts: { createProc?: typeof createFfmpegProcess; quality?: QualityId; mode?: TranscodeMode } = {}
): { pid: number; kill(): void } {
  // 流请求显式携带 quality/mode（画质/解码切换、断线恢复重连）→ 更新会话设置并重算策略链；
  // 仅在变更时重算，普通 seek 沿用现有链与降级进度。断线自动恢复重连不带参数，
  // 依赖这里持久化的设置，不会静默跳回原画质
  const quality = opts.quality ?? session.requestedQuality;
  const mode = opts.mode ?? session.requestedMode;
  if (quality !== session.requestedQuality || mode !== session.requestedMode) {
    session.requestedQuality = quality;
    session.requestedMode = mode;
    session.chain = strategyChain(session.probeResult, session.caps, { quality, mode });
    session.chainIndex = 0;
  }

  // 先停止旧进程
  stopStream(session);
  // ……（其余保持原样：createProc/currentStrategy/降级/onExit 等）
```

- [ ] **Step 4: 运行测试确认通过（含旧用例回归）**

Run: `npx vitest run test/session-manager.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/session-manager.ts test/session-manager.test.ts
git commit -m "feat: 会话持久化画质/解码参数并按需重算策略链"
```

---

### Task 5: server 路由扩展（参数校验、响应字段、静态 fallback）

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 `parseQuality/parseMode/availableQualities`、Task 4 `createSession/startStream`
- Produces: POST `/api/sessions` 响应新增 `qualities/hwAvailable/requestedQuality/requestedMode`；GET `/stream?quality=&mode=`；静态目录 fallback `public/` → `dist/client/`

- [ ] **Step 1: 追加失败测试（test/server.test.ts 的 describe 块内）**

```ts
  test('POST /api/sessions 响应含画质档列表与硬编可用性', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples();
    const res = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac })
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.qualities)).toBe(true);
    expect(body.qualities).toContain('origin');
    expect(typeof body.hwAvailable).toBe('boolean');
    expect(body.requestedQuality).toBe('origin');
    expect(body.requestedMode).toBe('auto');
  });

  test('POST 非法 quality/mode → 400', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples();
    for (const body of [
      { url: samples.h264Aac, quality: '4k' },
      { url: samples.h264Aac, mode: 'gpu' }
    ]) {
      const res = await fetch(`${server.url}/api/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      expect(res.status).toBe(400);
    }
  });

  test('画质档不可用（低清源选高画质）→ 400 且会话不留存', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples(); // 320x240 样本
    const res = await fetch(`${server.url}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac, quality: '1080p' })
    });
    expect(res.status).toBe(400);
    expect(getSessionCount()).toBe(0);
  });

  test('GET /stream 非法 quality/mode 参数 → 400', async () => {
    server = await startServer({ port: 0 });
    const samples = ensureSamples();
    const create = await fetch(`${server.url}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: samples.h264Aac })
    });
    const { sessionId } = await create.json();
    const res = await fetch(`${server.url}/api/sessions/${sessionId}/stream?start=0&quality=4k`);
    expect(res.status).toBe(400);
  });

  test('静态服务覆盖 public/（demo 页）', async () => {
    server = await startServer({ port: 0 });
    const demo = await fetch(`${server.url}/index.html`);
    expect(demo.ok).toBe(true);
    // dist/client/ 的播放器页（player.html）断言在 Task 6 构建链建立后补充
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL（响应无 qualities / player.html 404）

- [ ] **Step 3: 实现 `src/server.ts`**

文件头 import 区：

```ts
import { existsSync } from 'fs';
import { parseQuality, parseMode, availableQualities } from './lib/quality';
```

静态目录部分（在 `const publicDir = ...` 之后追加）：

```ts
// 前端 TS 构建产物（player.html 等，见 vite.config.client.ts）：
// dist 产物模式下与 public 同级（<pkg>/dist/client）；源码模式（vitest）在仓库根/dist/client
const clientDir = [path.resolve(here, 'client'), path.resolve(here, '../dist/client')]
  .find((p) => existsSync(p));
```

静态服务（替换原 `app.use(express.static(publicDir));`）：

```ts
  app.use(express.json());
  if (options.staticPlayer !== false) {
    // 先 public（demo 页）后 dist/client（播放器页）：两目录文件名不冲突，
    // 顺序仅决定同名文件（不存在）的优先级
    app.use(express.static(publicDir));
    if (clientDir) app.use(express.static(clientDir));
  }
```

POST `/api/sessions` 替换为：

```ts
  // 创建会话
  app.post('/api/sessions', async (req, res) => {
    try {
      const { url, quality, mode } = req.body ?? {};
      if (!url) {
        return res.status(400).json({ error: 'url is required' });
      }
      // 画质档/解码模式：非法值 400；合法值持久化到会话（后续流请求沿用）
      const q = parseQuality(quality ?? 'origin');
      const m = parseMode(mode ?? 'auto');
      if (!q) return res.status(400).json({ error: `invalid quality: ${quality}` });
      if (!m) return res.status(400).json({ error: `invalid mode: ${mode}` });

      const session = await createSession(url, { quality: q, mode: m });
      // 画质档必须在源可用范围内（不放大）；不可用时立即销毁会话，不留副作用
      if (!availableQualities(session.probeResult).includes(q)) {
        destroySession(session.id);
        return res.status(400).json({
          error: `quality ${q} 不可用（源 ${session.probeResult.width}x${session.probeResult.height}）`
        });
      }
      console.log(
        `Session created: ${session.id} for ${url} ` +
        `(strategy=${currentStrategy(session).label}, codec=${session.probeResult.codec}/${session.probeResult.pixFmt}, ` +
        `quality=${q}, mode=${m})`
      );

      const strategy = currentStrategy(session);
      const caps = await hwCapsPromise;
      res.json({
        sessionId: session.id,
        duration: session.probeResult.duration,
        width: session.probeResult.width,
        height: session.probeResult.height,
        codec: session.probeResult.codec,
        // 输出视频恒为 H.264；音频存在时恒为 AAC（拷贝或转码）
        audioCodec: session.probeResult.audio ? 'aac' : null,
        pixFmt: session.probeResult.pixFmt,
        streamMode: strategy.label,                       // copy | hw | sw
        encoder: strategy.encoder || strategy.label,      // 直通时无编码器
        hw: strategy.label === 'hw',
        // 可用画质档（降序，origin 恒在末位）与硬编可用性（前端渲染菜单/显隐"硬解"选项）
        qualities: availableQualities(session.probeResult),
        hwAvailable: caps.encoder !== 'libx264',
        requestedQuality: q,
        requestedMode: m
      });
    } catch (err) {
      console.error('Failed to create session:', (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });
```

GET `/stream` 在 `const startTime = ...` 之后追加参数解析，`startStream` 调用追加 opts：

```ts
    const startTime = parseFloat(String(req.query.start)) || 0;

    // 可选画质/解码参数：非法值 400；合法值经 startStream 持久化到会话
    const quality = req.query.quality !== undefined ? parseQuality(req.query.quality) : undefined;
    const mode = req.query.mode !== undefined ? parseMode(req.query.mode) : undefined;
    if (req.query.quality !== undefined && !quality) {
      return res.status(400).json({ error: `invalid quality: ${req.query.quality}` });
    }
    if (req.query.mode !== undefined && !mode) {
      return res.status(400).json({ error: `invalid mode: ${req.query.mode}` });
    }
```

```ts
    const myProc = startStream(
      session,
      startTime,
      (chunk) => { /* 原样 */ },
      (err) => { /* 原样 */ },
      () => { /* 原样 */ },
      { quality: quality ?? undefined, mode: mode ?? undefined }
    );
```

- [ ] **Step 4: 构建后运行测试确认通过**

Run: `npm run build && npx vitest run test/server.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: 会话/流路由支持画质与解码参数，静态服务覆盖 dist/client"
```

---

---
### Task 6: 前端构建链（vite client 配置 + tsconfig + player.html 骨架）

**Files:**
- Create: `vite.config.client.ts`、`tsconfig.client.json`、`src/client/player.html`、`src/client/player-entry.ts`（骨架）、`src/client/player.css`（外壳）
- Modify: `package.json`（build/typecheck 脚本）、`tsconfig.json`（exclude src/client）

**Interfaces:**
- Produces: `npm run build` 产出 `dist/client/player.html` + `dist/client/assets/*`；`npm run typecheck` 校验两端 TS。后续前端任务以 `player-entry.ts` 为唯一入口。

- [ ] **Step 1: 创建 `vite.config.client.ts`**

```ts
// vite.config.client.ts — 播放器前端构建：src/client → dist/client（express 静态服务）。
// 独立于主库三配置（lib/child/bin 均针对 Node 运行时）；前端产物经 server.ts 的
// 静态 fallback（public/ → dist/client/）对外服务。
import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/client', import.meta.url)),
  base: '/',
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: { player: fileURLToPath(new URL('./src/client/player.html', import.meta.url)) }
    }
  }
});
```

- [ ] **Step 2: 创建 `tsconfig.client.json` 并调整根 tsconfig**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src/client"]
}
```

根 `tsconfig.json` 追加 exclude（根配置无 DOM lib；vite-plugin-dts 也因此不受前端源码影响）：

```json
  "include": ["src", "test"],
  "exclude": ["src/client"]
```

- [ ] **Step 3: 创建 player.html 与骨架入口/样式**

```html
<!-- src/client/player.html — iframe 嵌入的播放器页（URL 参数见 README） -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>视频播放</title>
</head>
<body>
  <div id="app" class="video-player ui-pc"></div>
  <script type="module" src="./player-entry.ts"></script>
</body>
</html>
```

```ts
// src/client/player-entry.ts — 播放器页装配入口（Task 11 完整实现，当前为构建链骨架）
import './player.css';

const app = document.getElementById('app');
if (app) app.textContent = '播放器加载中…';
```

```css
/* src/client/player.css — 播放器样式（Task 9/10 分主题补全；当前仅外壳） */
html, body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
}

.video-player {
  width: 100%;
  height: 100%;
  position: relative;
}
```

- [ ] **Step 4: 更新 package.json scripts**

```json
  "scripts": {
    "start": "node dist/bin.cjs",
    "build": "vite build && vite build -c vite.config.child.ts && vite build -c vite.config.bin.ts && vite build -c vite.config.client.ts",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.client.json",
    "test": "npm run build && vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 5: 构建与类型检查通过**

Run: `npm run build && npm run typecheck`
Expected: dist/client/player.html 生成；typecheck 无错误

- [ ] **Step 6: 追加 dist/client 静态路由断言（test/server.test.ts describe 块内）**

```ts
  test('dist/client/ 静态服务可访问 player.html（前端构建产物）', async () => {
    server = await startServer({ port: 0 });
    // 依赖本任务建立的构建链产出 dist/client/player.html
    const player = await fetch(`${server.url}/player.html`);
    expect(player.ok).toBe(true);
    expect(await player.text()).toContain('player-entry');
  });
```

- [ ] **Step 7: 全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add vite.config.client.ts tsconfig.client.json tsconfig.json src/client package.json test/server.test.ts
git commit -m "feat: 前端 TS 构建链（vite client 多入口 + typecheck）"
```

---

### Task 7: 图标资产（复制 5 + 新增 3）与注入模块

**Files:**
- Create: `src/client/icons/{play,pause,volume-mute,volume-unmute,cog,arrow-down,fullscreen,fullscreen-exit}.svg`、`src/client/icons.ts`

**Interfaces:**
- Produces: `injectIcon(el, name)` 与 `IconName` 类型（Task 9 UI 使用）

- [ ] **Step 1: 复制参考组件的 5 个图标（SVG 根元素原样保存，内容已核对）**

`src/client/icons/play.svg`：
```html
<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 24 24">
  <path fill-rule="evenodd" d="M8.6 5.2A1 1 0 0 0 7 6v12a1 1 0 0 0 1.6.8l8-6a1 1 0 0 0 0-1.6l-8-6Z" clip-rule="evenodd" />
</svg>
```

`src/client/icons/pause.svg`：
```html
<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 24 24">
  <path fill-rule="evenodd" d="M8 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H8Zm7 0a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1Z" clip-rule="evenodd" />
</svg>
```

`src/client/icons/volume-mute.svg`：
```html
<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24">
  <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.5 8.43A4.985 4.985 0 0 1 17 12c0 1.126-.5 2.5-1.5 3.5m2.864-9.864A8.972 8.972 0 0 1 21 12c0 2.023-.5 4.5-2.5 6M7.8 7.5l2.56-2.133a1 1 0 0 1 1.64.768V12m0 4.5v1.365a1 1 0 0 1-1.64.768L6 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1m1-4 14 14" />
</svg>
```

`src/client/icons/volume-unmute.svg`：
```html
<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24">
  <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17.5 8.43A4.985 4.985 0 0 1 19 12a4.984 4.984 0 0 1-1.43 3.5M14 6.135v11.73a1 1 0 0 1-1.64.768L8 15H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l4.36-3.633a1 1 0 0 1 1.64.768Z" />
</svg>
```

`src/client/icons/cog.svg`：
```html
<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24">
  <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 13v-2a1 1 0 0 0-1-1h-.757l-.707-1.707.535-.536a1 1 0 0 0 0-1.414l-1.414-1.414a1 1 0 0 0-1.414 0l-.536.535L14 4.757V4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v.757l-1.707.707-.536-.535a1 1 0 0 0-1.414 0L4.929 6.343a1 1 0 0 0 0 1.414l.536.536L4.757 10H4a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h.757l.707 1.707-.535.536a1 1 0 0 0 0 1.414l1.414 1.414a1 1 0 0 0 1.414 0l.536-.535 1.707.707V20a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-.757l1.707-.708.536.536a1 1 0 0 0 1.414 0l1.414-1.414a1 1 0 0 0 0-1.414l-.535-.536.707-1.707H20a1 1 0 0 0 1-1Z" />
  <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
</svg>
```

- [ ] **Step 2: 新增 3 个配套图标（参考组件用图标字体/antd，此处以同风格 1.5 描边补齐）**

`src/client/icons/arrow-down.svg`（ext 面板返回，对应 PCController 的 et-icon arrow-down / TVController 的 DownOutlined）：
```html
<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24">
  <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m6 9 6 6 6-6" />
</svg>
```

`src/client/icons/fullscreen.svg`（进入全屏）：
```html
<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24">
  <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
</svg>
```

`src/client/icons/fullscreen-exit.svg`（退出全屏）：
```html
<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24">
  <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 0-2-2H3" />
</svg>
```

- [ ] **Step 3: 创建 `src/client/icons.ts`**

```ts
// src/client/icons.ts — 图标注入：以 ?raw 内联 SVG 文本（保留 currentColor，
// 注入后随容器 color 变色；避免 <img> 引用导致图标恒黑）
import play from './icons/play.svg?raw';
import pause from './icons/pause.svg?raw';
import volumeMute from './icons/volume-mute.svg?raw';
import volumeUnmute from './icons/volume-unmute.svg?raw';
import cog from './icons/cog.svg?raw';
import arrowDown from './icons/arrow-down.svg?raw';
import fullscreen from './icons/fullscreen.svg?raw';
import fullscreenExit from './icons/fullscreen-exit.svg?raw';

export type IconName =
  | 'play' | 'pause' | 'volume-mute' | 'volume-unmute'
  | 'cog' | 'arrow-down' | 'fullscreen' | 'fullscreen-exit';

const ICONS: Record<IconName, string> = {
  play, pause,
  'volume-mute': volumeMute, 'volume-unmute': volumeUnmute,
  cog, 'arrow-down': arrowDown,
  fullscreen, 'fullscreen-exit': fullscreenExit
};

/** 将图标 SVG 注入元素（覆盖 innerHTML） */
export function injectIcon(el: HTMLElement | null, name: IconName): void {
  if (el) el.innerHTML = ICONS[name];
}
```

- [ ] **Step 4: 构建 + 类型检查**

Run: `npm run build && npm run typecheck`
Expected: PASS（vite 处理 ?raw 导入；vite/client 类型声明覆盖）

- [ ] **Step 5: 提交**

```bash
git add src/client/icons src/client/icons.ts
git commit -m "feat: 播放器图标资产（复制 5 个 + 补齐 3 个）与注入模块"
```

---

### Task 8: `player-core.ts` MSE 核心迁移（DOM 解耦 + quality/mode 参数）

**Files:**
- Create: `src/client/player-core.ts`
- Modify: `src/client/player-entry.ts`（临时接线，验证编译）

**Interfaces:**
- Consumes: Task 5 的 POST 响应字段（`qualities/hwAvailable` 等）
- Produces: `PlayerCore` 类与 `PlayerCoreCallbacks`（见全局类型约定）

核心逻辑自 `public/player.js` 原样迁移（保留全部中文注释），差异：DOM 引用改为 `video` 元素 + 回调；流 URL 追加 `quality`/`mode`；新增 `restartWith`（画质/解码切换 = seek 同路径重建）。

- [ ] **Step 1: 实现 `src/client/player-core.ts`（全量）**

```ts
// src/client/player-core.ts — MSE 播放核心：会话管理、fMP4 流式播放、精确 seek（重建 MediaSource）。
// 自 public/player.js 迁移：DOM 解耦为回调；流请求携带 quality/mode（画质档/解码模式）。
//
// 设计要点（沿袭原实现，勿改）：
// - 服务端固定输出 H.264 fMP4（frag_keyframe+empty_moov+default_base_moof），
//   SourceBuffer codec 恒取 H.264 候选 + AAC-LC。
// - 每次流请求触发服务端 kill 旧 ffmpeg 并从新位置重转码，时间线从 0 起算 →
//   seek/换档必须重建 MediaSource（timestampOffset 对齐原片位置）。
// - pumpReader 水位线（45s 暂停 / 15s 恢复）不能删：转码快于实时，无水位线会
//   撑爆 MSE 配额 → QuotaExceededError 静默丢 chunk → buffered 空洞永久卡死。
// - 流中断走自动恢复（连续 4 次失败才报错）：长片瞬时网络抖动是常态。

export type QualityId = 'origin' | '720p' | '1080p' | '2k';
export type ModeId = 'auto' | 'hw' | 'sw';

export interface SessionMeta {
  sessionId: string;
  duration: number;
  width: number;
  height: number;
  codec: string;
  audioCodec: string | null;
  pixFmt: string;
  streamMode: string;
  encoder: string | null;
  qualities: QualityId[];
  hwAvailable: boolean;
}

export interface PlayerCoreCallbacks {
  /** 过程性状态文案（seek/恢复/切换中） */
  onStatus?(msg: string): void;
  /** 终态错误（UI 展示后不可恢复） */
  onError?(msg: string): void;
  /** 加载态变化（true = 显示 loader） */
  onLoading?(loading: boolean): void;
}

// 候选 codec：服务端输出恒为 H.264（直通保留源 profile/level，故候选覆盖高级别）；
// 音频存在时恒为 AAC-LC（mp4a.40.2）
const VIDEO_CODECS = [
  'avc1.42E01E', // Baseline 3.0
  'avc1.4d401e', // Main 3.0
  'avc1.640028', // High 4.0
  'avc1.640029', // High 4.1
  'avc1.640032', // High 5.0
  'avc1.640033'  // High 5.1
];

function pickCodec(hasAudio: boolean): string {
  const suffix = hasAudio ? ',mp4a.40.2' : '';
  const fallback = 'video/mp4; codecs="' + VIDEO_CODECS[0] + suffix + '"';
  if (window.MediaSource && typeof MediaSource.isTypeSupported === 'function') {
    for (const c of VIDEO_CODECS) {
      const mime = 'video/mp4; codecs="' + c + suffix + '"';
      if (MediaSource.isTypeSupported(mime)) return mime;
    }
  }
  return fallback;
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return pad(h) + ':' + pad(m) + ':' + pad(sec);
}

export class PlayerCore {
  readonly video: HTMLVideoElement;
  readonly meta: SessionMeta;
  quality: QualityId;
  mode: ModeId;

  private cb: PlayerCoreCallbacks;
  private gen = 0;                 // 代次令牌，使在途异步操作失效
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectURL: string | null = null;
  private abortController: AbortController | null = null;
  private pendingBuffers: ArrayBuffer[] = [];
  private rebuilding = false;      // MediaSource 重建期间，抑制 seeking 处理
  private selfSeeking = false;     // 程序化设置 currentTime 标志，onSeeking 消费一次
  private autoPlay = false;        // canplay 后是否自动续播
  private networkFailStreak = 0;   // 连续网络失败次数（收到数据即清零）
  private destroyed = false;

  private constructor(meta: SessionMeta, quality: QualityId, mode: ModeId, cb: PlayerCoreCallbacks) {
    this.meta = meta;
    this.quality = quality;
    this.mode = mode;
    this.cb = cb;
    this.video = document.createElement('video');
    this.video.preload = 'auto';
    this.bindVideoEvents();
    window.addEventListener('beforeunload', this.onBeforeUnload);
  }

  /** 创建会话（POST /api/sessions）并构造播放核心 */
  static async create(
    url: string,
    opts: { quality?: QualityId; mode?: ModeId } = {},
    cb: PlayerCoreCallbacks = {}
  ): Promise<PlayerCore> {
    const resp = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality: opts.quality ?? 'origin', mode: opts.mode ?? 'auto' })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}) as { error?: string });
      throw new Error(err.error || 'HTTP ' + resp.status);
    }
    const meta = await resp.json() as SessionMeta;
    return new PlayerCore(meta, opts.quality ?? 'origin', opts.mode ?? 'auto', cb);
  }

  // ===== 对 UI 暴露的动作 =====

  /** 从给定 start 秒建立 MediaSource 并拉流（首次加载入口） */
  start(startAt = 0, autoplay = true): void {
    this.autoPlay = autoplay;
    this.startStreamAt(startAt);
  }

  /** 用户 seek：写入 currentTime，由 seeking 监听判定缓冲内/外（外 → 重建流） */
  seek(t: number): void {
    this.video.currentTime = t;
  }

  /** 切换画质档/解码模式：与 seek 同路径（杀流重建），从当前位置继续 */
  restartWith(quality: QualityId = this.quality, mode: ModeId = this.mode): void {
    const changed = quality !== this.quality || mode !== this.mode;
    this.quality = quality;
    this.mode = mode;
    if (!changed) return;
    const t = this.video.currentTime;
    const wasPlaying = !this.video.paused && !this.video.ended;
    this.teardownMediaSource();
    this.autoPlay = wasPlaying;
    this.cb.onStatus?.('正在切换…');
    this.cb.onLoading?.(true);
    this.startStreamAt(t);
  }

  /** 销毁：断流 + 删除服务端会话 */
  async destroy(): Promise<void> {
    this.destroyed = true;
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.teardownMediaSource();
    try {
      await fetch('/api/sessions/' + encodeURIComponent(this.meta.sessionId), { method: 'DELETE' });
    } catch { /* 忽略：服务端 5min 超时会兜底清理 */ }
  }

  // ===== 内部：MediaSource 生命周期 =====

  private teardownMediaSource(): void {
    this.gen++; // 使所有在途异步操作失效
    this.selfSeeking = false; // 复位自激标志，防止上次程序化 seek 未被消费而残留
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* 已中止 */ }
      this.abortController = null;
    }
    this.pendingBuffers = [];
    this.sourceBuffer = null;
    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
      } catch { /* 已关闭 */ }
      this.mediaSource = null;
    }
    if (this.objectURL) {
      URL.revokeObjectURL(this.objectURL);
      this.objectURL = null;
    }
  }

  private startStreamAt(start: number): void {
    const myGen = this.gen;
    const codec = pickCodec(!!this.meta.audioCodec);

    this.rebuilding = true;
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectURL = URL.createObjectURL(ms);
    this.video.src = this.objectURL;
    this.video.load();

    const onOpen = (): void => {
      ms.removeEventListener('sourceopen', onOpen);
      if (myGen !== this.gen) return; // 已过期
      let sb: SourceBuffer;
      try {
        sb = ms.addSourceBuffer(codec);
      } catch (e) {
        this.fail('不支持的视频编码: ' + (e as Error).message);
        return;
      }
      this.sourceBuffer = sb;
      sb.mode = 'segments';
      // 关键：seek/换档重建后新 ffmpeg 流的时间戳从 0 重新起算（-ss 重置了时间线），
      // 用 timestampOffset 偏移到原片位置，使 video.currentTime 恒反映原片真实位置。
      // 初始加载 start=0，offset=0 无副作用。
      try { sb.timestampOffset = start; } catch { /* 部分 SB 不支持 */ }
      // MediaSource 时长设为原片总时长，使进度条覆盖整片范围
      try { ms.duration = this.meta.duration; } catch { /* 忽略 */ }
      // 关键：video.load() 后 currentTime 通常被重置为 0，而 timestampOffset 让新缓冲区
      // 从 start 开始 → 播放头停在 0 会落在缓冲区外 → 永远 waiting 不播放。
      // 必须把播放头拨回 start。该程序化赋值触发 seeking：用 selfSeeking 标志
      // 识别自触发（而非用户拖拽），跳过重建防无限循环。标志在 onSeeking 顶部消费。
      if (start > 0) {
        try {
          this.selfSeeking = true;
          this.video.currentTime = start;
        } catch {
          this.selfSeeking = false;
        }
      }
      sb.addEventListener('updateend', () => this.pumpBuffer());
      sb.addEventListener('error', () => {
        if (myGen !== this.gen) return;
        this.fail('解码错误');
      });

      this.fetchStream(start, myGen);
    };
    ms.addEventListener('sourceopen', onOpen);
  }

  private fetchStream(start: number, myGen: number): void {
    this.abortController = new AbortController();
    // 显式携带当前画质档/解码模式：服务端持久化到会话，
    // 断线自动恢复的重连请求不带参数也沿用（不会静默跳回原画质）
    const url = '/api/sessions/' + encodeURIComponent(this.meta.sessionId) +
      '/stream?start=' + encodeURIComponent(start) +
      '&quality=' + this.quality + '&mode=' + this.mode;

    fetch(url, { signal: this.abortController.signal })
      .then(resp => {
        if (myGen !== this.gen) return;
        if (!resp.ok) { this.fail('流请求失败: HTTP ' + resp.status); return; }
        if (!resp.body) { this.fail('浏览器不支持流式响应'); return; }
        return this.pumpReader(resp.body.getReader(), myGen);
      })
      .catch((e: Error) => {
        if (myGen !== this.gen) return;
        if (e.name !== 'AbortError') this.handleStreamFailure(myGen);
      });
  }

  // 流中断自动恢复：长片播放中瞬时网络抖动（切后台被系统切断、休眠唤醒等）不应终局。
  // 从当前播放位置重建流（与 seek 同路径），连续失败超限才报错
  private handleStreamFailure(myGen: number): void {
    if (myGen !== this.gen) return; // 已有新流接管（如用户 seek）
    if (this.networkFailStreak >= 4) {
      this.fail('流中断且自动恢复失败，请重新加载');
      return;
    }
    this.networkFailStreak++;
    const resumeAt = this.video.currentTime;
    const wasPlaying = !this.video.paused && !this.video.ended;
    this.cb.onStatus?.('连接中断，正在从 ' + formatTime(resumeAt) + ' 恢复…');
    this.cb.onLoading?.(true);
    setTimeout(() => {
      if (myGen !== this.gen) return; // 期间发生了 seek/重建
      this.teardownMediaSource();
      this.autoPlay = wasPlaying;
      this.startStreamAt(resumeAt);
    }, 1000);
  }

  private pumpReader(reader: ReadableStreamDefaultReader<Uint8Array>, myGen: number): void {
    // 水位线：缓冲领先播放头过多时暂停读取。TCP 背压沿浏览器→Node→ffmpeg stdout
    // 传导，ffmpeg 阻塞在写出上，全链路不再堆积。没有它 4x 实时的转码速度会
    // 撑爆 Chrome MSE 配额（约 150MB），之后 QuotaExceededError 静默丢 chunk，
    // buffered 出现空洞，播放头撞洞后永久卡死。
    const READ_HIGH_WATER = 45; // 领先播放头超过该秒数 → 暂停读取
    const READ_LOW_WATER = 15;  // 领先回落到该秒数以下 → 恢复读取

    const bufferedAhead = (): number => {
      const b = this.video.buffered;
      if (!b) return 0;
      for (let i = 0; i < b.length; i++) {
        if (this.video.currentTime >= b.start(i) && this.video.currentTime <= b.end(i)) {
          return b.end(i) - this.video.currentTime;
        }
      }
      return 0;
    };

    const step = (): void => {
      if (myGen !== this.gen) return;
      if (bufferedAhead() > READ_HIGH_WATER) {
        // 停靠：等播放消耗。timeupdate 仅在播放时触发，暂停时停靠是正确行为；
        // seek/换流会 gen++，监听器自行退役
        const onCheck = (): void => {
          if (myGen !== this.gen) {
            this.video.removeEventListener('timeupdate', onCheck);
            return;
          }
          if (bufferedAhead() <= READ_LOW_WATER) {
            this.video.removeEventListener('timeupdate', onCheck);
            step();
          }
        };
        this.video.addEventListener('timeupdate', onCheck);
        return;
      }
      reader.read().then(res => {
        if (myGen !== this.gen) return;
        if (res.done) {
          // 流自然结束：结束当前 MediaSource
          const ms = this.mediaSource;
          if (ms && ms.readyState === 'open' && this.sourceBuffer && !this.sourceBuffer.updating) {
            try { ms.endOfStream(); } catch { /* 已结束 */ }
          }
          return;
        }
        // 拷贝一份再入队（reader 复用底层缓冲的风险规避）
        this.enqueueBuffer(res.value.slice().buffer);
        this.networkFailStreak = 0; // 收到数据：恢复链路健康
        step();
      }).catch((e: Error) => {
        if (myGen !== this.gen) return;
        if (e.name !== 'AbortError') this.handleStreamFailure(myGen);
      });
    };
    step();
  }

  // SourceBuffer 追加（带队列，避免 updating 时冲突）
  private enqueueBuffer(data: ArrayBuffer): void {
    if (!this.sourceBuffer) return;
    this.pendingBuffers.push(data);
    this.pumpBuffer();
  }

  private pumpBuffer(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.pendingBuffers.length === 0) return;
    const next = this.pendingBuffers.shift()!;
    try {
      sb.appendBuffer(next);
    } catch (e) {
      if ((e as Error).name === 'QuotaExceededError' && sb.buffered.length > 0) {
        // 缓冲区配额耗尽：异步移除已播放部分（currentTime 之前 20s）释放空间，
        // 把当前分片放回队头，等 remove 触发的 updateend 后自动重试
        const removeEnd = Math.max(0, this.video.currentTime - 20);
        if (sb.buffered.start(0) < removeEnd) {
          this.pendingBuffers.unshift(next);
          try { sb.remove(sb.buffered.start(0), removeEnd); }
          catch { this.pumpBuffer(); } // remove 失败：丢弃当前分片，继续排空
        } else {
          this.pumpBuffer(); // 无可移除范围：丢弃当前分片，避免死循环
        }
      } else {
        this.pumpBuffer(); // 其他错误：丢弃当前分片，继续排空
      }
    }
  }

  // ===== 内部：video 元素事件 =====

  private isBufferedAt(t: number): boolean {
    const b = this.video.buffered;
    if (!b || b.length === 0) return false;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) && t <= b.end(i)) return true;
    }
    return false;
  }

  private onSeeking = (): void => {
    if (this.rebuilding) return;           // src 变更期间忽略
    // 消费 startStreamAt 中程序化设置 currentTime 触发的自激 seek（拨回 start 以对齐
    // 新缓冲区）。置位必伴随一次 currentTime 变化，seeking 必触发，标志必被消费；
    // 此处 return 跳过重建，防无限循环。
    if (this.selfSeeking) {
      this.selfSeeking = false;
      return;
    }
    const t = this.video.currentTime;
    if (this.isBufferedAt(t)) return;      // 已缓冲，交给原生播放
    // 真正拖到未缓冲区域（无论前后向）→ 结束当前 ffmpeg、从 t 精确 seek 重新转码
    this.cb.onStatus?.('精确 seek 到 ' + formatTime(t) + ' …');
    this.cb.onLoading?.(true);
    this.teardownMediaSource();
    this.autoPlay = true;
    this.startStreamAt(t);
  };

  private bindVideoEvents(): void {
    this.video.addEventListener('seeking', this.onSeeking);

    // 防御：播放头撞进 buffered 空洞（如历史丢 chunk 造成）时跳到下一段起点。
    // 若是无数据可播（直播边缘/转码跟不上），前方没有 range，不会触发误跳
    this.video.addEventListener('waiting', () => {
      if (this.video.seeking || this.rebuilding) return;
      const t = this.video.currentTime;
      const b = this.video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) > t) {
          this.video.currentTime = b.start(i);
          return;
        }
      }
    });

    this.video.addEventListener('loadedmetadata', () => {
      this.rebuilding = false; // src 重建窗口结束
    });

    this.video.addEventListener('canplay', () => {
      this.cb.onLoading?.(false);
      this.cb.onStatus?.('');
      if (this.autoPlay) {
        this.autoPlay = false;
        const p = this.video.play();
        if (p && p.catch) p.catch(() => { /* 自动播放被阻止，忽略 */ });
      }
    });

    this.video.addEventListener('error', () => {
      if (!this.destroyed) this.fail('播放错误');
    });
  }

  private fail(msg: string): void {
    this.cb.onLoading?.(false);
    this.cb.onError?.(msg);
  }

  private onBeforeUnload = (): void => {
    this.teardownMediaSource();
    try {
      fetch('/api/sessions/' + encodeURIComponent(this.meta.sessionId), {
        method: 'DELETE',
        keepalive: true
      });
    } catch { /* 卸载期尽力而为 */ }
  };
}
```

- [ ] **Step 2: player-entry.ts 临时接线（保证编译，Task 11 替换）**

```ts
// src/client/player-entry.ts — 播放器页装配入口（Task 11 完整实现，当前验证编译）
import { PlayerCore } from './player-core';
import './player.css';

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  app.textContent = '播放器加载中…';
  const url = new URLSearchParams(location.search).get('url');
  if (!url) return;
  const core = await PlayerCore.create(url);
  app.textContent = '';
  core.video.style.cssText = 'width:100%;height:100%';
  app.appendChild(core.video);
  core.start(0);
}

void main();
```

- [ ] **Step 3: 构建 + 类型检查**

Run: `npm run build && npm run typecheck`
Expected: PASS

- [ ] **Step 4: 手工冒烟**

生成 30s 样本并起服务：

```bash
node -e "const{execFileSync}=require('child_process');execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','testsrc=duration=30:size=1280x720:rate=30','-f','lavfi','-i','sine=frequency=440:duration=30','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y','test-720.mp4'])"
npm start
```

浏览器打开 `http://127.0.0.1:<端口>/player.html?url=<encodeURIComponent(test-720.mp4 的 http URL 或本机文件服务地址)>`，确认视频可播、进度推进、控制台无报错。

- [ ] **Step 5: 提交**

```bash
git add src/client/player-core.ts src/client/player-entry.ts
git commit -m "feat: MSE 播放核心迁移 TS（画质/解码参数 + 动作接口）"
```

---

### Task 9: `player-ui.ts` + `player.css`（共享外壳 + PC 主题完整控制栏）

**Files:**
- Create: `src/client/player-ui.ts`
- Modify: `src/client/player.css`（全量重写）

**Interfaces:**
- Consumes: Task 7 `injectIcon`、Task 8 `PlayerCore`
- Produces: `mountPlayerUI(opts)`（Task 11 使用；签名见全局类型约定，`callbacks` 为 entry 持有的回调容器）

交互常量照抄参考组件 `VideoPlayer.vue`：`CONTROL_HIDE_DELAY=3000`、`MOUSE_MOVE_THROTTLE=200`、`INACTIVITY_TIMEOUT=5000`。与参考组件的有意差异：**拖拽进度条仅做 UI 预览，松手才提交 seek**（服务端 seek = 杀 ffmpeg 重建，拖动中每次 mousemove 都重建会压垮服务）。

- [ ] **Step 1: 实现 `src/client/player-ui.ts`（全量）**

```ts
// src/client/player-ui.ts — 播放器控制栏 UI（PC/TV 双主题，同 DOM 不同 CSS）。
// 交互逻辑与视觉值移植自 etsme-h5 video-preview 组件：
// - 显隐：200ms 节流 mousemove 显示；播放中 3s 隐藏；5s 无操作隐藏；暂停常显
// - 单击画面切控制栏 / 双击切播放（260ms 双击判定，等价 useClickHandler）
// - ext 面板：画质 / 倍速 / 更多设置（画面比例 + 解码设置）
// - 拖拽进度条仅 UI 预览，松手才 seek（服务端 seek 成本高，与参考组件的有意差异）
import { injectIcon, type IconName } from './icons';
import type { ModeId, PlayerCore, PlayerCoreCallbacks, QualityId } from './player-core';

const PLAYBACK_RATES = [0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
// 展示顺序高→低（服务端返回的 qualities 即此序）
const QUALITY_LABELS: Record<QualityId, string> = {
  '2k': '2K', '1080p': '1080P', '720p': '720P', origin: '原画质'
};
// 画面比例（参考组件 const.ts radioList；key 1=原始 2=16:9 3=4:3）
const RADIO_LIST = [
  { key: 1, label: '原始' },
  { key: 2, label: '16:9' },
  { key: 3, label: '4:3' }
] as const;
const DECODE_LIST: Array<{ key: ModeId; label: string }> = [
  { key: 'hw', label: '硬解' },
  { key: 'sw', label: '软解' }
];
const EXT_TITLES = { videoQuality: '画质', playbackRate: '倍速', moreConfig: '更多设置' } as const;
type ExtType = keyof typeof EXT_TITLES;

// 显隐常量（照抄参考组件）
const CONTROL_HIDE_DELAY = 3000;   // 播放中 3s 后隐藏控制栏
const MOUSE_MOVE_THROTTLE = 200;   // 鼠标移动节流
const INACTIVITY_TIMEOUT = 5000;   // 5s 无操作视为不活跃
const DBLCLICK_MS = 260;           // 双击判定窗口

export interface PlayerUIOptions {
  root: HTMLElement;
  core: PlayerCore;
  callbacks: PlayerCoreCallbacks;
  title?: string;
  ui?: 'pc' | 'tv';
}

const TEMPLATE = `
  <div class="player"><video class="video radio-origin"></video></div>
  <div class="video-player-layer"></div>
  <div class="video-player-header"><span class="video-player-title"></span></div>
  <span class="loader hidden"></span>
  <div class="video-player-controller">
    <div class="ext hidden">
      <h3 class="ext-title"></h3>
      <div class="ext-back"><span class="icon" data-icon="arrow-down"></span></div>
      <div class="quality-list"></div>
      <div class="playback-rate-list hidden"></div>
      <div class="config-content hidden">
        <h3 class="config-title">画面比例</h3>
        <div class="radio-list"></div>
        <h3 class="config-title decode-title">解码设置</h3>
        <div class="decode-list"></div>
      </div>
      <div class="driver"></div>
    </div>
    <div class="ff-player-controller-main">
      <div class="first-row">
        <span class="ff-player-time time-l">00:00:00</span>
        <div class="player-bar-wrap">
          <div class="player-bar-time">00:00:00</div>
          <div class="player-bar">
            <div class="player-buffer-time"></div>
            <div class="player-played"><span class="player-thumb"><span></span></span></div>
          </div>
        </div>
        <span class="ff-player-time time-r">00:00:00</span>
      </div>
      <div class="second-row">
        <div class="left">
          <div class="icon-play-box"><span class="icon" data-icon="play"></span></div>
          <div class="icon-pause-box hidden"><span class="icon" data-icon="pause"></span></div>
          <div class="player-volume">
            <div class="icon-muted-box hidden"><span class="icon" data-icon="volume-mute"></span></div>
            <div class="icon-unmuted-box"><span class="icon" data-icon="volume-unmute"></span></div>
            <div class="player-volume-bar-wrap">
              <div class="player-volume-bar">
                <div class="player-volume-bar-inner"><span class="player-vol-thumb"><div class="player-vol-thumb-tips">100%</div></span></div>
              </div>
            </div>
          </div>
        </div>
        <div class="center">
          <span class="ff-player-time time-c1">00:00:00</span>
          <span class="ff-player-time-split">/</span>
          <span class="ff-player-time time-c2">00:00:00</span>
        </div>
        <div class="right">
          <div class="playback-rate" title="倍速">倍速</div>
          <div class="quality" title="画质">原画质</div>
          <div class="more-config-box" title="更多"><span class="icon" data-icon="cog"></span></div>
          <div class="fullscreen-box" title="全屏"><span class="icon" data-icon="fullscreen"></span></div>
        </div>
      </div>
    </div>
  </div>
  <div class="player-error hidden"></div>
`;

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return pad(h) + ':' + pad(m) + ':' + pad(sec);
}

export function mountPlayerUI(opts: PlayerUIOptions): void {
  const { root, core, callbacks } = opts;
  const ui = opts.ui ?? 'pc';
  root.classList.remove('ui-pc', 'ui-tv');
  root.classList.add(ui === 'tv' ? 'ui-tv' : 'ui-pc');
  root.innerHTML = TEMPLATE;

  const video = core.video;
  video.className = 'video radio-origin';
  root.querySelector('.player')!.appendChild(video);

  // 图标注入
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    injectIcon(el, el.dataset.icon as IconName);
  });

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const layer = $('.video-player-layer');
  const header = $('.video-player-header');
  const controller = $('.video-player-controller');
  const loader = $('.loader');
  const errorBox = $('.player-error');
  const ext = $('.ext');
  const extTitle = $('.ext-title');
  const qualityList = $('.quality-list');
  const rateList = $('.playback-rate-list');
  const radioList = root.querySelector('.radio-list') as HTMLElement;
  const decodeList = $('.decode-list');
  const configContent = root.querySelector('.config-content') as HTMLElement;
  const barWrap = $('.player-bar-wrap');
  const barTime = $('.player-bar-time');
  const playedBar = $('.player-played');
  const bufferBar = $('.player-buffer-time');
  const thumb = $('.player-thumb');
  const timeL = $('.time-l');
  const timeR = $('.time-r');
  const timeC1 = $('.time-c1');
  const timeC2 = $('.time-c2');
  const playBox = $('.icon-play-box');
  const pauseBox = $('.icon-pause-box');
  const mutedBox = $('.icon-muted-box');
  const unmutedBox = $('.icon-unmuted-box');
  const volInner = $('.player-volume-bar-inner');
  const volTips = $('.player-vol-thumb-tips');
  const volBar = $('.player-volume-bar');
  const rateLabel = $('.playback-rate');
  const qualityLabel = $('.quality');
  const fullscreenIcon = root.querySelector('.fullscreen-box .icon') as HTMLElement;

  // ===== 状态渲染 =====

  if (opts.title) root.querySelector('.video-player-title')!.textContent = opts.title;
  else header.classList.add('hidden');

  const totalDuration = (): number => video.duration || core.meta.duration || 0;

  const renderTime = (): void => {
    const t = formatTime(video.currentTime);
    const d = formatTime(totalDuration());
    timeL.textContent = t;
    timeR.textContent = d;
    timeC1.textContent = t;
    timeC2.textContent = d;
    const dur = totalDuration();
    playedBar.style.width = dur ? Math.min(video.currentTime / dur, 1) * 100 + '%' : '0%';
  };

  const renderBuffer = (): void => {
    const dur = totalDuration();
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
        end = video.buffered.end(i);
        break;
      }
    }
    bufferBar.style.width = dur ? Math.min(end / dur, 1) * 100 + '%' : '0%';
  };

  const renderPlayState = (): void => {
    playBox.classList.toggle('hidden', !video.paused);
    pauseBox.classList.toggle('hidden', video.paused);
  };

  const renderVolume = (): void => {
    const v = video.muted ? 0 : video.volume;
    volInner.style.width = v * 100 + '%';
    volTips.textContent = Math.ceil(v * 100) + '%';
    mutedBox.classList.toggle('hidden', !video.muted);
    unmutedBox.classList.toggle('hidden', video.muted);
  };

  const renderQuality = (): void => {
    qualityLabel.textContent = QUALITY_LABELS[core.quality] ?? '原画质';
    qualityList.querySelectorAll('span').forEach(el => {
      el.classList.toggle('active', el.dataset.q === core.quality);
    });
  };

  const renderDecode = (): void => {
    const active: ModeId = core.mode === 'sw' ? 'sw' : 'hw';
    decodeList.querySelectorAll('span').forEach(el => {
      el.classList.toggle('active', el.dataset.mode === active);
    });
  };

  const renderRadio = (key: number): void => {
    // 画面比例纯前端处理（spec：后端输出画面比例不变）
    video.className = 'video ' + (key === 1 ? 'radio-origin' : key === 2 ? 'radio-16-9' : 'radio-4-3');
    radioList.querySelectorAll('span').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.key) === key);
    });
  };

  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('progress', renderBuffer);
  video.addEventListener('durationchange', renderTime);
  video.addEventListener('loadedmetadata', renderTime);
  video.addEventListener('seeked', renderTime);
  video.addEventListener('play', () => { renderPlayState(); scheduleHide(); });
  video.addEventListener('pause', () => { renderPlayState(); showControlsNow(); });
  video.addEventListener('volumechange', renderVolume);
  video.addEventListener('ended', () => showControlsNow());

  // ===== 控制栏显隐（移植 VideoPlayer.vue）=====

  let controlsVisible = true;
  let hideTimer: number | null = null;
  let inactivityTimer: number | null = null;
  let mouseMoveTimer: number | null = null;
  let lastMouseMove = Date.now();

  const isPlaying = (): boolean => !video.paused && !video.ended;

  const applyVisibility = (): void => {
    header.classList.toggle('is-hidden', !controlsVisible);
    controller.classList.toggle('is-hidden', !controlsVisible);
    if (!controlsVisible) hideExt();
  };

  function clearHideTimer(): void {
    if (hideTimer != null) { clearTimeout(hideTimer); hideTimer = null; }
  }
  function clearInactivityTimer(): void {
    if (inactivityTimer != null) { clearTimeout(inactivityTimer); inactivityTimer = null; }
  }
  function startHideTimer(): void {
    clearHideTimer();
    if (!isPlaying()) return;
    hideTimer = window.setTimeout(() => {
      if (isPlaying()) { controlsVisible = false; applyVisibility(); }
      hideTimer = null;
    }, CONTROL_HIDE_DELAY);
  }
  function resetInactivityTimer(): void {
    clearInactivityTimer();
    inactivityTimer = window.setTimeout(() => {
      if (isPlaying() && controlsVisible) { controlsVisible = false; applyVisibility(); }
    }, INACTIVITY_TIMEOUT);
  }
  function showControlsNow(): void {
    controlsVisible = true;
    applyVisibility();
    clearHideTimer();
    clearInactivityTimer();
  }
  function scheduleHide(): void {
    startHideTimer();
    resetInactivityTimer();
  }
  function onHoverControls(): void {
    showControlsNow();
  }

  const handleMouseMove = (): void => {
    const now = Date.now();
    if (mouseMoveTimer != null) return;      // 节流处理
    if (now - lastMouseMove < MOUSE_MOVE_THROTTLE) return;
    mouseMoveTimer = window.setTimeout(() => {
      mouseMoveTimer = null;
      lastMouseMove = now;
      showControlsNow();
      scheduleHide();
    }, MOUSE_MOVE_THROTTLE);
  };

  // 单击切控制栏显隐 / 双击切播放（等价参考组件 useClickHandler）
  let clickTimer: number | null = null;
  layer.addEventListener('click', () => {
    if (clickTimer != null) {
      clearTimeout(clickTimer);
      clickTimer = null;
      // 双击：切播放
      if (video.paused) void video.play().catch(() => { /* 被阻止 */ });
      else video.pause();
      return;
    }
    clickTimer = window.setTimeout(() => {
      clickTimer = null;
      // 单击：切换控制栏
      if (!controlsVisible) {
        showControlsNow();
        scheduleHide();
      } else {
        controlsVisible = false;
        applyVisibility();
        clearHideTimer();
      }
    }, DBLCLICK_MS);
  });
  layer.addEventListener('mousemove', handleMouseMove);

  // ===== ext 面板 =====

  let extType: ExtType | null = null;
  function showExt(type: ExtType): void {
    if (extType === type && !ext.classList.contains('hidden')) { hideExt(); return; }
    extType = type;
    extTitle.textContent = EXT_TITLES[type];
    qualityList.classList.toggle('hidden', type !== 'videoQuality');
    rateList.classList.toggle('hidden', type !== 'playbackRate');
    configContent.classList.toggle('hidden', type !== 'moreConfig');
    ext.classList.remove('hidden');
    showControlsNow();
    // PC 主题的 ext 在条内部展开，高度动画需要显式高度；TV 主题全宽自适应
    if (ui === 'pc') ext.style.height = ext.scrollHeight + 'px';
  }
  function hideExt(): void {
    extType = null;
    ext.classList.add('hidden');
    if (ui === 'pc') ext.style.height = '0px';
  }
  $('.ext-back').addEventListener('click', hideExt);
  rateLabel.addEventListener('click', () => showExt('playbackRate'));
  qualityLabel.addEventListener('click', () => showExt('videoQuality'));
  $('.more-config-box').addEventListener('click', () => showExt('moreConfig'));
  controller.addEventListener('mouseenter', onHoverControls);

  // ===== 列表构建 =====

  // 画质（服务端已按源分辨率过滤，降序；origin 恒在末位）
  for (const q of core.meta.qualities) {
    const span = document.createElement('span');
    span.textContent = QUALITY_LABELS[q] ?? q;
    span.dataset.q = q;
    span.addEventListener('click', () => {
      if (q === core.quality) { hideExt(); return; }
      core.restartWith(q, core.mode);
      renderQuality();
      hideExt();
    });
    qualityList.appendChild(span);
  }
  // 倍速
  for (const r of PLAYBACK_RATES) {
    const span = document.createElement('span');
    span.textContent = r + 'x';
    span.dataset.rate = String(r);
    span.classList.toggle('active', r === 1.0);
    span.addEventListener('click', () => {
      video.playbackRate = r;
      rateLabel.textContent = r === 1.0 ? '倍速' : r + 'x';
      rateList.querySelectorAll('span').forEach(el =>
        el.classList.toggle('active', Number(el.dataset.rate) === r));
      hideExt();
    });
    rateList.appendChild(span);
  }
  // 画面比例
  for (const item of RADIO_LIST) {
    const span = document.createElement('span');
    span.textContent = item.label;
    span.dataset.key = String(item.key);
    span.classList.toggle('active', item.key === 1);
    span.addEventListener('click', () => { renderRadio(item.key); hideExt(); });
    radioList.appendChild(span);
  }
  // 解码设置：硬解不可用（部署机无硬编）时不显示硬解选项
  for (const item of DECODE_LIST) {
    if (item.key === 'hw' && !core.meta.hwAvailable) continue;
    const span = document.createElement('span');
    span.textContent = item.label;
    span.dataset.mode = item.key;
    span.addEventListener('click', () => {
      if (item.key === core.mode) { hideExt(); return; }
      core.restartWith(core.quality, item.key);
      renderDecode();
      hideExt();
    });
    decodeList.appendChild(span);
  }

  // ===== 进度条（拖拽预览，松手提交 seek）=====

  let dragging = false;
  const barPercentage = (e: MouseEvent): number => {
    const rect = barWrap.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  };
  barWrap.addEventListener('mousedown', (e) => {
    dragging = true;
    thumb.classList.add('player-thumb-active');
    const p = barPercentage(e);
    playedBar.style.width = p * 100 + '%';
    barTime.textContent = formatTime(p * totalDuration());
    document.addEventListener('mousemove', onBarMove);
    document.addEventListener('mouseup', onBarUp);
    e.preventDefault();
  });
  function onBarMove(e: MouseEvent): void {
    if (!dragging) return;
    const p = barPercentage(e);
    playedBar.style.width = p * 100 + '%';
    barTime.textContent = formatTime(p * totalDuration());
  }
  function onBarUp(e: MouseEvent): void {
    document.removeEventListener('mousemove', onBarMove);
    document.removeEventListener('mouseup', onBarUp);
    dragging = false;
    thumb.classList.remove('player-thumb-active');
    core.seek(barPercentage(e) * totalDuration());
  }
  barWrap.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const dur = totalDuration();
    if (!dur) return;
    const rect = barWrap.getBoundingClientRect();
    const p = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    barTime.style.left = (e.clientX - rect.left) + 'px';
    barTime.textContent = formatTime(p * dur);
  });
  barWrap.addEventListener('mouseenter', () => barTime.classList.add('player-bar-time-active'));
  barWrap.addEventListener('mouseleave', () => barTime.classList.remove('player-bar-time-active'));

  // ===== 音量 =====

  const setVolume = (v: number): void => {
    video.volume = Math.min(Math.max(v, 0), 1);
    video.muted = video.volume === 0;
  };
  const volPercentage = (e: MouseEvent): number => {
    const rect = volBar.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  };
  volBar.parentElement!.addEventListener('mousedown', (e) => {
    setVolume(volPercentage(e));
    document.addEventListener('mousemove', onVolMove);
    document.addEventListener('mouseup', onVolUp);
    e.preventDefault();
  });
  function onVolMove(e: MouseEvent): void {
    setVolume(volPercentage(e));
  }
  function onVolUp(): void {
    document.removeEventListener('mousemove', onVolMove);
    document.removeEventListener('mouseup', onVolUp);
  }
  playBox.addEventListener('click', () => void video.play().catch(() => { /* 被阻止 */ }));
  pauseBox.addEventListener('click', () => video.pause());
  mutedBox.addEventListener('click', () => { video.muted = false; });
  unmutedBox.addEventListener('click', () => { video.muted = true; });

  // ===== 全屏（PC 主题；TV 无此按钮，CSS 隐藏）=====

  $('.fullscreen-box').addEventListener('click', () => {
    const fs = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen();
    fs.catch(() => { /* 拒绝/不支持 */ });
  });
  document.addEventListener('fullscreenchange', () => {
    injectIcon(fullscreenIcon, document.fullscreenElement ? 'fullscreen-exit' : 'fullscreen');
  });

  // ===== 键盘（等价参考组件 Mousetrap 绑定）=====

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') core.seek(Math.max(0, video.currentTime - 5));
    else if (e.key === 'ArrowRight') core.seek(video.currentTime + 5);
    else if (e.key === 'ArrowUp') { setVolume(video.volume + 0.05); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { setVolume(video.volume - 0.05); e.preventDefault(); }
  });

  // ===== 核心回调 → loader / 错误（覆盖 entry 传入的回调容器）=====

  callbacks.onLoading = (loading) => {
    loader.classList.toggle('hidden', !loading);
  };
  callbacks.onStatus = (msg) => {
    if (msg === '') callbacks.onLoading?.(false);
  };
  callbacks.onError = (msg) => {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    loader.classList.add('hidden');
  };

  // ===== 初始渲染 =====

  renderPlayState();
  renderVolume();
  renderTime();
  renderQuality();
  renderDecode();
  showControlsNow();
  // 初始显示控制栏，5s 后隐藏（如果视频在播放）——对齐参考组件 onMounted 逻辑
  setTimeout(() => {
    if (isPlaying()) scheduleHide();
  }, INACTIVITY_TIMEOUT);
}
```

- [ ] **Step 2: 全量重写 `src/client/player.css`**

```css
/* src/client/player.css — 播放器样式。
   移植自 etsme-h5 video-preview：VideoPlayer.vue（外壳/显隐）、WebPlayer.vue（画面比例
   容器查询）、PCController.vue（.ui-pc）、TVController.vue（.ui-tv）。 */

html, body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
}

.hidden { display: none !important; }

/* ===== 外壳（VideoPlayer.vue）===== */
.video-player {
  width: 100%;
  height: 100%;
  position: relative;
  color: #fff;
  font-size: 14px;
  user-select: none;
}

.video-player-layer {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
}

/* 视频区（WebPlayer.vue：容器查询实现画面比例 contain 效果） */
.player {
  width: 100%; height: 100%;
  overflow: hidden;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  container-type: size;
  container-name: video-player;
}
.video {
  isolation: isolate;
  width: 100%; height: 100%;
  object-fit: contain;
  object-position: center;
}
.video.radio-16-9 {
  aspect-ratio: 16 / 9;
  max-width: 100%; max-height: 100%;
  object-fit: fill;
}
.video.radio-4-3 {
  aspect-ratio: 4 / 3;
  max-width: 100%; max-height: 100%;
  object-fit: fill;
}
/* 容器查询：基于父容器尺寸实现 contain 效果（宽窄边决定缩放基准） */
@container video-player (max-aspect-ratio: 16/9) {
  .video.radio-16-9 { width: 100%; height: auto; }
}
@container video-player (min-aspect-ratio: 16/9) {
  .video.radio-16-9 { width: auto; height: 100%; }
}
@container video-player (max-aspect-ratio: 4/3) {
  .video.radio-4-3 { width: 100%; height: auto; }
}
@container video-player (min-aspect-ratio: 4/3) {
  .video.radio-4-3 { width: auto; height: 100%; }
}

/* 顶部标题栏（毛玻璃渐变） */
.video-player-header {
  overflow: hidden;
  position: absolute;
  left: 0; right: 0; top: 0;
  z-index: 3;
  backdrop-filter: blur(90px);
  transition: all 0.3s ease;
  background: linear-gradient(90deg, rgba(123, 123, 155, 0.5) 0%, rgba(42, 42, 53, 0.5) 100%);
  height: var(--header-height);
  display: flex;
  align-items: center;
  padding: 0 16px;
  box-sizing: border-box;
}
.video-player-title {
  font-size: 15px;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* loader（VideoPlayer.vue：蓝色圆环） */
.loader {
  position: absolute;
  left: 50%; top: 50%;
  z-index: 5;
  width: 48px; height: 48px;
  border: 5px solid #59b9ff;
  border-bottom-color: transparent;
  border-radius: 50%;
  box-sizing: border-box;
  animation: player-rotation 1s linear infinite;
  pointer-events: none;
}
@keyframes player-rotation {
  0% { transform: translate(-50%, -50%) rotate(0deg); }
  100% { transform: translate(-50%, -50%) rotate(360deg); }
}

/* 错误覆盖层 */
.player-error {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: #59b9ff;
  text-align: center;
  background: rgba(0, 0, 0, 0.7);
}

/* ===== 控制栏共享骨架（TV 基准，PC 覆盖）===== */
.video-player-controller {
  --player-bar-height: 10px;
  position: absolute;
  left: 0; right: 0; bottom: 0;
  z-index: 4;
  transition: all 0.3s ease;
  background: rgba(51, 51, 51, 0.9);
  height: var(--footer-height);
}

.video-player-controller.is-hidden,
.video-player-header.is-hidden {
  opacity: 0;
  pointer-events: none;
}

.ff-player-controller-main > div {
  display: flex;
  flex-direction: row;
  align-items: center;
}

/* 进度条 */
.player-bar-wrap {
  position: relative;
  cursor: pointer;
  width: 100%;
  height: var(--player-bar-height);
}
.player-bar-wrap:hover .player-bar .player-played .player-thumb { transform: scale(1); }
.player-bar-time {
  position: absolute;
  top: -40px;
  border-radius: 4px;
  padding: 5px 7px;
  background-color: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 12px;
  text-align: center;
  opacity: 0;
  transition: opacity 0.1s ease-in-out;
  z-index: 2;
  pointer-events: none;
}
.player-bar-time.player-bar-time-active { opacity: 1; }
.player-bar {
  position: relative;
  height: var(--player-bar-height);
  width: 100%;
  background: rgba(255, 255, 255, 0.26);
  cursor: pointer;
  border-radius: 2px;
}
.player-buffer-time {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  height: var(--player-bar-height);
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
}
.player-played {
  background: #59b9ff;
  position: absolute;
  left: 0; top: 0; bottom: 0;
  height: var(--player-bar-height);
  border-radius: 2px;
  will-change: width;
}
.player-thumb {
  position: absolute;
  top: -4px; right: -8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.3s ease-in-out;
  transform: scale(0);
  background: rgba(89, 185, 255, 0.24);
}
.player-thumb > span {
  height: calc(var(--player-bar-height) + 8px);
  width: calc(var(--player-bar-height) + 8px);
  background: #59b9ff;
  border-radius: 50%;
}
.player-thumb.player-thumb-active { transform: scale(1); }

/* 图标按钮（TV 基准尺寸） */
.icon-play-box, .icon-pause-box, .icon-muted-box, .icon-unmuted-box,
.more-config-box, .fullscreen-box {
  font-size: 30px;
  padding: 20px 14px;
  color: #fff;
  cursor: pointer;
  line-height: 1;
}
.icon { display: inline-flex; }

.ff-player-time { font-weight: 400; color: #fff; }
.ff-player-time-split { color: #fff; }

/* 倍速/画质文字按钮（TV 基准） */
.playback-rate, .quality {
  height: 100%;
  padding: 0 14px;
  line-height: 1;
  font-size: 20px;
  color: #fff;
  cursor: pointer;
}

/* 音量条（TV 基准） */
.player-volume { display: flex; align-items: center; cursor: pointer; height: 100%; }
.player-volume-bar-wrap { display: flex; align-items: center; height: 60px; width: 200px; }
.player-volume-bar {
  display: flex; align-items: center;
  width: 100%;
  height: var(--player-bar-height);
  background: rgba(255, 255, 255, 0.26);
  border-radius: 2px;
  transition: all 0.3s ease-in-out;
}
.player-volume-bar-inner {
  position: relative;
  background: #fff;
  height: 100%;
  transition: all 0.1s ease;
  will-change: width;
  border-radius: 2px;
}
.player-vol-thumb {
  position: absolute;
  top: -4px;
  right: calc((var(--player-bar-height) + 8px) / 2 * -1);
  height: calc(var(--player-bar-height) + 8px);
  width: calc(var(--player-bar-height) + 8px);
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.3s ease-in-out;
  background: #fff;
}
.player-vol-thumb-tips {
  position: relative;
  top: -40px; left: -15px;
  border-radius: 4px;
  padding: 5px 7px;
  width: 40px;
  background-color: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 12px;
  text-align: center;
  opacity: 0;
  transition: opacity 0.1s ease-in-out;
  z-index: 2;
  pointer-events: none;
}

/* ext 面板列表（TV 基准；共享） */
.ext { overflow: hidden; }
.ext-title {
  margin: 0;
  font-weight: 400;
  padding-top: 14px;
  font-size: 30px;
  color: #fff;
  text-align: center;
}
.ext-title::after {
  display: block;
  content: '';
  width: 100%;
  height: 1px;
  margin-top: 14px;
  background: #606060;
  transform: scaleY(0.5);
}
.ext-back {
  position: absolute;
  top: 0; right: 0;
  font-size: 30px;
  padding: 14px 30px;
  cursor: pointer;
  color: #fff;
}
.driver {
  position: absolute;
  bottom: 0; left: 0;
  width: 100%; height: 1px;
  background: #606060;
  transform: scaleY(0.5);
}
.quality-list, .playback-rate-list, .radio-list, .decode-list { padding: 20px; }
.quality-list span {
  margin: 12px auto;
  padding-left: 12px;
  display: block;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  font-size: 14px;
  color: #fff;
  cursor: pointer;
}
.quality-list span.active { background: rgba(71, 155, 255, 0.33); }
.playback-rate-list span, .radio-list span, .decode-list span {
  margin: 0 14px 14px 0;
  display: inline-block;
  padding: 24px 44px;
  font-size: 24px;
  text-align: center;
  color: #fff;
  border-radius: 4px;
  cursor: pointer;
}
.playback-rate-list span:hover, .radio-list span:hover, .decode-list span:hover {
  background: rgba(255, 255, 255, 0.1);
}
.playback-rate-list span.active, .radio-list span.active, .decode-list span.active {
  background: rgba(71, 155, 255, 0.33);
}
.config-title {
  padding-left: 13px;
  font-weight: 400;
  font-size: 30px;
  color: #fff;
}
.config-content { padding: 20px 0; }

/* ===== TV 主题（TVController.vue）：通栏大字号 ===== */
.ui-tv {
  --header-height: 88px;
  --footer-height: 170px;
}
.ui-tv .ext {
  position: absolute;
  bottom: var(--footer-height);
  left: 0; right: 0;
  background-color: rgba(51, 51, 51, 0.9);
}
.ui-tv .first-row { justify-content: space-between; }
.ui-tv .time-l, .ui-tv .time-r { display: none; }
.ui-tv .second-row { justify-content: space-between; }
.ui-tv .center {
  width: 30%;
  display: flex;
  gap: 14px;
  align-items: center;
  justify-content: center;
}
.ui-tv .ff-player-time { font-size: 34px; }
.ui-tv .ff-player-time-split { font-size: 28px; }
.ui-tv .fullscreen-box { display: none; } /* TVController 无全屏按钮 */

/* ===== PC 主题（PCController.vue）：520px 悬浮条 ===== */
.ui-pc {
  --header-height: 48px;
  --footer-height: auto;
}
.ui-pc .video-player-controller {
  --player-bar-height: 4px;
  left: 50%;
  right: auto;
  transform: translateX(-50%);
  bottom: 53px;
  width: 520px;
  height: auto;
  border-radius: 6px;
}
.ui-pc .ff-player-controller-main > div { padding: 0 16px; }
.ui-pc .first-row {
  margin-top: 13px;
  justify-content: space-between;
  width: 100%;
}
.ui-pc .ff-player-time { width: 58px; font-size: 14px; }
.ui-pc .second-row { margin: 13px 0; justify-content: space-between; }
.ui-pc .center { display: none; }
.ui-pc .icon-play-box, .ui-pc .icon-pause-box, .ui-pc .icon-muted-box,
.ui-pc .icon-unmuted-box, .ui-pc .more-config-box, .ui-pc .fullscreen-box {
  font-size: 20px;
  padding: 0;
}
.ui-pc .icon-play-box, .ui-pc .icon-pause-box { margin-right: 12px; }
.ui-pc .playback-rate, .ui-pc .quality { height: auto; font-size: 14px; padding: 0; }
.ui-pc .playback-rate { margin-right: 16px; }
.ui-pc .quality { margin-right: 24px; }
.ui-pc .more-config-box { margin-right: 16px; font-size: 18px; }
.ui-pc .fullscreen-box { font-size: 20px; }
/* 音量（PC：细条小 thumb） */
.ui-pc .player-volume-bar-wrap { margin-left: 10px; height: 100%; width: 95px; }
.ui-pc .player-vol-thumb { top: -2px; right: -4px; height: 8px; width: 8px; }
/* ext 面板：条内部展开 */
.ui-pc .ext {
  position: relative;
  background: transparent;
  height: 0;
  transition: height 0.3s ease-in-out;
}
.ui-pc .ext-title {
  height: 32px;
  line-height: 32px;
  padding-top: 0;
  font-size: 14px;
}
.ui-pc .ext-title::after { margin-top: 0; }
.ui-pc .ext-back { top: 4px; right: 8px; font-size: 18px; padding: 4px 10px; }
.ui-pc .quality-list span {
  width: 472px;
  height: 36px;
  line-height: 36px;
  margin: 12px auto;
}
.ui-pc .playback-rate-list span, .ui-pc .radio-list span, .ui-pc .decode-list span {
  margin: 0 14px 16px 0;
  width: 85px;
  height: 28px;
  line-height: 28px;
  padding: 0;
  font-size: 14px;
  text-align: center;
}
.ui-pc .config-title { font-size: 14px; margin: 16px 0 -8px 0; }
.ui-pc .config-title.decode-title { margin-top: 24px; }
.ui-pc .config-content { padding: 0 0 12px 0; }
.ui-pc .driver { display: none; }
.ui-pc .player-thumb { top: -6px; right: -8px; height: 16px; width: 16px; }
.ui-pc .player-thumb > span { width: 10px; height: 10px; }
```

- [ ] **Step 3: 构建 + 类型检查 + 手工验证（PC 主题）**

Run: `npm run build && npm run typecheck`
手工（`npm start`，Task 8 的样本仍在）：打开 `/player.html?url=…&title=测试&autoplay=1`，逐项核对：
- 控制栏 520px 悬浮、进度条两侧时间、倍速/画质/更多/全屏可用
- mousemove 显示、播放 3s 隐藏、暂停常显、单击切换、双击播放暂停
- 拖进度条松手才跳转；音量拖动；键盘 ←→↑↓
- 画质切 720P（需 1080p 源）后播放位置保持；解码切软解不炸流

- [ ] **Step 4: 提交**

```bash
git add src/client/player-ui.ts src/client/player.css
git commit -m "feat: 播放器控制栏 UI（PC 主题 + 共享外壳，移植 etsme-h5 交互）"
```

---

### Task 10: TV 主题核对收尾

**Files:**
- Modify: `src/client/player.css`（TV 主体已在 Task 9 落地；本任务核对补差）

**Interfaces:**
- Consumes: Task 9 的 DOM/类名

- [ ] **Step 1: 手工核对 TV 主题清单**

`npm start` → `/player.html?url=…&ui=tv`，对照 TVController.vue 核对：
- 通栏底部控制栏、图标 30px、时间居中（time-l/time-r 隐藏）、无全屏按钮
- ext 面板全宽上滑、列表大号 padding
- 解码/画质/倍速切换与 PC 同路径
- `.ui-tv .center` 展示且宽度 30%

偏差项直接修正 player.css 后重验。

- [ ] **Step 2: 构建 + 提交**

Run: `npm run build && npm run typecheck`

```bash
git add src/client/player.css
git commit -m "feat: TV 主题控制栏核对收尾（通栏大字号，居中时间，无全屏）"
```

---

### Task 11: `player-entry.ts` 装配（URL 参数 + 静音自动播放）

**Files:**
- Modify: `src/client/player-entry.ts`（全量替换 Task 8 的临时接线）

**Interfaces:**
- Consumes: Task 8 `PlayerCore`、Task 9 `mountPlayerUI`
- Produces: 最终播放器页行为

- [ ] **Step 1: 全量替换 `src/client/player-entry.ts`**

```ts
// src/client/player-entry.ts — 播放器页装配：解析 URL 参数 → 创建会话 → 挂载 UI。
// URL 参数（详见 README）：
//   url      必需，视频地址（encodeURIComponent 后传入）
//   title    顶栏标题
//   ui       pc | tv（默认 pc）
//   quality  初始画质档 origin|720p|1080p|2k（默认 origin）
//   mode     解码模式 auto|hw|sw（默认 auto）
//   autoplay 1（默认）| 0；浏览器策略限制下先静音自动播放，用户点音量解除
import { PlayerCore, type ModeId, type PlayerCoreCallbacks, type QualityId } from './player-core';
import { mountPlayerUI } from './player-ui';
import './player.css';

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  if (!url) {
    app.textContent = '缺少 url 参数，请使用 /player.html?url=<encoded> 访问';
    return;
  }
  const ui = params.get('ui') === 'tv' ? 'tv' : 'pc';
  const title = params.get('title') ?? '';
  const autoplay = params.get('autoplay') !== '0';
  const quality = parseParam<QualityId>(params.get('quality'), ['origin', '720p', '1080p', '2k']) ?? 'origin';
  const mode = parseParam<ModeId>(params.get('mode'), ['auto', 'hw', 'sw']) ?? 'auto';

  app.textContent = '正在加载…';
  const spinner = document.createElement('span');
  spinner.className = 'loader';
  app.appendChild(spinner);

  // 回调容器：create 先挂空壳，mountPlayerUI 后由 UI 层接管渲染
  const callbacks: PlayerCoreCallbacks = {};
  let core: PlayerCore;
  try {
    core = await PlayerCore.create(url, { quality, mode }, callbacks);
  } catch (e) {
    spinner.classList.add('hidden');
    app.textContent = '加载失败: ' + (e as Error).message;
    return;
  }
  spinner.classList.add('hidden');

  // 自动播放策略：默认先静音自动播放（规避浏览器无手势限制），
  // 用户点音量图标（UI 内 unmute → video.muted=false）即恢复声音
  if (autoplay) core.video.muted = true;

  mountPlayerUI({ root: app, core, callbacks, title, ui });
  core.start(0, autoplay);
}

function parseParam<T extends string>(v: string | null, allowed: readonly T[]): T | null {
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

void main();
```

说明：`mountPlayerUI` 内 `callbacks.onLoading/onStatus/onError` 赋值覆盖空壳后即接管 loader/错误渲染；entry 不再需要额外 `.catch` 兜底（UI 的 onError 已覆盖 create 之后的失败；create 本身的失败在 try/catch 中展示）。

- [ ] **Step 2: 构建 + 类型检查**

Run: `npm run build && npm run typecheck`
Expected: PASS

- [ ] **Step 3: 端到端手工验证（参数矩阵）**

`npm start` 后核对：
- `?url=…` 默认（pc/origin/auto/autoplay=1）：静音自动播放，点音量恢复声音
- `&ui=tv`：TV 主题
- `&title=文件名`：顶栏显示
- `&quality=720p`（1080p 源）：直接以 720p 档起播
- `&mode=sw`：软编起播；`&autoplay=0`：不自动播
- 缺 `url` 参数：提示文案

- [ ] **Step 4: 提交**

```bash
git add src/client/player-entry.ts
git commit -m "feat: 播放器页装配（URL 参数解析 + 静音自动播放策略）"
```

---

### Task 12: demo 页改造（iframe 嵌入 + 嵌入代码）

**Files:**
- Modify: `public/index.html`（全量重写）
- Modify: `public/style.css`（保留基础风格，增 iframe/代码块样式）
- Delete: `public/player.js`（逻辑已迁 `src/client/player-core.ts`）

**Interfaces:**
- Consumes: Task 11 的 `/player.html` 路由
- Produces: demo 页 = URL 输入 + iframe 预览 + 可复制的嵌入代码

- [ ] **Step 1: 全量重写 `public/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FFmpeg Player - Demo</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <h1>FFmpeg Player</h1>
    <p class="hint">输入视频文件 URL，播放器以 iframe 嵌入方式加载（player.html?url=…）</p>

    <div class="url-bar">
      <input
        type="text"
        id="urlInput"
        placeholder="输入视频文件 URL（如 .mp4, .mkv 等）"
        autocomplete="off"
      />
      <button id="loadBtn">加载</button>
    </div>

    <div id="error" class="error hidden"></div>

    <div id="embedArea" class="embed-area hidden">
      <iframe
        id="playerFrame"
        title="视频播放器"
        allow="autoplay; fullscreen"
        allowfullscreen
      ></iframe>
    </div>

    <div id="embedCode" class="embed-code hidden">
      <h2>嵌入代码</h2>
      <pre><code id="embedCodeText"></code></pre>
      <button id="copyBtn">复制</button>
    </div>
  </div>

  <script src="demo.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 `public/demo.js`**

```js
// public/demo.js — demo 页逻辑：URL 输入 → iframe 加载 /player.html + 生成嵌入代码
(function () {
  'use strict';

  var urlInput = document.getElementById('urlInput');
  var loadBtn = document.getElementById('loadBtn');
  var errorBox = document.getElementById('error');
  var embedArea = document.getElementById('embedArea');
  var playerFrame = document.getElementById('playerFrame');
  var embedCode = document.getElementById('embedCode');
  var embedCodeText = document.getElementById('embedCodeText');
  var copyBtn = document.getElementById('copyBtn');

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }
  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
  }

  function buildEmbedUrl(videoUrl, title) {
    // ui/quality/mode 等参数由嵌入方按需追加，demo 用默认值
    return location.origin + '/player.html' +
      '?url=' + encodeURIComponent(videoUrl) +
      '&title=' + encodeURIComponent(title) +
      '&autoplay=1';
  }

  function load() {
    clearError();
    var v = urlInput.value.trim();
    if (!v) { showError('请输入视频 URL'); return; }
    // 标题取路径最后一段（去扩展名），仅展示用
    var title = decodeURIComponent(v.split('/').pop() || '').replace(/\.[^.]+$/, '');
    var embed = buildEmbedUrl(v, title);
    playerFrame.src = embed;
    embedArea.classList.remove('hidden');
    embedCode.classList.remove('hidden');
    embedCodeText.textContent =
      '<iframe src="' + embed + '" allow="autoplay; fullscreen" allowfullscreen></iframe>';
  }

  loadBtn.addEventListener('click', load);
  urlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') load();
  });

  copyBtn.addEventListener('click', function () {
    var text = embedCodeText.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      copyBtn.textContent = '已复制';
      setTimeout(function () { copyBtn.textContent = '复制'; }, 1500);
    }
  });
})();
```

- [ ] **Step 3: 更新 `public/style.css`**

在原文件基础上：删除 `.player-wrapper/.loading/.spinner/.error 定位覆盖层/.info` 段落，追加：

```css
/* demo 页：iframe 嵌入区与嵌入代码 */
.hint {
  text-align: center;
  color: #888;
  font-size: 13px;
  margin-bottom: 20px;
}

.error {
  padding: 8px 16px;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  background: #3a1626;
  color: #e94560;
}
.error.hidden { display: none; }

.embed-area {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 20px;
}
.embed-area.hidden { display: none; }
.embed-area iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

.embed-code {
  margin-top: 8px;
}
.embed-code h2 {
  font-size: 16px;
  color: #aaa;
  margin-bottom: 10px;
}
.embed-code pre {
  background: #16213e;
  border-radius: 8px;
  padding: 14px;
  overflow-x: auto;
  font-size: 12px;
  color: #8ab4ff;
}
.embed-code button {
  margin-top: 10px;
  padding: 8px 18px;
  border: none;
  border-radius: 6px;
  background: #0f3460;
  color: #eee;
  cursor: pointer;
}
```

并删除 `public/player.js`（`git rm`）。原 demo 的 MSE 逻辑已全部迁入 `src/client/player-core.ts`。

- [ ] **Step 4: 手工验证 demo 页**

Run: `npm run build && npm start`
浏览器打开 `/`：输入样本 URL → iframe 播放 → 嵌入代码展示与复制。同时确认 `/player.js` 已 404。

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/style.css public/demo.js
git rm public/player.js
git commit -m "feat: demo 页改为 iframe 嵌入播放器并展示嵌入代码"
```

---

### Task 13: e2e（画质档/模式）+ QSV 缩放实测

**Files:**
- Modify: `test/helpers/samples.ts`（gen 支持自定义尺寸 + 新增 1080p 样本）
- Modify: `test/e2e.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 5 路由、Task 4 会话参数
- Produces: 真实 ffmpeg 验证画质档缩放输出与模式强制

- [ ] **Step 1: QSV 缩放实测（先行，决定 scaleHwFilter 是否可用）**

ffmpeg-static 是库不是 CLI，二进制路径经 `node -p` 取出（ffmpeg-static 导出路径字符串）：

```bash
node -e "const{execFileSync}=require('child_process');execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','testsrc=duration=5:size=1920x1080:rate=30','-c:v','libx264','-pix_fmt','yuv420p','-y','test-1080.mp4'])"
FF=$(node -p "require('ffmpeg-static')")
# 测试 1：显式 qsv 解码 + scale_qsv + qsv 编码
"$FF" -v error -c:v h264_qsv -i test-1080.mp4 -vf scale_qsv=1280:720 -c:v h264_qsv -preset veryfast -b:v 2500k -maxrate 3750k -bufsize 7500k -frames:v 60 -f null -
# 测试 2（对照）：普通 scale 是否可用
"$FF" -v error -c:v h264_qsv -i test-1080.mp4 -vf scale=1280:720 -c:v h264_qsv -preset veryfast -b:v 2500k -frames:v 60 -f null -
```

（本机编码器先经 `npm start` 后 `GET /api/status` 的 `hw.encoder` 确认；AGENTS.md 记载本机为 QSV。若本机为其他厂商，将 `-c:v h264_qsv` 换成对应解码器 `h264_<厂商>` 并按 `hw-accel.ts` 的 profile 调整；无硬编则本步骤直接跳过——scale 滤镜走软路径，无风险。）

判定：
- 测试 1 成功 → `scaleHwFilter: 'scale_qsv'` 保持（Task 2 已如此）
- 测试 1 失败且测试 2 成功 → 把 qsv 的 `scaleHwFilter` 改为 `'scale'`
- 两者都失败 → qsv profile 的 `scaleHwFilter` 改为完整降级链 `hwdownload,format=nv12,scale=...,hwupload=extra_hw_frames=64`（此时 vf 模板改为在 strategy 里拼完整字符串，尺寸显式代入）

- [ ] **Step 2: 样本生成器支持自定义尺寸并新增 1080p 样本**

`test/helpers/samples.ts` 修改 `gen` 签名与 `Samples` 接口：

```ts
export interface Samples {
  dir: string;
  h264Aac: string;
  h264NoAudio: string;
  h264Hi10: string;
  hevcHi10: string;
  hevc8: string;
  h264Aac1080: string;   // 1080p H.264+AAC：画质档 e2e 用（可提供 720p 档位）
}

const gen = (file: string, videoArgs: string[], audioArgs: string[] | null, size = '320x240'): string => {
  const out = path.join(dir, file);
  const args = [
    '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=1:size=${size}:rate=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'
  ];
  if (audioArgs === null) {
    args.push('-an');
  }
  args.push(...videoArgs, '-shortest', '-y', out);
  execFileSync(ff, args, { stdio: 'pipe' });
  return out;
};
```

cache 对象追加：

```ts
    // 1080p H.264+AAC → 画质档 e2e（720p 严格低于源，可缩放）
    h264Aac1080: gen('h264_aac_1080.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], [], '1920x1080'),
```

- [ ] **Step 3: 追加 e2e 用例（test/e2e.test.ts）**

```ts
test('画质档 720p：1080p 源 → 缩放转码，产物 1280x720', async () => {
  const s = ensureSamples();
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: s.h264Aac1080, quality: '720p' })
  });
  if (r.status !== 200) throw new Error(`create failed: HTTP ${r.status} ${await r.text()}`);
  const info = await r.json();
  expect(info.qualities).toEqual(['720p', 'origin']);
  expect(info.streamMode).not.toBe('copy');   // 阶梯画质必然转码

  const data = await fetchStream(info.sessionId, 0);
  expect(data.length).toBeGreaterThan(1000);
  const tmp = path.join(os.tmpdir(), 'e2e-q720.mp4');
  fs.writeFileSync(tmp, data);
  const j = await ffprobeJson(tmp);
  const v = j.streams.find((x: any) => x.codec_type === 'video');
  expect(v.codec_name).toBe('h264');
  expect(v.width).toBe(1280);
  expect(v.height).toBe(720);
});

test('画质档不可用（320x240 源选 720p）→ 400', async () => {
  const s = ensureSamples();
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: s.h264Aac, quality: '720p' })
  });
  expect(r.status).toBe(400);
});

test('mode=sw 强制软件转码（10bit 源）', async () => {
  const s = ensureSamples();
  const info = await createSessionBody({ url: s.h264Hi10, mode: 'sw' });
  expect(info.streamMode).toBe('sw');
  expect(info.encoder).toBe('libx264');
  const data = await fetchStream(info.sessionId, 0);
  const tmp = path.join(os.tmpdir(), 'e2e-sw.mp4');
  fs.writeFileSync(tmp, data);
  const j = await ffprobeJson(tmp);
  const v = j.streams.find((x: any) => x.codec_type === 'video');
  expect(v.codec_name).toBe('h264');
  expect(v.pix_fmt).toBe('yuv420p');
});
```

配套：`createSessionBody` 辅助（`createSession` 泛化）：

```ts
async function createSessionBody(body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status !== 200) {
    throw new Error(`create session failed: HTTP ${r.status} ${await r.text()}`);
  }
  return r.json();
}
```

- [ ] **Step 4: 全量测试**

Run: `npm test`
Expected: PASS（含全部旧用例回归；hw 相关失败先看 Task 13 Step 1 的判定与 AGENTS.md 的环境说明）

- [ ] **Step 5: 提交**

```bash
git add test/helpers/samples.ts test/e2e.test.ts
git commit -m "test: 画质档与解码模式 e2e（真实 ffmpeg 缩放/码率/软编）"
```

---

### Task 14: README 与 AGENTS.md 更新

**Files:**
- Modify: `README.md`（iframe 嵌入文档 + 参数表 + 手工验证清单）
- Modify: `AGENTS.md`（构建配置 4 个 vite config、前端源码位置）

- [ ] **Step 1: README 追加「iframe 嵌入」章节**

内容要点（追加到 README 的 API/用法章节之后）：

```markdown
## iframe 嵌入

播放器可作为 iframe 嵌入任意页面（需与本服务同源访问，或直接指向服务地址）：

​```html
<iframe
  src="http://<host>:<port>/player.html?url=<encodeURIComponent(视频地址)>&title=<标题>&autoplay=1"
  allow="autoplay; fullscreen"
  allowfullscreen
></iframe>
​```

### URL 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `url` | 必需 | 视频地址（`encodeURIComponent` 后传入） |
| `title` | 空 | 顶部标题栏文字 |
| `ui` | `pc` | 控制器主题：`pc`（紧凑悬浮条）/ `tv`（大字号通栏） |
| `quality` | `origin` | 初始画质档：`720p` / `1080p` / `2k` / `origin`；仅展示不高于源分辨率的档位 |
| `mode` | `auto` | 解码模式：`auto`（自动，直通优先）/ `hw`（硬解硬编）/ `sw`（软解软编）；硬解不可用时菜单不显示硬解选项 |
| `autoplay` | `1` | 自动播放；受浏览器策略限制时先静音自动播放，用户点音量图标恢复声音 |

### 画质阶梯

720p→2.5Mbps、1080p→5Mbps、2K→10Mbps，切换画质从当前播放位置重转码。画面比例（原始/16:9/4:3）为纯前端 CSS 处理，后端输出不变。

### 手工验证清单

- [ ] PC 主题：控制栏显隐（mousemove / 3s / 5s / 暂停常显 / 单击 / 双击）
- [ ] TV 主题：大字号、时间居中、无全屏按钮
- [ ] 画质切换：位置保持、画面变小、恢复播放
- [ ] 解码切换：硬解 ↔ 软解不炸流；无硬编机器不显示硬解选项
- [ ] 倍速 0.75–3x；音量拖动与静音切换
- [ ] 精确 seek（拖到未缓冲区）、断网 5s 自动恢复
- [ ] 静音自动播放 → 点音量恢复
```

- [ ] **Step 2: AGENTS.md 更新**

「常用命令」的 build 行改为：

```markdown
- `npm run build` — vite 四连构建（主库 es+cjs → `dist/index.*`，child → `dist/child.cjs`，bin → `dist/bin.cjs`，前端 → `dist/client/`）
```

「没有配置 lint/typecheck」改为：

```markdown
- 无 lint；`npm run typecheck` 校验两端 TS（根 tsconfig 面向 Node，`tsconfig.client.json` 面向 DOM）。
```

「架构」末尾追加：

```markdown
- 前端播放器源码在 `src/client/`（TS，无运行时框架），经 `vite.config.client.ts` 构建到 `dist/client/`，server 静态服务按 `public/` → `dist/client/` fallback；`public/` 只剩 demo 页（iframe 嵌入 `/player.html`）。图标在 `src/client/icons/`（`?raw` 内联注入保留 currentColor）。
```

- [ ] **Step 3: 全量测试 + 提交**

Run: `npm test`

```bash
git add README.md AGENTS.md
git commit -m "docs: iframe 嵌入文档、URL 参数表与手工验证清单"
```

---

## 收尾核查（执行完毕后）

- [ ] `npm test` 全绿（含新 e2e）
- [ ] `npm run typecheck` 无错
- [ ] demo 页 iframe 嵌入可用；嵌入代码可复制
- [ ] QSV 缩放实测结论已记入 `src/lib/hw-accel.ts` 注释（scale_qsv 或降级链）
- [ ] spec 各节均有对应实现：画质阶梯（Task 1-5/13）、双主题 UI（Task 9-10）、iframe 参数（Task 11）、demo（Task 12）、图标（Task 7）、文档（Task 14）
