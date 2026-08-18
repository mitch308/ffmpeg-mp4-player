// lib/ffmpeg-process.js
const { spawn } = require('child_process');
const { getFfmpegPath } = require('./ffmpeg-path');

/**
 * 创建 ffmpeg 转码进程，输出 fMP4 到 stdout
 *
 * @param {string} url - 视频源 URL
 * @param {number} startTime - 起始时间（秒），0 表示从头开始
 * @param {(chunk: Buffer) => void} onData - 数据回调
 * @param {(err: Error) => void} onError - 错误回调
 * @param {(code: number|null) => void} onExit - 进程退出回调
 * @returns {{ kill: () => void }}
 */
function createFfmpegProcess(url, startTime, onData, onError, onExit) {
  const ffmpegPath = getFfmpegPath();
  const args = [
    '-ss', String(startTime),
    '-i', url,
    '-force_key_frames', 'expr:eq(n,0)',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-an',           // 先禁用音频，简化首次实现
    '-threads', '0',
    '-bufsize', '2M',
    'pipe:1'         // 输出目标（stdout），不能带前导 '-'，否则被 ffmpeg 当作选项解析
  ];

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let killed = false;
  let stderr = '';

  proc.stdout.on('data', (chunk) => {
    if (!killed) {
      onData(chunk);
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  proc.on('close', (code) => {
    if (killed) return;
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
    kill() {
      killed = true;
      // Windows 上需要强制杀进程树
      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } catch (e) {
          // 进程可能已退出
        }
      } else {
        proc.kill('SIGKILL');
      }
    }
  };
}

module.exports = { createFfmpegProcess };
