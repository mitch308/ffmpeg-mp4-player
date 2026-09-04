// lib/stream-strategy.js
// 格式自适应决策：根据源视频探针结果 + 部署机硬件能力，产出按优先级排列的播放策略链。
// 纯函数，不触碰进程/IO，便于单测。
const { ENCODER_PROFILES } = require('./hw-accel');

/**
 * 直通（remux）资格：浏览器 MSE 可直接解码的 H.264 8bit 4:2:0。
 * 10bit（yuv420p10le）、422/444 等一概转码。
 */
function copyEligible(probeResult) {
  return probeResult.codec === 'h264' && probeResult.pixFmt === 'yuv420p';
}

/** 音频策略：AAC 拷贝、其余转 AAC（播放端永远拿到 AAC）、无音频关闭 */
function audioStrategy(probeResult) {
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
function audioLayout(probeResult) {
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
function hwDecodable(profile, probeResult) {
  if (!profile.hwaccel) return false;
  if (!profile.hwDecodableCodecs.includes(probeResult.codec)) return false;
  return probeResult.pixFmt === 'yuv420p';
}

/**
 * 转码目标码率（kbps）：0.1 bits/pixel 启发式。
 * 1080p30 ≈ 6.2Mbps、4K30 ≈ 25Mbps、4K60 ≈ 50Mbps。
 * 不指定时硬件编码器（qsv 等）默认走极低码率目标，是 4K 发糊的根因。
 */
function targetBitrateKbps(probeResult) {
  const { width = 0, height = 0, fps = 0 } = probeResult;
  if (!(width > 0) || !(height > 0)) return 6000; // 未知尺寸按 1080p 档
  const kbps = width * height * (fps > 0 ? fps : 30) * 0.1 / 1000;
  return Math.round(Math.min(Math.max(kbps, 1500), 60000));
}

/** 构造转码策略：按编码器 profile 决定硬解方式与编码器 */
function transcodeStrategy(probeResult, caps) {
  const profile = ENCODER_PROFILES[caps.encoder] || ENCODER_PROFILES.libx264;
  const canHwDecode = hwDecodable(profile, probeResult);
  return {
    label: profile.mode === 'sw' ? 'sw' : 'hw',
    video: 'transcode',
    encoder: caps.encoder,
    hwDecode: canHwDecode ? profile.hwaccel : null,
    // 显式硬件解码器（如 hevc_qsv）：优先于 -hwaccel 提示使用。
    // 实测 qsv 上 -hwaccel 提示 + 硬件编码器组合存在每帧表面泄漏
    // （内存 ~48MB/s 增长，数分钟后 ffmpeg 崩溃），显式解码器则稳定。
    decoder: canHwDecode ? (profile.decoderByCodec?.[probeResult.codec] || null) : null,
    videoBitrate: targetBitrateKbps(probeResult),
    audio: audioStrategy(probeResult),
    audioLayout: audioStrategy(probeResult) === 'aac' ? audioLayout(probeResult) : null
  };
}

/**
 * 策略链：直通资格时 [copy, 转码]，否则 [转码]。
 * 上游失败时按序取下一个重试（见 session-manager）。
 *
 * @param {object} probeResult - ffprobe 结果（codec/pixFmt/audio）
 * @param {{encoder: string, mode: string}} caps - hw-accel 探测结果
 */
function strategyChain(probeResult, caps) {
  const chain = [];
  if (copyEligible(probeResult)) {
    chain.push({
      label: 'copy',
      video: 'copy',
      encoder: null,
      hwDecode: null,
      audio: audioStrategy(probeResult),
      audioLayout: null
    });
  }
  chain.push(transcodeStrategy(probeResult, caps));
  return chain;
}

module.exports = { strategyChain };
