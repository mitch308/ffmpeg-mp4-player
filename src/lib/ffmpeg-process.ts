// src/lib/ffmpeg-process.ts
// 按播放策略构建 ffmpeg 命令行，输出 fMP4 到 stdout。
// 策略由 src/lib/stream-strategy.ts 依据源格式与硬件能力决定：
//   copy      直通 remux（-c:v copy，零转码开销）
//   transcode 转码（硬件/软件编码器，可选硬解与 GPU 帧处理）
import { spawn } from 'child_process';
import { getFfmpegPath } from './ffmpeg-path';
import { ENCODER_PROFILES } from './hw-accel';
import { normalizeLocalhostUrl } from './url';
import type { Strategy } from './stream-strategy';

/**
 * 构建 ffmpeg 参数列表（纯函数，供单测）
 *
 * @param {string} url
 * @param {number} startTime - 起始秒，直通路径会对齐到不晚于该点的关键帧
 * @param {object} strategy - stream-strategy 产出的策略对象
 * @returns {string[]}
 */
export function buildArgs(url: string, startTime: number, strategy: Strategy): string[] {
  const inputOpts = ['-v', 'error'];

  // 硬解：优先显式解码器（如 hevc_qsv，稳定且快于提示路径），
  // 否则回退 -hwaccel 提示（ffmpeg 自动协商/回退软解）
  if (strategy.decoder) {
    inputOpts.push('-c:v', strategy.decoder);
  } else if (strategy.hwDecode) {
    inputOpts.push('-hwaccel', strategy.hwDecode);
  }
  // localhost 在 Windows 上解析为 ::1，IPv4-only 服务会连接挂死，重写为 127.0.0.1
  inputOpts.push('-ss', String(startTime), '-i', normalizeLocalhostUrl(url));

  const outputOpts: string[] = [];

  if (strategy.video === 'copy') {
    outputOpts.push('-c:v', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    const profile = ENCODER_PROFILES[strategy.encoder as string] || ENCODER_PROFILES.libx264;
    // 阶梯画质（带 scale）→ 固定码率模式，libx264 也不例外（画质档=明确码率契约）；
    // origin 软转码保持 CRF 23 质量优先（与原行为一致）
    const kbps = strategy.videoBitrate || 6000;
    const maxrate = Math.round(kbps * 1.5);
    // 输出恒为浏览器可解的 8bit yuv420p：10bit/422 源经 libx264 会被原样保留
    // （high10 输出浏览器不可解），显式声明目标像素格式让 swscale 自动转换；
    // 8bit yuv420p 源下该声明为 no-op。硬件编码器（qsv 等）输出恒为 8bit，无需声明。
    if (strategy.encoder === 'libx264') {
      outputOpts.push('-pix_fmt', 'yuv420p');
    }
    if (strategy.encoder === 'libx264' && !strategy.scale) {
      outputOpts.push(
        '-c:v', strategy.encoder,
        ...profile.encodeArgs,
        '-crf', '23',
        '-force_key_frames', 'expr:eq(n,0)',
        '-threads', '0', '-bufsize', '2M'
      );
    } else {
      // 硬件编码器不会自动做质量自适应，必须显式指定码率控制，
      // 否则 qsv 等默认极低码率目标导致高分辨率发糊
      outputOpts.push(
        '-c:v', strategy.encoder!,
        ...profile.encodeArgs,
        '-b:v', `${kbps}k`,
        '-maxrate', `${maxrate}k`,
        '-bufsize', `${maxrate * 2}k`,
        '-force_key_frames', 'expr:eq(n,0)'
      );
    }
    // 画质档缩放：vf 值由 stream-strategy 组装（含厂商滤镜选择）
    if (strategy.scale) {
      outputOpts.push('-vf', strategy.scale.vf);
    }
  }

  if (strategy.audio === 'copy') {
    outputOpts.push('-c:a', 'copy');
  } else if (strategy.audio === 'aac') {
    outputOpts.push('-c:a', 'aac', '-b:a', '128k');
    if (strategy.audioLayout) {
      // 5.1(side) 等布局会让 ffmpeg 写出 chanCfg=0 的 ASC，Chrome MSE 拒绝；强制标准布局
      outputOpts.push('-af', `aformat=channel_layouts=${strategy.audioLayout}`);
    }
  } else {
    outputOpts.push('-an');
  }

  outputOpts.push(
    // MKV 等容器的章节表会被 mov muxer 写成 QuickTime 章节文本轨（gmhd + tref chap），
    // Chrome MSE 的 fMP4 解析器拒绝含该轨的 init segment（CHUNK_DEMUXER_ERROR_APPEND_FAILED），
    // 故一律丢弃章节映射
    '-map_chapters', '-1',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'  // 输出到 stdout，不能带前导 '-'，否则被 ffmpeg 当作选项解析
  );

  return [...inputOpts, ...outputOpts];
}

/**
 * 创建 ffmpeg 转码/直通进程
 *
 * @param {object} opts
 * @param {string} opts.url - 视频源 URL
 * @param {number} opts.startTime - 起始时间（秒）
 * @param {object} opts.strategy - 播放策略
 * @param {(chunk: Buffer) => void} opts.onData - 数据回调
 * @param {(err: Error) => void} opts.onError - 错误回调
 * @param {(code: number|null) => void} opts.onExit - 进程退出回调
 * @returns {{ pid: number, kill: () => void }}
 */
export function createFfmpegProcess({ url, startTime, strategy, onData, onError, onExit }: {
  url: string;
  startTime: number;
  strategy: Strategy;
  onData: (chunk: Buffer) => void;
  onError: (err: Error) => void;
  onExit: (code: number | null) => void;
}): { pid: number; kill(): void } {
  const args = buildArgs(url, startTime, strategy);

  const proc = spawn(getFfmpegPath(), args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let killed = false;
  let stderr = '';
  const startedAt = Date.now();
  console.log(`[ffmpeg] started pid=${proc.pid} start=${startTime}s strategy=${strategy.label || strategy.encoder || strategy.video}`);

  proc.stdout.on('data', (chunk) => {
    if (!killed) {
      onData(chunk);
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  proc.on('close', (code) => {
    if (killed) {
      console.log(`[ffmpeg] pid=${proc.pid} exited (killed) code=${code} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      return;
    }
    console.log(`[ffmpeg] pid=${proc.pid} exited code=${code} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s${code !== 0 && code !== null ? ` stderr: ${stderr.slice(-200)}` : ''}`);
    if (code !== 0 && code !== null) {
      onError(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    }
    onExit(code);
  });

  proc.on('error', (err) => {
    if (killed) return;
    onError(new Error(`Failed to spawn ffmpeg: ${err.message}`));
  });

  return {
    pid: proc.pid!,
    kill() {
      killed = true;
      // Windows 上需要强制杀进程树。用异步 spawn 避免同步阻塞事件循环
      // （多并发会话下同步 kill 会让其他会话的流卡顿）。
      if (process.platform === 'win32') {
        try {
          const tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore'
          });
          tk.on('error', () => { /* 进程可能已退出 */ });
        } catch (e) {
          // 进程可能已退出
        }
      } else {
        try {
          proc.kill('SIGKILL');
        } catch (e) {
          // 进程可能已退出
        }
      }
    }
  };
}
