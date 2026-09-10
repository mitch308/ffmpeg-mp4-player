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
