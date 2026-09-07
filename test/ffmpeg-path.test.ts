// test/ffmpeg-path.test.ts — 路径解析链三级优先级
import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveBinaryPath,
  configureBinaries,
  getFfmpegPath,
  getFfprobePath
} from '../src/lib/ffmpeg-path';

let tmp = '';
function makeExe(name: string): string {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'ffmpeg-path-test-'));
  const p = join(tmp, name);
  writeFileSync(p, '#!/bin/sh\n');
  try { chmodSync(p, 0o755); } catch { /* Windows 无 chmod */ }
  return p;
}

afterEach(() => {
  configureBinaries({});
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = ''; }
});

describe('二进制路径解析链', () => {
  test('显式配置 > 环境变量 > static 包', () => {
    const a = makeExe('a.exe'), b = makeExe('b.exe'), c = makeExe('c.exe');
    expect(resolveBinaryPath({ kind: 'ffmpeg', explicit: a, env: b, staticPath: c })).toBe(a);
    expect(resolveBinaryPath({ kind: 'ffmpeg', explicit: null, env: b, staticPath: c })).toBe(b);
    expect(resolveBinaryPath({ kind: 'ffmpeg', explicit: null, env: null, staticPath: c })).toBe(c);
  });

  test('路径不存在时跳到下一级', () => {
    const b = makeExe('fallback.exe');
    expect(resolveBinaryPath({ kind: 'ffmpeg', explicit: join(tmp, '不存在'), env: b })).toBe(b);
  });

  test('全部落空抛错且错误信息含来源与 README 指引', () => {
    expect(() => resolveBinaryPath({ kind: 'ffprobe', explicit: join(tmp, '无') }))
      .toThrow(/FFMPEG_PATH|ffprobe-static|README/);
  });

  test('devDeps 已装 ffmpeg-static/ffprobe-static：默认解析应命中', () => {
    expect(getFfmpegPath()).toBeTruthy();
    expect(getFfprobePath()).toBeTruthy();
  });

  test('configureBinaries 注入后 getFfmpegPath 返回注入值', () => {
    const p = makeExe('my-ffmpeg.exe');
    configureBinaries({ ffmpegPath: p });
    expect(getFfmpegPath()).toBe(p);
  });
});
