// test/ffmpeg-process.test.ts — 按策略构建 ffmpeg 参数（纯函数部分）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildArgs } from '../src/lib/ffmpeg-process';
import type { Strategy } from '../src/lib/stream-strategy';

const copyStrat: Strategy = { label: 'copy', video: 'copy', encoder: null, hwDecode: null, audio: 'copy' };
const swStrat: Strategy = { label: 'sw', video: 'transcode', encoder: 'libx264', hwDecode: null, audio: 'none', videoBitrate: 6000 };
const nvencHw: Strategy = { label: 'hw', video: 'transcode', encoder: 'h264_nvenc', hwDecode: 'cuda', audio: 'aac', videoBitrate: 25000 };
const amfHw: Strategy = { label: 'hw', video: 'transcode', encoder: 'h264_amf', hwDecode: 'd3d11va', audio: 'copy', videoBitrate: 6000 };
const qsvHw: Strategy = { label: 'hw', video: 'transcode', encoder: 'h264_qsv', hwDecode: 'qsv', decoder: 'hevc_qsv', audio: 'aac', videoBitrate: 15000 };
const nvencSwDecode: Strategy = { label: 'hw', video: 'transcode', encoder: 'h264_nvenc', hwDecode: null, audio: 'none', videoBitrate: 25000 };

const idx = (args: string[], x: string) => args.indexOf(x);

test('直通：-c:v copy，无编码器/强制关键帧参数，负时间戳归零', () => {
  const a = buildArgs('http://x/v.ts', 12.5, copyStrat);
  assert.ok(idx(a, '-c:v') !== -1 && a[idx(a, '-c:v') + 1] === 'copy');
  assert.strictEqual(idx(a, '-force_key_frames'), -1);
  assert.ok(idx(a, '-avoid_negative_ts') !== -1);
  assert.ok(idx(a, '-ss') !== -1 && a[idx(a, '-ss') + 1] === '12.5');
  assert.ok(idx(a, '-ss') < idx(a, '-i'));
  assert.strictEqual(a[a.length - 1], 'pipe:1');
});

test('直通含 AAC 音频 → -c:a copy', () => {
  const a = buildArgs('u', 0, copyStrat);
  assert.ok(idx(a, '-c:a') !== -1 && a[idx(a, '-c:a') + 1] === 'copy');
  assert.strictEqual(idx(a, '-an'), -1);
});

test('软件转码：libx264 ultrafast + 强制首帧关键帧 + -an', () => {
  const a = buildArgs('u', 0, swStrat);
  assert.ok(a.includes('libx264'));
  assert.ok(idx(a, '-preset') !== -1 && a[idx(a, '-preset') + 1] === 'ultrafast');
  assert.ok(idx(a, '-force_key_frames') !== -1);
  assert.ok(a.includes('-an'));
  assert.ok(!a.includes('-hwaccel'));
});

test('NVENC 硬解提示位于 -i 前，编码器与其速度参数', () => {
  const a = buildArgs('u', 0, nvencHw);
  const iPos = idx(a, '-i');
  assert.ok(idx(a, '-hwaccel') !== -1 && idx(a, '-hwaccel') < iPos);
  assert.strictEqual(a[idx(a, '-hwaccel') + 1], 'cuda');
  assert.ok(a.includes('h264_nvenc'));
  assert.ok(idx(a, '-ss') < iPos);
  // 混合管线：不做 GPU 帧驻留
  assert.strictEqual(idx(a, '-vf'), -1);
  assert.strictEqual(idx(a, '-hwaccel_output_format'), -1);
});

test('AMF 硬解提示 d3d11va、无帧滤镜', () => {
  const a = buildArgs('u', 0, amfHw);
  assert.ok(a.includes('d3d11va'));
  assert.strictEqual(idx(a, '-vf'), -1);
  assert.ok(a.includes('h264_amf'));
  assert.ok(a[idx(a, '-c:a') + 1] === 'copy');
});

test('QSV：用显式解码器（-c:v hevc_qsv）替代 -hwaccel 提示，均位于 -i 之前', () => {
  const a = buildArgs('u', 0, qsvHw);
  const iPos = idx(a, '-i');
  // 输入侧解码器：位于 -i 前的第一个 -c:v
  const decIdx = idx(a, '-c:v');
  assert.ok(decIdx !== -1 && decIdx < iPos, '输入解码器应在 -i 之前');
  assert.strictEqual(a[decIdx + 1], 'hevc_qsv');
  assert.strictEqual(idx(a, '-hwaccel'), -1, '不再使用 -hwaccel 提示');
  // 输出侧编码器仍在 -i 之后
  const encIdx = a.indexOf('-c:v', iPos);
  assert.ok(encIdx !== -1 && a[encIdx + 1] === 'h264_qsv');
});

