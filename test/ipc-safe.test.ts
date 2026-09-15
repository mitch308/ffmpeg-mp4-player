// test/ipc-safe.test.ts — 子进程 IPC 安全发送：不可序列化消息降级、通道异常不抛出
import { describe, test, expect, vi } from 'vitest';
import { createSafeIpcSender } from '../src/lib/ipc-safe';

describe('IPC 安全发送', () => {
  test('可序列化消息原样发送', () => {
    const send = vi.fn();
    const sender = createSafeIpcSender(() => true, send);
    sender({ type: 'log', level: 'info', message: '正常消息' });
    expect(send).toHaveBeenCalledWith({ type: 'log', level: 'info', message: '正常消息' });
  });

  test('通道未连接时静默丢弃，不调用 send', () => {
    const send = vi.fn();
    const sender = createSafeIpcSender(() => false, send);
    expect(() => sender({ type: 'log', level: 'info', message: 'x' })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  test('不可序列化消息（循环引用）降级为 warn 日志，不抛错', () => {
    const send = vi.fn();
    const sender = createSafeIpcSender(() => true, send);
    const payload: Record<string, unknown> = { type: 'log', level: 'info' };
    payload.self = payload; // 循环引用：JSON.stringify 抛 TypeError
    expect(() => sender(payload)).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    const fallback = send.mock.calls[0][0] as { type: string; level: string; message: string };
    expect(fallback.type).toBe('log');
    expect(fallback.level).toBe('warn');
    expect(fallback.message).toContain('IPC 消息不可序列化');
    // 降级消息自身必须可序列化，否则会二次抛错
    expect(() => JSON.stringify(fallback)).not.toThrow();
  });

  test('不可序列化消息（BigInt 值）降级，降级内容经 inspect 截断', () => {
    const send = vi.fn();
    const sender = createSafeIpcSender(() => true, send);
    sender({ n: 1n }); // BigInt：JSON.stringify 抛 TypeError（函数值只会被 JSON 静默丢弃，不抛错）
    const fallback = send.mock.calls[0][0] as { message: string };
    expect(fallback.message).toContain('IPC 消息不可序列化');
    expect(fallback.message).toContain('1n');
    expect(fallback.message.length).toBeLessThanOrEqual(500 + '[child] IPC 消息不可序列化，已降级: '.length);
  });

  test('send 抛错（通道中断竞态）时不向外抛出', () => {
    const send = vi.fn(() => { throw new Error('channel closed'); });
    const sender = createSafeIpcSender(() => true, send);
    expect(() => sender({ type: 'log', level: 'info', message: 'x' })).not.toThrow();
  });
});
