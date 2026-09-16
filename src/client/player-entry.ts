// src/client/player-entry.ts — 播放器页装配：解析 URL 参数 → 创建会话 → 挂载 UI。
// URL 参数（详见 README）：
//   url      必需，视频地址（encodeURIComponent 后传入）
//   title    顶栏标题
//   ui       pc | tv（默认 pc）
//   quality  初始画质档 origin|720p|1080p|2k（默认 origin）
//   mode     解码模式 auto|hw|sw（默认 auto）
//   autoplay 1（默认）| 0；注意浏览器无手势策略可能拦截自动播放
//   volume   初始音量：0~1（小数）或 1~100（百分数），默认 1
//   mute     1 静音起播（默认 0）
//   highwater 读泵高水位（秒，默认取服务端配置或 45）
//   lowwater  读泵低水位（秒，默认取服务端配置或 15）
import { PlayerCore, type ModeId, type PlayerCoreCallbacks, type QualityId } from './player-core';
import { mountPlayerUI } from './player-ui';
import { clientLog } from './logger';
import './player.css';

const DEFAULT_HIGH_WATER = 45;
const DEFAULT_LOW_WATER = 15;

async function loadWaterConfig(): Promise<{ readHighWaterSec: number; readLowWaterSec: number }> {
  // 服务端 /api/player-config 下发（startServer 的 readHighWaterSec/readLowWaterSec），
  // 拉取失败回退内置默认值
  try {
    const resp = await fetch('/api/player-config');
    if (resp.ok) {
      const cfg = (await resp.json()) as Partial<{ readHighWaterSec: number; readLowWaterSec: number }>;
      return {
        readHighWaterSec: typeof cfg.readHighWaterSec === 'number' ? cfg.readHighWaterSec : DEFAULT_HIGH_WATER,
        readLowWaterSec: typeof cfg.readLowWaterSec === 'number' ? cfg.readLowWaterSec : DEFAULT_LOW_WATER
      };
    }
  } catch { /* 回退默认值 */ }
  return { readHighWaterSec: DEFAULT_HIGH_WATER, readLowWaterSec: DEFAULT_LOW_WATER };
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  if (!url) {
    app.textContent = '缺少 url 参数，请使用 /player.html?url=<encoded> 访问';
    return;
  }
  const ui = params.get('ui') === 'tv' ? 'tv' : 'pc';
  const title = params.get('title') ?? '';
  const autoplay = params.get('autoplay') !== '0';
  const volume = parseVolume(params.get('volume'));
  const mute = params.get('mute') === '1';
  const quality = parseParam<QualityId>(params.get('quality'), ['origin', '720p', '1080p', '2k']) ?? 'origin';
  const mode = parseParam<ModeId>(params.get('mode'), ['auto', 'hw', 'sw']) ?? 'auto';

  app.textContent = '正在加载…';
  const spinner = document.createElement('span');
  spinner.className = 'loader';
  app.appendChild(spinner);

  // 读泵水位线：服务端配置为基础，URL 参数逐页覆盖；非法组合回退默认
  const water = await loadWaterConfig();
  const hiParam = parsePositiveNumber(params.get('highwater'));
  const loParam = parsePositiveNumber(params.get('lowwater'));
  const highWater = hiParam ?? water.readHighWaterSec;
  const lowWater = loParam ?? water.readLowWaterSec;
  const waterValid = highWater > 0 && lowWater > 0 && lowWater < highWater;

  // 回调容器：create 先挂空壳，mountPlayerUI 后由 UI 层接管渲染
  const callbacks: PlayerCoreCallbacks = {};
  let core: PlayerCore;
  try {
    core = await PlayerCore.create(
      url,
      {
        quality,
        mode,
        readHighWaterSec: waterValid ? highWater : DEFAULT_HIGH_WATER,
        readLowWaterSec: waterValid ? lowWater : DEFAULT_LOW_WATER
      },
      callbacks
    );
  } catch (e) {
    clientLog.error('player', `会话创建失败: ${(e as Error).message}`);
    spinner.classList.add('hidden');
    app.textContent = '加载失败: ' + (e as Error).message;
    return;
  }
  spinner.classList.add('hidden');

  // 初始音量/静音：在 mountPlayerUI 之前设置，让首次 renderVolume 即反映正确状态
  if (volume !== null) {
    core.video.volume = volume;
    core.video.muted = volume === 0;
  }
  if (mute) core.video.muted = true;

  mountPlayerUI({ root: app, core, callbacks, title, ui });
  core.start(0, autoplay);
}

function parseVolume(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  // ≤1 按小数音量（0~1），>1 按百分数（1~100）
  return n <= 1 ? Math.min(n, 1) : Math.min(n, 100) / 100;
}

function parseParam<T extends string>(v: string | null, allowed: readonly T[]): T | null {
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function parsePositiveNumber(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

void main();
