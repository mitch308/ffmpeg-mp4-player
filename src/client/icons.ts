// src/client/icons.ts — 图标注入：以 ?raw 内联 SVG 文本（保留 currentColor，
// 注入后随容器 color 变色；避免 <img> 引用导致图标恒黑）
import play from './icons/play.svg?raw';
import pause from './icons/pause.svg?raw';
import volumeMute from './icons/volume-mute.svg?raw';
import volumeUnmute from './icons/volume-unmute.svg?raw';
import cog from './icons/cog.svg?raw';
import arrowDown from './icons/arrow-down.svg?raw';
import fullscreen from './icons/fullscreen.svg?raw';
import fullscreenExit from './icons/fullscreen-exit.svg?raw';

export type IconName =
  | 'play' | 'pause' | 'volume-mute' | 'volume-unmute'
  | 'cog' | 'arrow-down' | 'fullscreen' | 'fullscreen-exit';

const ICONS: Record<IconName, string> = {
  play, pause,
  'volume-mute': volumeMute, 'volume-unmute': volumeUnmute,
  cog, 'arrow-down': arrowDown,
  fullscreen, 'fullscreen-exit': fullscreenExit
};

/** 将图标 SVG 注入元素（覆盖 innerHTML） */
export function injectIcon(el: HTMLElement | null, name: IconName): void {
  if (el) el.innerHTML = ICONS[name];
}
