// src/client/player-entry.ts — 播放器页装配：解析 URL 参数 → 创建会话 → 挂载 UI。
// URL 参数（详见 README）：
//   url      必需，视频地址（encodeURIComponent 后传入）
//   title    顶栏标题
//   ui       pc | tv（默认 pc）
//   quality  初始画质档 origin|720p|1080p|2k（默认 origin）
//   mode     解码模式 auto|hw|sw（默认 auto）
//   autoplay 1（默认）| 0；注意浏览器无手势策略可能拦截自动播放
import { PlayerCore, type ModeId, type PlayerCoreCallbacks, type QualityId } from './player-core';
import { mountPlayerUI } from './player-ui';
import './player.css';

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
  const quality = parseParam<QualityId>(params.get('quality'), ['origin', '720p', '1080p', '2k']) ?? 'origin';
  const mode = parseParam<ModeId>(params.get('mode'), ['auto', 'hw', 'sw']) ?? 'auto';

  app.textContent = '正在加载…';
  const spinner = document.createElement('span');
  spinner.className = 'loader';
  app.appendChild(spinner);

  // 回调容器：create 先挂空壳，mountPlayerUI 后由 UI 层接管渲染
  const callbacks: PlayerCoreCallbacks = {};
  let core: PlayerCore;
  try {
    core = await PlayerCore.create(url, { quality, mode }, callbacks);
  } catch (e) {
    spinner.classList.add('hidden');
    app.textContent = '加载失败: ' + (e as Error).message;
    return;
  }
  spinner.classList.add('hidden');

  mountPlayerUI({ root: app, core, callbacks, title, ui });
  core.start(0, autoplay);
}

function parseParam<T extends string>(v: string | null, allowed: readonly T[]): T | null {
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

void main();
