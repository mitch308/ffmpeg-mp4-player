// src/lib/ports.ts — 空闲端口探测与随机选取
// 选 20000–30000：避开特权端口、常见服务端口与开发常用端口（3000/8080 等），
// 降低与宿主环境其他服务冲突的概率
import net from 'net';

export const PORT_RANGE_START = 20000;
export const PORT_RANGE_END = 30000;

export function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** 在不常用区间随机挑一个空闲端口；探测与真正 listen 之间存在竞态，由调用方重试兜底 */
export async function pickFreePort(host: string): Promise<number> {
  const span = PORT_RANGE_END - PORT_RANGE_START + 1;
  for (let i = 0; i < 20; i++) {
    const port = PORT_RANGE_START + Math.floor(Math.random() * span);
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`在 ${PORT_RANGE_START}-${PORT_RANGE_END} 区间内未找到空闲端口`);
}
