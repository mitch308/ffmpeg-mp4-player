# ffmpeg-mp4-player

基于 ffmpeg 的 Web 视频播放服务：输入视频文件 URL，服务端转码/直通为 fMP4（H.264 + AAC），浏览器经 MSE 播放，支持精确 seek、硬件加速、多并发会话。

## 安装

```bash
npm install ffmpeg-mp4-player
```

需要 Node ≥ 18。

## 获取 ffmpeg / ffprobe（必需）

本包**不内置** ffmpeg/ffprobe 二进制，也不提供下载功能。启动前需确保 ffmpeg 与 ffprobe 可用，三种方式任选：

### 方式一（推荐）：ffmpeg-static / ffprobe-static

```bash
npm install ffmpeg-static ffprobe-static
```

装上即可，本包会自动从宿主 node_modules 探测到它们，零配置。

### 方式二：手动下载

- Windows: https://www.gyan.dev/ffmpeg/builds/ （release full）
- Linux: https://johnvansickle.com/ffmpeg/ 或发行版包管理器
- macOS: `brew install ffmpeg` 或 https://evermeet.cx/ffmpeg/

下载后解压，记下 `ffmpeg`/`ffprobe`（Windows 为 `.exe`）的路径，按下文配置。

### 方式三：环境变量

```bash
export FFMPEG_PATH=/path/to/ffmpeg
export FFPROBE_PATH=/path/to/ffprobe
```

三级来源优先级：**显式配置 > 环境变量 > static 包自动探测**；全部落空时启动报错并给出指引。

## 快速开始（API）

```js
const { startServer } = require('ffmpeg-mp4-player');
// ESM: import { startServer } from 'ffmpeg-mp4-player';

const server = await startServer({
  port: 8080,            // 可省略：从 20000–30000 随机选空闲端口
  // childProcess: true, // 子进程模式（隔离运行，崩溃不影响宿主）
  // ffmpegPath: '/path/to/ffmpeg',
  // ffprobePath: '/path/to/ffprobe',
});
console.log(`播放器页面: ${server.url}`);

// 退出前优雅停止（销毁会话、杀 ffmpeg/子进程）
await server.stop();
```

返回的 `server.port` 是最终监听端口（显式端口被占会直接报错，不静默换端口）。

## CLI

```bash
npx ffmpeg-mp4-player --port 8080 --host 0.0.0.0
# 或
PORT=8080 FFMPEG_PATH=/path/to/ffmpeg npx ffmpeg-mp4-player
```

CLI 从环境变量读取 `PORT` 与 `HOST`（`--port`/`--host` 参数优先）；库 API 则把端口/地址作为 `port`/`host` 选项传入——端口语义不在库核心内读取环境变量，由调用方（CLI 或你的代码）自行决定。

## 配置项

| 项 | 类型 | 默认 | 说明 |
|----|------|------|------|
| `port` | number | 随机（20000–30000） | 监听端口 |
| `host` | string | `127.0.0.1` | 绑定地址 |
| `childProcess` | boolean | `false` | 子进程模式启动 |
| `ffmpegPath` | string | 解析链 | ffmpeg 可执行文件路径 |
| `ffprobePath` | string | 解析链 | ffprobe 可执行文件路径 |
| `staticPlayer` | boolean | `true` | 托管内置网页播放器（访问根路径） |

## HTTP API

- `POST /api/sessions` `{ "url": "..." }` → `{ sessionId, duration, width, height, codec, audioCodec, streamMode, ... }`
- `GET /api/sessions/:id/stream?start=秒` → fMP4 流（`video/mp4`）
- `DELETE /api/sessions/:id` → 销毁会话
- `GET /api/status` → `{ activeSessions, hw: { encoder, label, mode } }`

## 开发

从源码构建（`npm run build` / `npm test`）需要 Node ≥ 22（vite@8 / vitest@5 工具链要求）；构建产物与已发布的包本身在 Node ≥ 18 上运行。

## 许可

MIT
