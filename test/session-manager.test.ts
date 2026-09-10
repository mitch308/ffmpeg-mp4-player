// test/session-manager.test.ts — 策略降级链（注入假 ffmpeg 工厂）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createSession, startStream, destroySession, getSession, currentStrategy
} from '../src/lib/session-manager';
import { ensureSamples } from './helpers/samples';
import type { createFfmpegProcess } from '../src/lib/ffmpeg-process';
import type { Strategy } from '../src/lib/stream-strategy';

type ProcHandle = { pid: number; kill(): void };
type CreateProc = typeof createFfmpegProcess;

// 假进程工厂：script 数组按次序决定每次创建的进程行为
//  { fail: true } 启动即退出码 1；{ data: n } 先吐 n 字节再由外部控制退出
function fakeFactory(scripts: Array<{ fail?: boolean; data?: number }>, calls: string[]): CreateProc {
  let n = 0;
  return function createProc({ strategy, onData, onError, onExit }: {
    strategy: Strategy; onData: (chunk: Buffer) => void; onError: (err: Error) => void; onExit: (code: number | null) => void;
  }): ProcHandle {
    const step = scripts[Math.min(n, scripts.length - 1)];
    const callIndex = n++;
    calls.push(strategy.label);
    const handle: ProcHandle = {
      pid: 1000 + callIndex,
      kill() { /* no-op */ }
    };
    setImmediate(() => {
      if (step.fail) {
        onError(new Error('fake ffmpeg error'));
        onExit(1);
      } else if (step.data) {
        onData(Buffer.alloc(step.data));
        onExit(0);
      } else {
        onExit(0);
      }
    });
    return handle;
  };
}

test('copy 失败且未吐数据 → 自动降级到下一策略并成功', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Aac);   // h264+420p → [copy, hw/sw]
  assert.strictEqual(session.chain[0].label, 'copy');

  const calls: string[] = [];
  const dataChunks: number[] = [];
  let errors: Error[] = [];
  let exits = 0;
  const factory = fakeFactory([{ fail: true }, { data: 10 }], calls);

  const proc = startStream(
    session, 0,
    (c) => dataChunks.push(c.length),
    (e) => errors.push(e),
    () => exits++,
    { createProc: factory }
  );

  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.deepStrictEqual(calls, ['copy', session.chain[1].label]);
  assert.strictEqual(errors.length, 0, '降级成功则不应向调用方报错');
  assert.deepStrictEqual(dataChunks, [10]);
  assert.strictEqual(exits, 1, '旧进程的退出不应传递给调用方');
  assert.strictEqual(currentStrategy(session).label, session.chain[1].label);
  destroySession(session.id);
});

test('所有策略都失败 → 向调用方报一次错', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Aac);
  const calls: string[] = [];
  let errors: Error[] = [];
  let exits = 0;
  const factory = fakeFactory([{ fail: true }, { fail: true }], calls);

  startStream(session, 0, () => {}, (e) => errors.push(e), () => exits++, { createProc: factory });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /fake ffmpeg error/);
  destroySession(session.id);
});

test('已吐数据后失败 → 不降级（避免污染响应流），直接报错', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Aac);
  const calls: string[] = [];
  let errors: Error[] = [];
  let dataTotal = 0;

  // 脚本：第一次先吐数据（但工厂接口里 data 后立即 exit 0，这里用自定义工厂）
  let n = 0;
  const factory: CreateProc = ({ strategy, onData, onError }) => {
    calls.push(strategy.label);
    const i = n++;
    setImmediate(() => {
      if (i === 0) {
        onData(Buffer.alloc(64));
        onError(new Error('mid-stream failure'));
      } else {
        onError(new Error('should not restart'));
      }
    });
    return { pid: 1, kill() {} };
  };

  startStream(session, 0, (c) => { dataTotal += c.length; }, (e) => errors.push(e), () => {}, { createProc: factory });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.deepStrictEqual(calls, ['copy'], '不应有第二次尝试');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(dataTotal, 64);
  destroySession(session.id);
});

test('不可直通源只有单一策略，失败直接报错', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Hi10);  // 10bit → 无 copy
  assert.strictEqual(session.chain.length, 1);
  const calls: string[] = [];
  let errors: Error[] = [];
  const factory = fakeFactory([{ fail: true }], calls);
  startStream(session, 0, () => {}, (e) => errors.push(e), () => {}, { createProc: factory });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(calls, [session.chain[0].label]);
  assert.strictEqual(errors.length, 1);
  destroySession(session.id);
});

// ===== 画质档/解码模式：会话参数与策略链重算 =====

test('createSession 携带 quality/mode：链按参数计算', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Aac, { quality: '720p', mode: 'sw' });
  assert.strictEqual(session.requestedQuality, '720p');
  assert.strictEqual(session.requestedMode, 'sw');
  assert.strictEqual(session.chain.length, 1, '显式参数跳过直通');
  assert.strictEqual(session.chain[0].encoder, 'libx264');
  destroySession(session.id);
});

test('startStream 显式参数与当前设置不同 → 重算链并重置降级进度', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Hi10, { mode: 'hw' }); // 单策略转码（硬编优先）

  const calls: string[] = [];
  const factory = fakeFactory([{ data: 10 }], calls);
  startStream(session, 0, () => {}, () => {}, () => {}, { createProc: factory, mode: 'sw' });

  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(session.requestedMode, 'sw');
  assert.strictEqual(session.chain[0].encoder, 'libx264', '链已按新参数重算');
  assert.deepStrictEqual(calls, ['sw']);
  destroySession(session.id);
});

test('startStream 不带参数 → 沿用会话当前设置', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Aac); // [copy, 转码]
  const calls: string[] = [];
  const factory = fakeFactory([{ data: 10 }], calls);
  startStream(session, 0, () => {}, () => {}, () => {}, { createProc: factory });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(session.chainIndex, 0);
  destroySession(session.id);
});
