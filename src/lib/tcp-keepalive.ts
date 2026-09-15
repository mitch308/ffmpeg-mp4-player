// src/lib/tcp-keepalive.ts — 服务端 TCP keepalive（半开连接清理）
// 网络级静默死亡（断电/拔网线/系统休眠）不会发 FIN/RST：暂停中的流连接在应用层完全静默
// （服务端因背压停写、也无读事件），探测不到对端死亡，ffmpeg 会残留到 server.stop()。
// 解法是内核级 TCP keepalive 探测：健康连接（含长暂停——内核会代替应用 ACK 探测包）不受影响，
// 对端死亡后探测失败触发 socket 关闭，走既有 req close → stopStream 清理链。
// 注意：Node 只能设 TCP_KEEPIDLE（探测起始前空闲时长），探测间隔/次数取 OS 默认
//（Windows 约 1s×10 次；Linux 约 75s×9 次）——静默到断开的实际时长随平台而异。
import type { Server as NetServer } from 'net';

/** 为服务端所有新连接启用 TCP keepalive（initialDelaySec 秒空闲后开始探测） */
export function applyTcpKeepAlive(server: NetServer, initialDelaySec: number): void {
  server.on('connection', (socket) => {
    socket.setKeepAlive(true, initialDelaySec * 1000);
  });
}
