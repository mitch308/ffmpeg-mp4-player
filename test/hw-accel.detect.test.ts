// test/hw-accel.detect.test.ts — 真实 ffmpeg 参与的探测集成测试
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { detectCaps, resetCaps, ENCODER_PROFILES } from '../src/lib/hw-accel';

test('FFMPEG_HW_ENCODER=none 强制回退 libx264', async () => {
  process.env.FFMPEG_HW_ENCODER = 'none';
  resetCaps();
  const caps = await detectCaps();
  assert.strictEqual(caps.encoder, 'libx264');
  assert.strictEqual(caps.mode, 'sw');
  delete process.env.FFMPEG_HW_ENCODER;
  resetCaps();
});

test('真实探测返回合法结果（有硬件用硬件，无硬件回退 libx264）', async () => {
  resetCaps();
  const caps = await detectCaps();
  assert.ok(ENCODER_PROFILES[caps.encoder], `encoder=${caps.encoder} 应在 profile 表中`);
  assert.ok(['gpu', 'hybrid', 'sw'].includes(caps.mode));
  console.log('本机探测结果:', JSON.stringify(caps));
});