test('无显式解码器的策略回退 -hwaccel 提示（nvenc/amf 行为不变）', () => {
  const a = buildArgs('u', 0, nvencHw);
  const iPos = idx(a, '-i');
  assert.ok(idx(a, '-hwaccel') !== -1 && idx(a, '-hwaccel') < iPos);
});

test('硬编但软解（vp9+nvenc）：完全无 hwaccel，仍用 nvenc', () => {
  const a = buildArgs('u', 0, nvencSwDecode);
  assert.strictEqual(idx(a, '-hwaccel'), -1);
  assert.ok(a.includes('h264_nvenc'));
  assert.ok(a.includes('-an'));
});

test('硬件编码器：按策略码率显式 VBR 控制（修复 4K 发糊）', () => {
  const a = buildArgs('u', 0, nvencHw);
  assert.ok(idx(a, '-b:v') !== -1 && a[idx(a, '-b:v') + 1] === '25000k', JSON.stringify(a));
  assert.ok(idx(a, '-maxrate') !== -1 && parseInt(a[idx(a, '-maxrate') + 1]) > 25000, 'maxrate 应高于目标码率');
  assert.ok(idx(a, '-bufsize') !== -1);
  const b = buildArgs('u', 0, amfHw);
  assert.ok(idx(b, '-b:v') !== -1 && b[idx(b, '-b:v') + 1] === '6000k');
});

test('软件 x264 用质量优先 CRF，不用目标码率', () => {
  const a = buildArgs('u', 0, swStrat);
  assert.ok(idx(a, '-crf') !== -1);
  assert.strictEqual(idx(a, '-b:v'), -1);
});

test('直通路径无任何码率控制参数', () => {
  const a = buildArgs('u', 0, copyStrat);
  assert.strictEqual(idx(a, '-b:v'), -1);
  assert.strictEqual(idx(a, '-crf'), -1);
});

test('非 AAC 音频转 AAC 128k', () => {
  const s: Strategy = Object.assign({}, swStrat, { audio: 'aac' });
  const a = buildArgs('u', 0, s);
  assert.ok(a.includes('aac'));
  assert.ok(idx(a, '-b:a') !== -1 && a[idx(a, '-b:a') + 1] === '128k');
});

test('fMP4 封装参数对所有路径一致', () => {
  for (const s of [copyStrat, swStrat, nvencHw]) {
    const a = buildArgs('u', 0, s);
    assert.ok(idx(a, '-movflags') !== -1);
    assert.ok(a[idx(a, '-movflags') + 1].includes('frag_keyframe'));
    assert.ok(a[idx(a, '-movflags') + 1].includes('empty_moov'));
  }
});

test('所有路径丢弃章节映射（-map_chapters -1），防止 MKV 章节表生成 MSE 不支持的章节文本轨', () => {
  for (const s of [copyStrat, swStrat, nvencHw]) {
    const a = buildArgs('u', 0, s);
    const i = idx(a, '-map_chapters');
    assert.ok(i !== -1, `路径 ${s.label} 缺少 -map_chapters`);
    assert.strictEqual(a[i + 1], '-1');
  }
});

test('AAC 转码环绕声源：aformat 强制标准布局；立体声/拷贝路径无 -af', () => {
  const surround: Strategy = Object.assign({}, swStrat, { audio: 'aac', audioLayout: '5.1' });
  const a = buildArgs('u', 0, surround);
  const i = idx(a, '-af');
  assert.ok(i !== -1, '环绕声 AAC 转码应带 -af');
  assert.strictEqual(a[i + 1], 'aformat=channel_layouts=5.1');
  // 无 audioLayout 的 AAC 转码不加滤镜
  const plain: Strategy = Object.assign({}, swStrat, { audio: 'aac', audioLayout: null });
  assert.strictEqual(idx(buildArgs('u', 0, plain), '-af'), -1);
  // 拷贝/关闭音频路径不加滤镜
  assert.strictEqual(idx(buildArgs('u', 0, copyStrat), '-af'), -1);
  assert.strictEqual(idx(buildArgs('u', 0, swStrat), '-af'), -1);
});

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
