// src/lib/hw-accel.ts
// 硬件编码能力探测：启动时检测部署机器上真实可用的硬件编码器并缓存。
//
// 两步探测：
//  1. 解析 `ffmpeg -encoders`，得到编译期存在的候选（不代表驱动可用）
//  2. 对候选按优先级做真实测试编码（lavfi 黑帧 → 编码 6 帧），第一个成功者胜出
//
// 环境变量 FFMPEG_HW_ENCODER：
//  - "none"           强制禁用硬件加速（走 libx264）
//  - "<encoder 名>"   只测试该编码器，失败仍回退 libx264
import { spawn } from 'child_process';
import { getFfmpegPath } from './ffmpeg-path';

export interface Caps { encoder: string; mode: 'hybrid' | 'sw'; label: string; }

// EncoderProfile: 硬件/软件编码器的使用方式
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

// 优先级从高到低（NVIDIA > Intel > AMD > 通用 Linux/Mac 方案）
export const PRIORITY: string[] = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'h264_videotoolbox'];

// 每种编码器的使用方式：
// - mode 'hybrid' 混合管线：-hwaccel 硬解提示（ffmpeg 自动回退软解）+ 硬件编码器，
//   帧路径由 ffmpeg 与驱动自动协商。实测 GPU 帧驻留（scale_cuda/vpp_qsv）在本机
//   无收益且跨驱动风险高，故不做全 GPU 特化。
// - mode 'sw'     纯软件
// - hwDecodableCodecs: 该硬件管线可硬解的源编码（保守列表，配合 pix_fmt 守卫，
//   见 stream-strategy；硬解不可用时 ffmpeg 自动回退软解，编码不受影响）
// - encodeArgs:      该编码器的速度优先参数
export const ENCODER_PROFILES: Record<string, EncoderProfile> = {
  h264_nvenc: {
    mode: 'hybrid',
    hwaccel: 'cuda',
    hwDecodableCodecs: ['h264', 'hevc'],
    // 码率控制（-b:v/-maxrate/-bufsize）由 stream-strategy 按分辨率统一提供
    encodeArgs: ['-preset', 'p1', '-tune', 'ull', '-rc', 'vbr'],
    label: 'NVIDIA NVENC'
  },
  h264_qsv: {
    mode: 'hybrid',
    hwaccel: 'qsv',
    hwDecodableCodecs: ['h264', 'hevc', 'vp9', 'mpeg2video', 'mjpeg'],
    // 显式解码器：-hwaccel qsv 提示路径与硬件编码器组合存在表面泄漏（见 stream-strategy），
    // qsv 必须走显式解码器（实测稳定，且转码速度约 3x 实时）
    decoderByCodec: {
      h264: 'h264_qsv',
      hevc: 'hevc_qsv',
      vp9: 'vp9_qsv',
      mpeg2video: 'mpeg2_qsv',
      mjpeg: 'mjpeg_qsv'
    },
    // 显式解码器输出 qsv GPU 帧，缩放必须走硬件 vpp 滤镜（普通 scale 会报格式转换错误）
    scaleHwFilter: 'scale_qsv',
    encodeArgs: ['-preset', 'veryfast'],
    label: 'Intel QSV'
  },
  h264_amf: {
    mode: 'hybrid',
    hwaccel: 'd3d11va',
    hwDecodableCodecs: ['h264', 'hevc'],
    encodeArgs: ['-quality', 'speed'],
    label: 'AMD AMF'
  },
  h264_vaapi: {
    mode: 'hybrid',
    hwaccel: 'vaapi',
    hwDecodableCodecs: ['h264', 'hevc', 'vp9'],
    encodeArgs: ['-quality', 'speed'],
    label: 'VA-API'
  },
  h264_videotoolbox: {
    mode: 'hybrid',
    hwaccel: 'videotoolbox',
    hwDecodableCodecs: ['h264', 'hevc'],
    encodeArgs: ['-realtime', '1'],
    label: 'VideoToolbox'
  },
  libx264: {
    mode: 'sw',
    hwaccel: null,
    hwDecodableCodecs: [],
    encodeArgs: ['-preset', 'ultrafast', '-tune', 'zerolatency'],
    label: '软件 libx264'
  }
};

/** 从 `ffmpeg -encoders` 输出中提取编码器名集合 */
export function parseEncodersOutput(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[A-Z.]{6}\s+(\S+)\s/);
    if (m) names.add(m[1]);
  }
  return names;
}

/** 按优先级从可用集合中选编码器，无硬件候选时回退 libx264 */
export function pickEncoder(available: Set<string>): string {
  for (const enc of PRIORITY) {
    if (available.has(enc)) return enc;
  }
  return 'libx264';
}

function listCompiledEncoders(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.on('error', () => resolve(''));   // spawn 失败 → 空集合，后面全走 libx264
    proc.on('close', () => resolve(stdout));
  });
}

/** 对单个编码器做真实测试编码，验证驱动真实可用 */
function verifyEncoder(encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const profile = ENCODER_PROFILES[encoder];
    const args = [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.3',
      '-frames:v', '6',
      '-c:v', encoder,
      ...(profile ? profile.encodeArgs : []),
      '-f', 'null', '-'
    ];
    const proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch (e) { /* 已退出 */ }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 8000);
    timer.unref && timer.unref();

    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', () => { clearTimeout(timer); done(false); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0);
      if (code !== 0) {
        console.warn(`[hw-accel] ${encoder} 测试编码失败: ${stderr.slice(-200).trim()}`);
      }
    });
  });
}

function capsFor(encoder: string): Caps {
  const p = ENCODER_PROFILES[encoder] || ENCODER_PROFILES.libx264;
  return { encoder, mode: p.mode, label: p.label };
}

/** 探测本机最优硬件编码器（不缓存，缓存见 getCaps） */
export async function detectCaps(): Promise<Caps> {
  const forced = process.env.FFMPEG_HW_ENCODER;
  if (forced === 'none') return capsFor('libx264');

  let listed: Set<string> = new Set();
  if (!forced) {
    listed = parseEncodersOutput(await listCompiledEncoders());
  }

  const candidates = forced ? [forced] : PRIORITY.filter((e) => listed.has(e));
  for (const enc of candidates) {
    if (!ENCODER_PROFILES[enc]) continue; // 强制指定的名字不在 profile 表中 → 忽略
    if (await verifyEncoder(enc)) return capsFor(enc);
  }
  return capsFor('libx264');
}

let cached: Promise<Caps> | null = null;

/** 获取能力（进程内缓存；检测失败自动回退 libx264，不会 reject） */
export function getCaps(): Promise<Caps> {
  if (!cached) {
    cached = detectCaps().then((caps) => {
      console.log(`[hw-accel] 使用编码器: ${caps.encoder} (${caps.label}, mode=${caps.mode})`);
      return caps;
    });
  }
  return cached;
}

/** 供测试/运维强制重新探测 */
export function resetCaps(): void {
  cached = null;
}
