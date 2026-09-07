// test/stream-strategy.test.ts — 格式自适应决策（纯函数）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { strategyChain } from '../src/lib/stream-strategy';
import type { Caps } from '../src/lib/hw-accel';
import type { ProbeResult } from '../src/lib/ffprobe';

const NVENC: Caps = { encoder: 'h264_nvenc', mode: 'hybrid', label: 'NVIDIA NVENC' };
const QSV: Caps = { encoder: 'h264_qsv', mode: 'hybrid', label: 'Intel QSV' };
const SW: Caps = { encoder: 'libx264', mode: 'sw', label: '软件 libx264' };
const AMF: Caps = { encoder: 'h264_amf', mode: 'hybrid', label: 'AMD AMF' };

const probe = (over?: Partial<ProbeResult>): ProbeResult => Object.assign({
  codec: 'h264', pixFmt: 'yuv420p', fps: 30,
  audio: { codec: 'aac', channels: 2, sampleRate: 44100 }
}, over) as ProbeResult;

test('转码策略携带按分辨率估算的目标码率', () => {
  const k4 = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p10le', width: 3840, height: 2160, fps: 30 }), NVENC)[0];
  assert.ok(k4.videoBitrate! >= 20000 && k4.videoBitrate! <= 35000, `4K30 videoBitrate=${k4.videoBitrate}kbps`);
  const fhd = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080, fps: 30 }), NVENC)[0];
  assert.ok(fhd.videoBitrate! >= 4000 && fhd.videoBitrate! <= 10000, `1080p30 videoBitrate=${fhd.videoBitrate}kbps`);
  const hd60 = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p10le', width: 1280, height: 720, fps: 60 }), NVENC)[0];
  assert.ok(hd60.videoBitrate! >= 3000 && hd60.videoBitrate! <= 9000, `720p60 videoBitrate=${hd60.videoBitrate}kbps`);
  const copy = strategyChain(probe(), NVENC)[0];
  assert.strictEqual(copy.videoBitrate, undefined, '直通无码率参数');
});

test('缺帧率信息时按 30fps 估算', () => {
  const s = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080, fps: undefined }), NVENC)[0];
  assert.ok(s.videoBitrate! > 0);
});

test('H.264 8bit 源 → 直通优先，硬件转码兜底', () => {
  const chain = strategyChain(probe(), NVENC);
  assert.strictEqual(chain.length, 2);
  assert.strictEqual(chain[0].label, 'copy');
  assert.strictEqual(chain[0].video, 'copy');
  assert.strictEqual(chain[0].encoder, null);       // 直通不需要编码器
  assert.strictEqual(chain[0].hwDecode, null);
  assert.strictEqual(chain[1].label, 'hw');
  assert.strictEqual(chain[1].video, 'transcode');
  assert.strictEqual(chain[1].encoder, 'h264_nvenc');
  assert.strictEqual(chain[1].hwDecode, 'cuda');    // nvenc 管线可硬解 h264
});

test('10bit 源不可直通 → 仅硬件转码（Hi10 软解）', () => {
  const chain = strategyChain(probe({ pixFmt: 'yuv420p10le' }), QSV);
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].label, 'hw');
  assert.strictEqual(chain[0].video, 'transcode');
  assert.strictEqual(chain[0].hwDecode, null, 'Hi10 不硬解');
});

test('无硬件可用 → 软件转码，不启用硬解', () => {
  const chain = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p' }), SW);
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].label, 'sw');
  assert.strictEqual(chain[0].encoder, 'libx264');
  assert.strictEqual(chain[0].hwDecode, null);
});

test('vp9 源 + QSV → 硬解（qsv 支持 vp9）', () => {
  const chain = strategyChain(probe({ codec: 'vp9', pixFmt: 'yuv420p' }), QSV);
  assert.strictEqual(chain[0].hwDecode, 'qsv');
});

test('vp9 源 + NVENC → 软解硬编（保守：cuda 管线不解 vp9）', () => {
  const chain = strategyChain(probe({ codec: 'vp9', pixFmt: 'yuv420p' }), NVENC);
  assert.strictEqual(chain[0].encoder, 'h264_nvenc');
  assert.strictEqual(chain[0].hwDecode, null);
});

test('混合模式（AMF）硬解提示为 d3d11va', () => {
  const chain = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p' }), AMF);
  assert.strictEqual(chain[0].label, 'hw');
  assert.strictEqual(chain[0].hwDecode, 'd3d11va');
});

test('H.264 Hi10 不可硬解（GPU 普遍不支持）→ 软解 + 硬编', () => {
  const chain = strategyChain(probe({ pixFmt: 'yuv420p10le' }), QSV);
  assert.strictEqual(chain[0].label, 'hw');
  assert.strictEqual(chain[0].encoder, 'h264_qsv');
  assert.strictEqual(chain[0].hwDecode, null, 'Hi10 不应启用硬解');
});

test('HEVC 10bit 也不硬解（qsv/cuda 表面无法自动转 8bit 交给 H.264 编码器）', () => {
  const chain = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p10le' }), NVENC);
  assert.strictEqual(chain[0].hwDecode, null, '10bit 一律软解');
  assert.strictEqual(chain[0].encoder, 'h264_nvenc', '编码仍走硬件');
});

test('非 4:2:0 采样（如 422）一律不硬解', () => {
  const chain = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv422p10le' }), NVENC);
  assert.strictEqual(chain[0].hwDecode, null);
});

test('音频：AAC 拷贝，非 AAC 转 AAC，无音频 none —— 直通路径', () => {
  assert.strictEqual(strategyChain(probe(), SW)[0].audio, 'copy');
  assert.strictEqual(
    strategyChain(probe({ audio: { codec: 'opus', channels: 2, sampleRate: 48000 } }), SW)[0].audio,
    'aac'
  );
  assert.strictEqual(strategyChain(probe({ audio: null }), SW)[0].audio, 'none');
});

test('音频决策同样作用于转码路径', () => {
  const [s] = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p' }), SW);
  assert.strictEqual(s.audio, 'copy');
  const [t] = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p', audio: { codec: 'ac3', channels: 6, sampleRate: 48000 } }), SW);
  assert.strictEqual(t.audio, 'aac');
});

test('环绕声源转 AAC 时标注标准布局（防止 ffmpeg 写出 chanCfg=0 的 ASC，Chrome MSE 拒绝）', () => {
  // 5.1(side) 等 6 声道源 → 5.1（back 变体）
  const [s51side] = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p', audio: { codec: 'eac3', channels: 6, sampleRate: 48000 } }), SW);
  assert.strictEqual(s51side.audio, 'aac');
  assert.strictEqual(s51side.audioLayout, '5.1');
  // 8 声道源 → 7.1
  const [s71] = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p', audio: { codec: 'truehd', channels: 8, sampleRate: 48000 } }), SW);
  assert.strictEqual(s71.audioLayout, '7.1');
  // 双声道/单声道/无音频 → 无需布局滤镜
  const [stereo] = strategyChain(probe({ codec: 'hevc', pixFmt: 'yuv420p', audio: { codec: 'aac', channels: 2, sampleRate: 44100 } }), SW);
  assert.strictEqual(stereo.audioLayout, null);
  assert.strictEqual(strategyChain(probe({ audio: null }), SW)[0].audioLayout, null);
  // 直通（audio=copy）不需要布局滤镜
  const [copy] = strategyChain(probe(), SW);
  assert.strictEqual(copy.audio, 'copy');
  assert.strictEqual(copy.audioLayout, null);
});
