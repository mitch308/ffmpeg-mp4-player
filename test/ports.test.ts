// test/ports.test.ts — 空闲端口探测与随机选取
import { describe, test, expect } from 'vitest';
import net from 'net';
import { isPortFree, pickFreePort, PORT_RANGE_START, PORT_RANGE_END } from '../src/lib/ports';

describe('端口选取', () => {
  test('空闲端口返回 true，被占端口返回 false', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    );
    // server 未关闭时该端口被占用
    expect(await isPortFree(port, '127.0.0.1')).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await isPortFree(port, '127.0.0.1')).toBe(true);
  });

  test('pickFreePort 返回值落在 20000–30000 且确实空闲', async () => {
    const port = await pickFreePort('127.0.0.1');
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(port).toBeLessThanOrEqual(PORT_RANGE_END);
    expect(await isPortFree(port, '127.0.0.1')).toBe(true);
  });
});
