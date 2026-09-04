// test/e2e.test.js — 端到端：真实 server + 真实 ffmpeg + HTTP + ffprobe 校验产物
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ensureSamples } = require('./helpers/samples');
const { getFfprobePath } = require('../lib/ffmpeg-path');

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const onData = (c) => { out += c; };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    const timer = setTimeout(() => reject(new Error('server start timeout: ' + out)), 15000);
    server.on('error', reject);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/status`);
        if (r.ok) { clearInterval(poll); clearTimeout(timer); resolve(); }
      } catch (e) { /* 未就绪 */ }
    }, 200);
  });
}

function ffprobeJson(file) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(getFfprobePath(), ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file],
      (err, stdout) => err ? reject(err) : resolve(JSON.parse(stdout)));
  });
}

async function createSession(url) {
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

async function fetchStream(id, start) {
  const r = await fetch(`${BASE}/api/sessions/${id}/stream?start=${start || 0}`);
  assert.strictEqual(r.status, 200);
  return Buffer.from(await r.arrayBuffer());
}

test.before(() => startServer());
test.after(() => { try { server && server.kill(); } catch (e) {} });

test('H.264 8bit + AAC 源 → 直通，产物含 h264 视频 + aac 音频', async () => {
  const s = ensureSamples();
  const info = await createSession(s.h264Aac);
  assert.strictEqual(info.streamMode, 'copy');
  assert.strictEqual(info.audioCodec, 'aac');
  assert.strictEqual(info.hw, false);

  const data = await fetchStream(info.sessionId, 0);
  assert.ok(data.length > 1000, `产物过小: ${data.length}`);
  assert.deepStrictEqual([...data.slice(4, 8)], [...Buffer.from('ftyp')], '应为 fMP4');

  const tmp = path.join(os.tmpdir(), 'e2e-copy.mp4');
  fs.writeFileSync(tmp, data);
  const j = await ffprobeJson(tmp);
  const v = j.streams.find(x => x.codec_type === 'video');
  const a = j.streams.find(x => x.codec_type === 'audio');
  assert.strictEqual(v.codec_name, 'h264');
  assert.strictEqual(v.pix_fmt, 'yuv420p');
  assert.ok(a && a.codec_name === 'aac', '应含 AAC 音频');
});

test('H.264 无音频源 → 直通，产物无音频轨', async () => {
  const s = ensureSamples();
  const info = await createSession(s.h264NoAudio);
  assert.strictEqual(info.streamMode, 'copy');
  assert.strictEqual(info.audioCodec, null);

  const data = await fetchStream(info.sessionId, 0.5); // 带 seek 起点
  const tmp = path.join(os.tmpdir(), 'e2e-copy-noaudio.mp4');
  fs.writeFileSync(tmp, data);
  const j = await ffprobeJson(tmp);
  const v = j.streams.find(x => x.codec_type === 'video');
  assert.strictEqual(v.codec_name, 'h264');
  assert.strictEqual(j.streams.find(x => x.codec_type === 'audio'), undefined);
});

test('H.264 Hi10 源 → 转码（软解硬编），产物为 8bit yuv420p', async () => {
  const s = ensureSamples();
  const info = await createSession(s.h264Hi10);
  assert.strictEqual(info.streamMode === 'hw' || info.streamMode === 'sw', true);
  assert.ok(info.encoder, '应报告编码器');

  const data = await fetchStream(info.sessionId, 0);
  assert.ok(data.length > 1000);
  const tmp = path.join(os.tmpdir(), 'e2e-hi10.mp4');
  fs.writeFileSync(tmp, data);
  const j = await ffprobeJson(tmp);
  const v = j.streams.find(x => x.codec_type === 'video');
  assert.strictEqual(v.codec_name, 'h264');
  assert.strictEqual(v.pix_fmt, 'yuv420p', '产物应为浏览器可解的 8bit');
});

test('不存在的源 → 会话创建失败并返回 500', async () => {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'Z:/definitely/not/exist.mp4' })
  });
  assert.strictEqual(r.status, 500);
});

test('/api/status 报告硬件能力', async () => {
  const r = await fetch(`${BASE}/api/status`);
  const j = await r.json();
  assert.ok(j.hw && j.hw.encoder, JSON.stringify(j));
  assert.ok(['gpu', 'hybrid', 'sw'].includes(j.hw.mode));
  console.log('E2E 硬件信息:', JSON.stringify(j.hw));
});
