// src/client/player-entry.ts — 播放器页装配入口（Task 11 完整实现，当前验证编译）
import { PlayerCore } from './player-core';
import './player.css';

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  app.textContent = '播放器加载中…';
  const url = new URLSearchParams(location.search).get('url');
  if (!url) return;
  const core = await PlayerCore.create(url);
  app.textContent = '';
  core.video.style.cssText = 'width:100%;height:100%';
  app.appendChild(core.video);
  core.start(0);
}

void main();
