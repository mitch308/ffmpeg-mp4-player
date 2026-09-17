// src/client/volume-persist.ts — 音量/静音持久化（localStorage）。
// 存取均 try/catch：隐私模式/禁用 localStorage 时不抛错，等价于无缓存。
// storage 经参数注入（缺省 globalThis.localStorage），node 单测无需 DOM 环境。

const KEY = 'fmp4-player:volume';

export interface VolumeCache {
  volume: number | null;
  muted: boolean | null;
}

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  // 注意：读取 window.localStorage 属性本身也可能抛 SecurityError（跨域 iframe +
  // 禁第三方 Cookie / opaque origin），必须一并 try/catch，否则播放器启动崩溃
  try {
    const g = globalThis as { localStorage?: Storage };
    return g.localStorage ?? null;
  } catch {
    return null; // 存储被禁 → 等价无缓存，走默认值
  }
}

/** 读取缓存；无缓存或数据无效时对应字段为 null */
export function loadVolumeCache(storage?: Storage): VolumeCache {
  const s = resolveStorage(storage);
  if (!s) return { volume: null, muted: null };
  let raw: string | null = null;
  try {
    raw = s.getItem(KEY);
  } catch { return { volume: null, muted: null }; }
  if (!raw) return { volume: null, muted: null };
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; m?: unknown };
    return {
      volume: typeof parsed.v === 'number' && parsed.v >= 0 && parsed.v <= 1 ? parsed.v : null,
      muted: typeof parsed.m === 'boolean' ? parsed.m : null
    };
  } catch {
    return { volume: null, muted: null };
  }
}

/** 保存缓存（volume: 0~1 小数） */
export function saveVolumeCache(volume: number, muted: boolean, storage?: Storage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify({ v: volume, m: muted }));
  } catch { /* 隐私模式/配额满等：静默放弃 */ }
}
