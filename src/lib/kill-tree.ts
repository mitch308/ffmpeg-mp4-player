// src/lib/kill-tree.ts — 跨平台杀进程树
import { spawn } from 'child_process';

/**
 * 杀掉以 pid 为根的整棵进程树。
 * Windows：taskkill /T /F（直接 proc.kill() 会留孤儿进程，见踩坑记录）；
 * POSIX：fork 需以 detached:true 启动使其成为进程组长，然后 kill(-pid) 杀全组。
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      try {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        tk.on('error', () => resolve()); // 进程可能已退出
        tk.on('close', () => resolve());
      } catch {
        resolve();
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
      }
      resolve();
    }
  });
}
