// test/volume-persist.test.ts — 音量/静音缓存（localStorage 依赖注入，node 环境可测）
import { describe, test, expect } from 'vitest';
import { loadVolumeCache, saveVolumeCache } from '../src/client/volume-persist';

/** 内存版 Storage 桩 */
function fakeStorage(): Storage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
    dump: () => Object.fromEntries(map)
  } as Storage & { dump(): Record<string, string> };
}

describe('音量/静音缓存', () => {
  test('保存后能原样读回', () => {
    const s = fakeStorage();
    saveVolumeCache(0.37, true, s);
    expect(loadVolumeCache(s)).toEqual({ volume: 0.37, muted: true });
    saveVolumeCache(1, false, s);
    expect(loadVolumeCache(s)).toEqual({ volume: 1, muted: false });
  });

  test('无缓存时返回 null 字段', () => {
    expect(loadVolumeCache(fakeStorage())).toEqual({ volume: null, muted: null });
  });

  test('JSON 损坏时不抛错，返回 null 字段', () => {
    const s = fakeStorage();
    s.setItem('fmp4-player:volume', '{not json');
    expect(loadVolumeCache(s)).toEqual({ volume: null, muted: null });
  });

  test('音量越界视为无效，返回 null（静音字段仍有效）', () => {
    const s = fakeStorage();
    s.setItem('fmp4-player:volume', JSON.stringify({ v: 1.5, m: true }));
    expect(loadVolumeCache(s)).toEqual({ volume: null, muted: true });
    s.setItem('fmp4-player:volume', JSON.stringify({ v: -0.1, m: false }));
    expect(loadVolumeCache(s)).toEqual({ volume: null, muted: false });
    s.setItem('fmp4-player:volume', JSON.stringify({ v: '0.5', m: false }));
    expect(loadVolumeCache(s)).toEqual({ volume: null, muted: false });
  });

  test('静音字段非布尔视为无效', () => {
    const s = fakeStorage();
    s.setItem('fmp4-player:volume', JSON.stringify({ v: 0.5, m: 'yes' }));
    expect(loadVolumeCache(s)).toEqual({ volume: 0.5, muted: null });
  });

  test('localStorage 抛异常时不抛错（隐私模式等）', () => {
    const throwing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); }
    } as unknown as Storage;
    expect(() => saveVolumeCache(0.5, false, throwing)).not.toThrow();
    expect(loadVolumeCache(throwing)).toEqual({ volume: null, muted: null });
  });

  test('未传 storage 且全局无 localStorage 时不抛错', () => {
    const globalAny = globalThis as { localStorage?: Storage };
    const saved = globalAny.localStorage;
    delete globalAny.localStorage;
    try {
      expect(() => saveVolumeCache(0.5, false)).not.toThrow();
      expect(loadVolumeCache()).toEqual({ volume: null, muted: null });
    } finally {
      if (saved) globalAny.localStorage = saved;
    }
  });
});
