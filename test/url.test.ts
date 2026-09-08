// test/url.test.ts — localhost 重写为 127.0.0.1（Windows 双栈解析不匹配会导致 ffmpeg 挂死）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeLocalhostUrl } from '../src/lib/url';

test('http URL 的 localhost 主机重写为 127.0.0.1', () => {
  assert.strictEqual(
    normalizeLocalhostUrl('http://localhost:8082/video.m2ts'),
    'http://127.0.0.1:8082/video.m2ts'
  );
});

test('https URL 同样重写', () => {
  assert.strictEqual(
    normalizeLocalhostUrl('https://localhost/video.mp4'),
    'https://127.0.0.1/video.mp4'
  );
});

test('保留路径与查询参数', () => {
  assert.strictEqual(
    normalizeLocalhostUrl('http://localhost:8082/4K%20HDR%E6%B5%8B%E8%AF%95/盘.m2ts?start=30'),
    'http://127.0.0.1:8082/4K%20HDR%E6%B5%8B%E8%AF%95/盘.m2ts?start=30'
  );
});

test('127.0.0.1 与其他主机名原样返回', () => {
  assert.strictEqual(
    normalizeLocalhostUrl('http://127.0.0.1:8082/v.m2ts'),
    'http://127.0.0.1:8082/v.m2ts'
  );
  assert.strictEqual(
    normalizeLocalhostUrl('http://example.com/v.m2ts'),
    'http://example.com/v.m2ts'
  );
});

test('非 http(s) 协议（本地路径、file、rtsp 等）原样返回', () => {
  assert.strictEqual(normalizeLocalhostUrl('D:\\movies\\video.mp4'), 'D:\\movies\\video.mp4');
  assert.strictEqual(normalizeLocalhostUrl('file:///tmp/v.mp4'), 'file:///tmp/v.mp4');
  assert.strictEqual(normalizeLocalhostUrl('rtsp://localhost:554/stream'), 'rtsp://localhost:554/stream');
});

test('URL 对象返回 null 时不抛错', () => {
  assert.strictEqual(normalizeLocalhostUrl('not a url'), 'not a url');
});

test('buildArgs 内的 URL 已被重写（集成点）', async () => {
  const { buildArgs } = await import('../src/lib/ffmpeg-process');
  const { strategyChain } = await import('../src/lib/stream-strategy');
  const { getCaps } = await import('../src/lib/hw-accel');
  const caps = await getCaps();
  const probeResult = {
    duration: 1, width: 320, height: 240, codec: 'hevc', pixFmt: 'yuv420p10le',
    profile: 'Main 10', fps: 30, audio: null
  };
  const strat = strategyChain(probeResult, caps)[0];
  const args = buildArgs('http://localhost:8082/v.m2ts', 0, strat);
  const iIdx = args.indexOf('-i');
  assert.notStrictEqual(iIdx, -1);
  assert.strictEqual(args[iIdx + 1], 'http://127.0.0.1:8082/v.m2ts');
});
