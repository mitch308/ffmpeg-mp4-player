// test/hw-accel.test.ts
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseEncodersOutput, pickEncoder, ENCODER_PROFILES } from '../src/lib/hw-accel';

// 与 `ffmpeg -hide_banner -encoders` 输出同构的片段
const SAMPLE_ENCODERS_OUTPUT = `
 ffmpeg version 6.0-essentials_build-www.gyan.dev Copyright (c) 2000-2023
 V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)
 V....D libx264              libx264 H.264 / AVC
 V..... h264_amf             AMD AMF H.264 Encoder (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 V..... libx264rgb           libx264 H.264 RGB
 V..... mjpeg_qsv            MJPEG (Intel Quick Sync)
`;

test('parseEncodersOutput 提取编码器名集合', () => {
  const names = parseEncodersOutput(SAMPLE_ENCODERS_OUTPUT);
  assert.ok(names.has('h264_nvenc'));
  assert.ok(names.has('h264_qsv'));
  assert.ok(names.has('h264_amf'));
  assert.ok(names.has('libx264'));
  assert.ok(!names.has('h264_vaapi'), '不存在的编码器不应出现');
  assert.ok(!names.has('NVIDIA'), '描述文字不应被误当作编码器名');
});

test('pickEncoder 按优先级选择：nvenc > qsv > amf', () => {
  const all = new Set(['h264_nvenc', 'h264_qsv', 'h264_amf']);
  assert.strictEqual(pickEncoder(all), 'h264_nvenc');
  assert.strictEqual(pickEncoder(new Set(['h264_qsv', 'h264_amf'])), 'h264_qsv');
  assert.strictEqual(pickEncoder(new Set(['h264_amf'])), 'h264_amf');
});

test('pickEncoder 无硬件候选时回退 libx264', () => {
  assert.strictEqual(pickEncoder(new Set()), 'libx264');
  assert.strictEqual(pickEncoder(new Set(['libx264rgb'])), 'libx264');
});

test('每种编码器都有 profile：mode 与硬解映射', () => {
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'h264_videotoolbox', 'libx264']) {
    const p = ENCODER_PROFILES[enc];
    assert.ok(p, `${enc} 缺少 profile`);
    assert.ok(['hybrid', 'sw'].includes(p.mode), `${enc} mode 非法`);
    assert.ok(Array.isArray(p.hwDecodableCodecs), `${enc} 缺少 hwDecodableCodecs`);
    assert.ok(Array.isArray(p.encodeArgs), `${enc} 缺少 encodeArgs`);
  }
  // 统一混合管线：硬解提示 + 硬件编码器，不做 GPU 帧驻留（实测无收益、跨驱动风险高）
  assert.strictEqual(ENCODER_PROFILES.h264_nvenc.mode, 'hybrid');
  assert.strictEqual(ENCODER_PROFILES.h264_nvenc.hwaccel, 'cuda');
  assert.strictEqual(ENCODER_PROFILES.h264_qsv.hwaccel, 'qsv');
  assert.strictEqual(ENCODER_PROFILES.h264_amf.mode, 'hybrid');
  assert.strictEqual(ENCODER_PROFILES.h264_amf.hwaccel, 'd3d11va');
  assert.strictEqual(ENCODER_PROFILES.libx264.mode, 'sw');
  assert.strictEqual(ENCODER_PROFILES.libx264.hwaccel, null);
});
