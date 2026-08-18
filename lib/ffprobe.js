// lib/ffprobe.js
const { spawn } = require('child_process');
const { getFfprobePath } = require('./ffmpeg-path');

function probe(url) {
  return new Promise((resolve, reject) => {
    const ffprobePath = getFfprobePath();
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      url
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

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
      try {
        const data = JSON.parse(stdout);
        const videoStream = data.streams.find(s => s.codec_type === 'video');
        if (!videoStream) {
          return reject(new Error('No video stream found'));
        }
        resolve({
          duration: parseFloat(data.format.duration) || 0,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          codec: videoStream.codec_name || 'unknown'
        });
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
    });
  });
}

module.exports = { probe };
