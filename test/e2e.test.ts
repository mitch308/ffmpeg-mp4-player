// test/e2e.test.ts — 端到端：真实 ffmpeg + HTTP 流 + ffprobe 校验产物（本进程 startServer）
import { test, beforeAll, afterAll, expect } from 'vitest';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { startServer } from '../src/index';
import { ensureSamples } from './helpers/samples';
import { getFfprobePath } from '../src/lib/ffmpeg-path';
import type { PlayerServer } from '../src/config';

let server: PlayerServer;
let BASE = '';

beforeAll(async () => {
  server = await startServer({ port: 0 });
  BASE = server.url;
});

afterAll(async () => {
  if (server) await server.stop();
});

function ffprobeJson(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(getFfprobePath(), ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

async function createSession(url: string): Promise<any> {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (r.status !== 200) {
    throw new Error(`create session failed: HTTP ${r.status} ${await r.text()}`);
  }
  return r.json();
}

async function fetchStream(id: string, start: number): Promise<Buffer> {
  const r = await fetch(`${BASE}/api/sessions/${id}/stream?start=${start || 0}`);
  expect(r.status).toBe(200);
  return Buffer.from(await r.arrayBuffer());
}

test('H.264 8bit + AAC 源 → 直通，产物含 h264 视频 + aac 音频', async () => {
  const s = ensureSamples();
  const info = await createSession(s.h264Aac);
  expect(info.streamMode).toBe('copy');
  expect(info.audioCodec).toBe('aac');
  expect(info.hw).toBe(false);

  const data = await fetchStream(info.sessionId, 0);
  expect(data.length).toBeGreaterThan(1000);
  expect([...data.slice(4, 8)]).toEqual([...Buffer.from('ftyp')]);

  const tmp = path.join(os.tmpdir(), 'e2e-copy.mp4');
  fs.writeFileSync(tmp, data);
  const j = await ffprobeJson(tmp);
  const v = j.streams.find((x: any) => x.codec_type === 'video');
  const a = j.streams.find((x: any) => x.codec_type === 'audio');
  expect(v.codec_name).toBe('h264');
  expect(v.pix_fmt).toBe('yuv420p');
  expect(a && a.codec_name === 'aac').toBeTruthy();
});

test('H.264 无音频源 → 直通，产物无音频轨', async () => {
  const s = ensureSamples();
  const info = await createSession(s.h264NoAudio);
  expect(info.streamMode).toBe('copy');
  expect(info.audioCodec).toBe(null);

  const data = await fetchStream(info.sessionId, 0.5); // 带 seek 起点
  const tmp = path.join(os.tmpdir(), 'e2e-copy-noaudio.mp4');
  fs.writeFileSync(tmp, data);
  const j = await ffprobeJson(tmp);
  const v = j.streams.find((x: any) => x.codec_type === 'video');
  expect(v.codec_name).toBe('h264');
  expect(j.streams.find((x: any) => x.codec_type === 'audio')).toBeUndefined();
});

test('H.264 Hi10 源 → 转码（软解硬编），产物为 8bit yuv420p', async () => {
  const s = ensureSamples();
  const info = await createSession(s.h264Hi10);
  expect(info.streamMode === 'hw' || info.streamMode === 'sw').toBe(true);
  expect(info.encoder).toBeTruthy();

  const data = await fetchStream(info.sessionId, 0);
  expect(data.length).toBeGreaterThan(1000);
  const tmp = path.join(os.tmpdir(), 'e2e-hi10.mp4');
  fs.writeFileSync(tmp, data);
  const j = await ffprobeJson(tmp);
  const v = j.streams.find((x: any) => x.codec_type === 'video');
  expect(v.codec_name).toBe('h264');
  expect(v.pix_fmt).toBe('yuv420p'); // 产物应为浏览器可解的 8bit
});

test('不存在的源 → 会话创建失败并返回 500', async () => {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'Z:/definitely/not/exist.mp4' })
  });
  expect(r.status).toBe(500);
});

test('/api/status 报告硬件能力', async () => {
  const r = await fetch(`${BASE}/api/status`);
  const j: any = await r.json();
  expect(j.hw && j.hw.encoder).toBeTruthy();
  expect(['gpu', 'hybrid', 'sw']).toContain(j.hw.mode);
  console.log('E2E 硬件信息:', JSON.stringify(j.hw));
});
