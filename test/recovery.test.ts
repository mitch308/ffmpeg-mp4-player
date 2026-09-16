// test/recovery.test.ts — 流恢复退避节奏（纯函数）
import { describe, test, expect } from 'vitest';
import { recoveryDelayMs, RECOVERY_LIMIT, REBUILD_AFTER_FAILURES } from '../src/client/recovery';

describe('流恢复退避', () => {
  test('指数退避：1s/2s/4s，封顶 8s', () => {
    expect(recoveryDelayMs(1)).toBe(1000);
    expect(recoveryDelayMs(2)).toBe(2000);
    expect(recoveryDelayMs(3)).toBe(4000);
    expect(recoveryDelayMs(4)).toBe(8000);
    expect(recoveryDelayMs(10)).toBe(8000);
  });

  test('恢复窗口覆盖服务重启耗时（约 47s：1+2+4+8×5）', () => {
    let total = 0;
    for (let i = 1; i <= RECOVERY_LIMIT; i++) total += recoveryDelayMs(i);
    expect(total).toBeGreaterThanOrEqual(30000);
    expect(total).toBeLessThan(60000);
  });

  test('重建阈值小于恢复上限：先重连后重建', () => {
    expect(REBUILD_AFTER_FAILURES).toBeLessThan(RECOVERY_LIMIT);
  });
});
