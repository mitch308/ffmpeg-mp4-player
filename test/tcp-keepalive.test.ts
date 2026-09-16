// test/tcp-keepalive.test.ts — TCP keepalive 接线验证
// 内核级的半开连接死亡探测无法在同机测试中端到端复现（代理/同机内核会代替死亡方 ACK
// 探测包，见 test/pause-alive.test.ts 的半开用例），此处验证 keepalive 确实应用到了
// 服务端接受的每条连接（patch Socket.prototype.setKeepAlive 记录调用）。
import { describe, test, expect, afterEach, vi } from 'vitest';
import net from 'net';
import { applyTcpKeepAlive } from '../src/lib/tcp-keepalive';

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

test('applyTcpKeepAlive 为服务端接受的连接启用 keepalive（initialDelay 换算毫秒）', async () => {
  const calls: Array<[boolean, number]> = [];
  const original = net.Socket.prototype.setKeepAlive;
  restore = () => { net.Socket.prototype.setKeepAlive = original; };
  net.Socket.prototype.setKeepAlive = function (this: net.Socket, ...args: [boolean, number?]) {
    calls.push([args[0], args[1] ?? 0]);
    return original.apply(this, args);
  } as typeof net.Socket.prototype.setKeepAlive;

  const server = net.createServer(() => {});
  applyTcpKeepAlive(server, 30);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const client = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => client.once('connect', resolve));
  // 服务端连接事件与 setKeepAlive 调用均在事件循环内完成，稍作等待
  await new Promise((r) => setTimeout(r, 100));
  expect(calls).toContainEqual([true, 30000]);

  client.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('多个并发连接逐条应用', async () => {
  const calls: Array<[boolean, number]> = [];
  const original = net.Socket.prototype.setKeepAlive;
  restore = () => { net.Socket.prototype.setKeepAlive = original; };
  vi.spyOn(net.Socket.prototype, 'setKeepAlive').mockImplementation(function (this: net.Socket, enable, delay) {
    calls.push([enable ?? false, delay ?? 0]);
    return original.call(this, enable, delay);
  } as typeof net.Socket.prototype.setKeepAlive);

  const server = net.createServer(() => {});
  applyTcpKeepAlive(server, 5);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const clients = await Promise.all([0, 1].map(() => new Promise<net.Socket>((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => resolve(c));
  })));
  await new Promise((r) => setTimeout(r, 100));
  expect(calls.filter(([enable]) => enable).length).toBeGreaterThanOrEqual(2);

  for (const c of clients) c.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
