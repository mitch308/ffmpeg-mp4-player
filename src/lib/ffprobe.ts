// src/lib/ffprobe.ts
import { spawn } from 'child_process';
import { getFfprobePath } from './ffmpeg-path';
import { normalizeLocalhostUrl } from './url';

export interface AudioInfo { codec: string; channels: number; sampleRate: number; }
export interface ProbeResult {
  duration: number; width: number; height: number;
  codec: string; pixFmt: string; profile: string; fps: number;
  audio: AudioInfo | null;
}

interface FfprobeStream {
  codec_type: string;
  codec_name?: string;
  pix_fmt?: string;
  profile?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: number;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: { duration: string };
}

export function probe(url: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const ffprobePath = getFfprobePath();
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      // localhost 在 Windows 上解析为 ::1，IPv4-only 服务会连接挂死，重写为 127.0.0.1
      normalizeLocalhostUrl(url)
    ];

    const proc = spawn(ffprobePath, args);
    let stdout = '';
    let stderr = '';

    const TIMEOUT_MS = 15000;
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('ffprobe timed out after 15s'));
    }, TIMEOUT_MS);
    timer.unref && timer.unref();

    proc.stdout!.on('data', (chunk) => { stdout += chunk; });
    proc.stderr!.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
      try {
        const data = JSON.parse(stdout) as FfprobeOutput;
        const videoStream = data.streams.find(s => s.codec_type === 'video');
        if (!videoStream) {
          return reject(new Error('No video stream found'));
        }
        const audioStream = data.streams.find(s => s.codec_type === 'audio');
        // 帧率：优先平均帧率（VFR 源更真实），回退基准帧率
        const fr = videoStream.avg_frame_rate && videoStream.avg_frame_rate !== '0/0'
          ? videoStream.avg_frame_rate : videoStream.r_frame_rate;
        const [num, den] = String(fr || '0/1').split('/').map(Number);
        const fps = num > 0 && den > 0 ? num / den : 0;
        resolve({
          duration: parseFloat(data.format.duration) || 0,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          codec: videoStream.codec_name || 'unknown',
          pixFmt: videoStream.pix_fmt || 'unknown',
          profile: videoStream.profile || 'unknown',
          fps: Math.round(fps * 100) / 100,
          audio: audioStream ? {
            codec: audioStream.codec_name || 'unknown',
            channels: audioStream.channels || 0,
            sampleRate: audioStream.sample_rate || 0
          } : null
        });
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${(err as Error).message}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
    });
  });
}
