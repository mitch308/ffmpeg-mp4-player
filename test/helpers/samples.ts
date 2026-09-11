// test/helpers/samples.ts
// 用捆绑的 ffmpeg 生成测试样本（懒加载，生成一次后复用）
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { getFfmpegPath } from '../../src/lib/ffmpeg-path';

export interface Samples {
  dir: string;
  h264Aac: string;
  h264NoAudio: string;
  h264Hi10: string;
  hevcHi10: string;
  hevc8: string;
  h264Aac1080: string;   // 1080p H.264+AAC：画质档 e2e 用（可提供 720p 档位）
}

let cache: Samples | null = null;

// 1 秒 320x240 样本，足够 probe/冒烟验证
export function ensureSamples(): Samples {
  if (cache) return cache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-player-test-'));
  const ff = getFfmpegPath();

  const gen = (file: string, videoArgs: string[], audioArgs: string[] | null, size = '320x240'): string => {
    const out = path.join(dir, file);
    const args = [
      '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc=duration=1:size=${size}:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'
    ];
    if (audioArgs === null) {
      args.push('-an');
    }
    args.push(...videoArgs, '-shortest', '-y', out);
    execFileSync(ff, args, { stdio: 'pipe' });
    return out;
  };

  cache = {
    dir,
    // H.264 8bit yuv420p + AAC → 应命中直通路径
    h264Aac: gen('h264_aac.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], []),
    // H.264 无音频 → 直通但 -an
    h264NoAudio: gen('h264_noaudio.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], null),
    // 10bit H.264 → 浏览器不可解，必须转码
    h264Hi10: gen('h264_hi10.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-profile:v', 'high10'], null),
    // HEVC Main10 → 软解 + 硬编（10bit 帧无法直接交给 H.264 硬件编码器）
    hevcHi10: gen('hevc_hi10.mp4', ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'ultrafast', '-x265-params', 'log-level=error'], null),
    // HEVC 8bit → 可硬解 + 硬编
    hevc8: gen('hevc8.mp4', ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-x265-params', 'log-level=error'], null),
    // 1080p H.264+AAC → 画质档 e2e（720p 严格低于源，可缩放）
    h264Aac1080: gen('h264_aac_1080.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], [], '1920x1080')
  };
  return cache;
}
