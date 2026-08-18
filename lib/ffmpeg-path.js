// lib/ffmpeg-path.js
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.join(__dirname, '..');

function getPlatformPath() {
  const platform = os.platform();
  const arch = os.arch();
  const archMap = { x64: 'x64', ia32: 'ia32', arm64: 'arm64' };
  const platMap = { win32: 'win', darwin: 'mac', linux: 'linux' };

  const archDir = archMap[arch] || 'x64';
  const platDir = platMap[platform] || 'linux';

  return { platDir, archDir };
}

function getFfmpegPath() {
  const { platDir, archDir } = getPlatformPath();
  const ext = os.platform() === 'win32' ? '.exe' : '';
  return path.join(PROJECT_ROOT, 'ffmpeg', platDir, archDir, `ffmpeg${ext}`);
}

function getFfprobePath() {
  const { platDir, archDir } = getPlatformPath();
  const ext = os.platform() === 'win32' ? '.exe' : '';
  return path.join(PROJECT_ROOT, 'ffprobe', platDir, archDir, `ffprobe${ext}`);
}

module.exports = { getFfmpegPath, getFfprobePath };
