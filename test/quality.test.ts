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
  assert.deepStrictEqual(availableQualities(probe({ width: 2560, height: 1440 })), ['1080p', '720p', 'origin']); // 1440 源不含 2k（严格低于）
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
