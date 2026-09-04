// test/hw-pipeline.test.js — 硬件管线集成测试（硬解提示 → 硬件编码器）
// 无硬件环境（探测结果为 libx264）自动跳过
const { test } = require('node:test');
const assert = require('node:assert');
const { getCaps, ENCODER_PROFILES } = require('../lib/hw-accel');
const { strategyChain } = require('../lib/stream-strategy');
const { createFfmpegProcess } = require('../lib/ffmpeg-process');
const { ensureSamples } = require('./helpers/samples');
const { getFfprobePath } = require('../lib/ffmpeg-path');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

test('HEVC 8bit → 硬解提示 + 硬件编码，产物 8bit H.264', async () => {
  const caps = await getCaps();
  if (caps.mode === 'sw') {
    return test.skip('本机无硬件编码器（libx264），跳过');
  }
  const profile = ENCODER_PROFILES[caps.encoder];

  const s = ensureSamples();
  const strategy = strategyChain(
    { codec: 'hevc', pixFmt: 'yuv420p', audio: null },
    caps
  )[0];
  assert.strictEqual(strategy.hwDecode, profile.hwaccel, '应启用硬解提示');
  assert.strictEqual(strategy.encoder, caps.encoder, '应使用硬件编码器');

  const out = path.join(os.tmpdir(), 'hw-pipeline-8bit.mp4');
  const chunks = [];
  const code = await new Promise((resolve, reject) => {
    createFfmpegProcess({
      url: s.hevc8,
      startTime: 0,
      strategy,
      onData: (c) => chunks.push(c),
      onError: reject,
      onExit: resolve
    });
  });
  assert.strictEqual(code, 0, 'ffmpeg 应正常退出');
  const totalBytes = chunks.reduce((a, c) => a + c.length, 0);
  assert.ok(totalBytes > 10000, `应有输出数据（实际 ${totalBytes} 字节）`);

  fs.writeFileSync(out, Buffer.concat(chunks));
  const j = await new Promise((resolve, reject) =>
    execFile(getFfprobePath(), ['-v', 'quiet', '-print_format', 'json', '-show_streams', out],
      (e, o) => e ? reject(e) : resolve(JSON.parse(o))));
  const v = j.streams.find(x => x.codec_type === 'video');
  assert.strictEqual(v.codec_name, 'h264');
  assert.strictEqual(v.pix_fmt, 'yuv420p');
});

test('HEVC 10bit → 软解 + 硬件编码，产物 8bit H.264', async () => {
  const caps = await getCaps();
  if (caps.mode === 'sw') {
    return test.skip(`本机无硬件编码器（libx264），跳过`);
  }
  const profile = ENCODER_PROFILES[caps.encoder];

  const s = ensureSamples();
  const strategy = strategyChain(
    { codec: 'hevc', pixFmt: 'yuv420p10le', audio: null },
    caps
  )[0];
  assert.strictEqual(strategy.hwDecode, null, '10bit 不硬解（帧无法交给 H.264 硬编）');
  assert.strictEqual(strategy.encoder, caps.encoder, '编码仍走硬件');

  const out = path.join(os.tmpdir(), 'hw-pipeline.mp4');
  const chunks = [];
  const code = await new Promise((resolve, reject) => {
    createFfmpegProcess({
      url: s.hevcHi10,
      startTime: 0,
      strategy,
      onData: (c) => chunks.push(c),
      onError: reject,
      onExit: resolve
    });
  });
  assert.strictEqual(code, 0, 'ffmpeg 应正常退出');
  const totalBytes = chunks.reduce((a, c) => a + c.length, 0);
  assert.ok(totalBytes > 10000, `应有输出数据（实际 ${totalBytes} 字节）`);

  fs.writeFileSync(out, Buffer.concat(chunks));
  const j = await new Promise((resolve, reject) =>
    execFile(getFfprobePath(), ['-v', 'quiet', '-print_format', 'json', '-show_streams', out],
      (e, o) => e ? reject(e) : resolve(JSON.parse(o))));
  const v = j.streams.find(x => x.codec_type === 'video');
  assert.strictEqual(v.codec_name, 'h264');
  assert.strictEqual(v.pix_fmt, 'yuv420p');
});
