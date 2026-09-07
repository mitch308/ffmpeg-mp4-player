// test/ffprobe.test.ts
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { probe } from '../src/lib/ffprobe';
import { ensureSamples } from './helpers/samples';

test('probe 返回视频基础信息', async () => {
  const s = ensureSamples();
  const r = await probe(s.h264Aac);
  assert.strictEqual(r.width, 320);
  assert.strictEqual(r.height, 240);
  assert.strictEqual(r.codec, 'h264');
  assert.ok(r.duration > 0.5 && r.duration < 3, `duration=${r.duration}`);
});

test('probe 返回帧率（码率估算依据）', async () => {
  const s = ensureSamples();
  const r = await probe(s.h264Aac);
  assert.ok(r.fps > 20 && r.fps <= 60, `fps=${r.fps}`);
});

test('probe 返回像素格式（8bit yuv420p 判定直通的依据）', async () => {
  const s = ensureSamples();
  const r = await probe(s.h264Aac);
  assert.strictEqual(r.pixFmt, 'yuv420p');
});

test('probe 返回 profile', async () => {
  const s = ensureSamples();
  const r = await probe(s.h264Aac);
  assert.ok(typeof r.profile === 'string' && r.profile.length > 0);
});

test('probe 识别 AAC 音频流', async () => {
  const s = ensureSamples();
  const r = await probe(s.h264Aac);
  assert.ok(r.audio, 'audio should exist');
  assert.strictEqual(r.audio.codec, 'aac');
  assert.ok(r.audio.channels >= 1);
  assert.ok(r.audio.sampleRate > 0);
});

test('无音频流时 audio 为 null', async () => {
  const s = ensureSamples();
  const r = await probe(s.h264NoAudio);
  assert.strictEqual(r.audio, null);
});

test('10bit 源报告 yuv420p10le', async () => {
  const s = ensureSamples();
  const r = await probe(s.h264Hi10);
  assert.strictEqual(r.pixFmt, 'yuv420p10le');
});
