// src/lib/url.ts — 源 URL 预处理
// Windows 上 localhost 优先解析为 IPv6 ::1（Node dns.lookup verbatim 行为），
// 而 ffmpeg/ffprobe 无 Happy Eyeballs 回退：目标服务只监听 IPv4 时，
// 连接会卡在 ::1 上直至超时（实测 ffprobe 挂死 15s+，127.0.0.1 则 0.2s 成功）。
// 因此把 http(s) URL 的 localhost 主机统一重写为 127.0.0.1。
// 代价：纯 IPv6-only 的 localhost 服务无法直连——这类场景请直接输入 [::1] 或 IPv6 地址。
// 用正则只替换主机名段：避免 URL 对象往返改写路径中的未编码字符（如未编码的中文）。
const LOCALHOST_HOST_RE = /^(https?:\/\/)localhost(?=[/:?#]|$)/i;

export function normalizeLocalhostUrl(url: string): string {
  return url.replace(LOCALHOST_HOST_RE, (_m, scheme: string) => `${scheme}127.0.0.1`);
}
