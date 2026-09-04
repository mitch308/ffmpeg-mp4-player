// lib/ffmpeg-process.js
// 按播放策略构建 ffmpeg 命令行，输出 fMP4 到 stdout。
// 策略由 lib/stream-strategy.js 依据源格式与硬件能力决定：
//   copy      直通 remux（-c:v copy，零转码开销）
//   transcode 转码（硬件/软件编码器，可选硬解与 GPU 帧处理）
const { spawn } = require('child_process');
const { getFfmpegPath } = require('./ffmpeg-path');
const { ENCODER_PROFILES } = require('./hw-accel');

/**
 * 构建 ffmpeg 参数列表（纯函数，供单测）
 *
 * @param {string} url
 * @param {number} startTime - 起始秒，直通路径会对齐到不晚于该点的关键帧
 * @param {object} strategy - stream-strategy 产出的策略对象
 * @returns {string[]}
 */
function buildArgs(url, startTime, strategy) {
  const inputOpts = ['-v', 'error'];

  // 硬解：优先显式解码器（如 hevc_qsv，稳定且快于提示路径），
  // 否则回退 -hwaccel 提示（ffmpeg 自动协商/回退软解）
  if (strategy.decoder) {
    inputOpts.push('-c:v', strategy.decoder);
  } else if (strategy.hwDecode) {
    inputOpts.push('-hwaccel', strategy.hwDecode);
  }
  inputOpts.push('-ss', String(startTime), '-i', url);

  const outputOpts = [];

  if (strategy.video === 'copy') {
    outputOpts.push('-c:v', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    const profile = ENCODER_PROFILES[strategy.encoder] || ENCODER_PROFILES.libx264;
    if (strategy.encoder === 'libx264') {
      // 质量优先：CRF 自适应码率，与原行为一致
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
      const kbps = strategy.videoBitrate || 6000;
      const maxrate = Math.round(kbps * 1.5);
      outputOpts.push(
        '-c:v', strategy.encoder,
        ...profile.encodeArgs,
        '-b:v', `${kbps}k`,
        '-maxrate', `${maxrate}k`,
        '-bufsize', `${maxrate * 2}k`,
        '-force_key_frames', 'expr:eq(n,0)'
      );
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
function createFfmpegProcess({ url, startTime, strategy, onData, onError, onExit }) {
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
    pid: proc.pid,
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

module.exports = { buildArgs, createFfmpegProcess };
