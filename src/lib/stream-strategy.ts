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
    // 缩放滤镜选择：实测显式解码器（如 hevc_qsv）在下游为软滤镜时，ffmpeg 会经
    // get_format 协商让其输出系统内存帧（硬解仍生效），普通 scale 即可；
    // qsv 的硬件缩放滤镜 scale_qsv 反而运行时损坏（见 hw-accel.ts qsv profile 注释）。
    // scaleHwFilter 仅为强制 GPU 帧驻留的厂商预留。
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
