// test/logger.test.ts — 统一日志模块：格式、级别、自定义日志函数
import { describe, test, expect, vi, afterEach } from 'vitest';
import { log, configureLogger, type LogFn } from '../src/lib/logger';

afterEach(() => {
  // 每个用例后复位为默认 console，避免污染其他测试
  configureLogger();
});

describe('统一日志', () => {
  test('默认输出到 console（info→log，warn→warn，error→error）', () => {
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.info('session:abc', '开始播放');
    log.warn('hw-accel', '探测失败');
    log.error('session:abc', '流错误');
    expect(spyLog).toHaveBeenCalledWith('[fmp4][session:abc] 开始播放');
    expect(spyWarn).toHaveBeenCalledWith('[fmp4][hw-accel] 探测失败');
    expect(spyError).toHaveBeenCalledWith('[fmp4][session:abc] 流错误');
    spyLog.mockRestore();
    spyWarn.mockRestore();
    spyError.mockRestore();
  });

  test('自定义日志函数接收 level 与格式化后的完整消息', () => {
    const received: Array<{ level: string; message: string }> = [];
    const fn: LogFn = (level, message) => received.push({ level, message });
    configureLogger(fn);
    log.info('ffmpeg pid=42 session:abc', 'started');
    log.error('client', '播放错误');
    expect(received).toEqual([
      { level: 'info', message: '[fmp4][ffmpeg pid=42 session:abc] started' },
      { level: 'error', message: '[fmp4][client] 播放错误' }
    ]);
  });

  test('configureLogger() 无参调用复位为默认 console 输出', () => {
    const fn: LogFn = () => {};
    configureLogger(fn);
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    configureLogger();
    log.info('server', '运行中');
    expect(spyLog).toHaveBeenCalledWith('[fmp4][server] 运行中');
    spyLog.mockRestore();
  });
});
