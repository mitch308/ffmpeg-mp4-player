// src/config.ts — 公共配置类型与默认值
export interface PlayerServerOptions {
  /** 监听端口；未配置时从 20000–30000 区间随机选取空闲端口 */
  port?: number;
  /** 绑定地址，默认 127.0.0.1 */
  host?: string;
  /** true 时 fork 子进程运行服务，默认 false */
  childProcess?: boolean;
  /** ffmpeg 可执行文件路径；不传走解析链（显式配置 > 环境变量 > static 包） */
  ffmpegPath?: string;
  /** ffprobe 可执行文件路径；不传走解析链 */
  ffprobePath?: string;
  /** 是否托管 public/ 播放器页面，默认 true */
  staticPlayer?: boolean;
}

export interface PlayerServer {
  /** 最终监听端口 */
  port: number;
  /** http://host:port */
  url: string;
  /** 关闭服务；本进程模式销毁全部会话，子进程模式杀进程树 */
  stop(): Promise<void>;
}

export const DEFAULT_HOST = '127.0.0.1';
