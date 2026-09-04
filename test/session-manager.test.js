// test/session-manager.test.js — 策略降级链（注入假 ffmpeg 工厂）
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
  createSession, startStream, destroySession, getSession, currentStrategy
} = require('../lib/session-manager');
const { ensureSamples } = require('./helpers/samples');

// 假进程工厂：script 数组按次序决定每次创建的进程行为
//  { fail: true } 启动即退出码 1；{ data: n } 先吐 n 字节再由外部控制退出
function fakeFactory(scripts, calls) {
  let n = 0;
  return function createProc({ strategy, onData, onError, onExit }) {
    const step = scripts[Math.min(n, scripts.length - 1)];
    const callIndex = n++;
    calls.push(strategy.label);
    const handle = {
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

beforeEach(() => {
  // 依赖真实 probe（样本已缓存，速度可接受）；caps 用真实探测结果（QSV 或 libx264 均可）
});

test('copy 失败且未吐数据 → 自动降级到下一策略并成功', async () => {
  const s = ensureSamples();
  const session = await createSession(s.h264Aac);   // h264+420p → [copy, hw/sw]
  assert.strictEqual(session.chain[0].label, 'copy');

  const calls = [];
  const dataChunks = [];
  let errors = [];
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
  const calls = [];
  let errors = [];
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
  const calls = [];
  let errors = [];
  let dataTotal = 0;

  // 脚本：第一次先吐数据（但工厂接口里 data 后立即 exit 0，这里用自定义工厂）
  let n = 0;
  const factory = ({ strategy, onData, onError }) => {
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
  const calls = [];
  let errors = [];
  const factory = fakeFactory([{ fail: true }], calls);
  startStream(session, 0, () => {}, (e) => errors.push(e), () => {}, { createProc: factory });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(calls, [session.chain[0].label]);
  assert.strictEqual(errors.length, 1);
  destroySession(session.id);
});
