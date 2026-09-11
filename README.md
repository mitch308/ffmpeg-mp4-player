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

- `POST /api/sessions` — 创建会话并探测源。请求体 `{ "url": "..." }`，另有两个可选字段：
  - `quality`：画质档 `origin`（默认）/ `720p` / `1080p` / `2k`；仅允许不高于源分辨率的档位（超出 → 400）
  - `mode`：解码模式 `auto`（默认，直通优先）/ `hw`（硬解硬编）/ `sw`（软解软编）
- `GET /api/sessions/:id/stream?start=秒` → fMP4 流（`video/mp4`）；可选 query 参数 `quality` / `mode`，语义同上，合法值持久化到会话（后续流请求沿用）
- `DELETE /api/sessions/:id` → 销毁会话
- `GET /api/status` → `{ activeSessions, hw: { encoder, label, mode } }`

`POST /api/sessions` 响应字段：

| 字段 | 说明 |
|---|---|
| `sessionId` / `duration` / `width` / `height` / `codec` / `pixFmt` | 源信息 |
| `audioCodec` | 输出音频编码，恒为 `aac`；无音频轨时为 `null` |
| `streamMode` / `encoder` / `hw` | 实际生效策略 `copy` / `hw` / `sw`；编码器名（直通时为 `copy`）；是否硬编 |
| `qualities` | 可用画质档数组，降序，`origin` 恒在末位 |
| `hwAvailable` | 部署机硬编可用性（前端用于显隐"硬解"选项） |
| `requestedQuality` / `requestedMode` | 本次请求的画质档 / 解码模式 |

## iframe 嵌入

播放器可作为 iframe 嵌入任意页面（需与本服务同源访问，或直接指向服务地址）：

```html
<iframe
  src="http://<host>:<port>/player.html?url=<encodeURIComponent(视频地址)>&title=<标题>&autoplay=1"
  allow="autoplay; fullscreen"
  allowfullscreen
></iframe>
```

### URL 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `url` | 必需 | 视频地址（`encodeURIComponent` 后传入） |
| `title` | 空 | 顶部标题栏文字 |
| `ui` | `pc` | 控制器主题：`pc`（紧凑悬浮条）/ `tv`（大字号通栏） |
| `quality` | `origin` | 初始画质档：`720p` / `1080p` / `2k` / `origin`；仅展示不高于源分辨率的档位 |
| `mode` | `auto` | 解码模式：`auto`（自动，直通优先）/ `hw`（硬解硬编）/ `sw`（软解软编）；硬解不可用时菜单不显示硬解选项 |
| `autoplay` | `1` | 自动播放；受浏览器策略限制时先静音自动播放，用户点音量图标恢复声音 |

### 画质阶梯

720p→2.5Mbps、1080p→5Mbps、2K→10Mbps，切换画质从当前播放位置重转码。画面比例（原始/16:9/4:3）为纯前端 CSS 处理，后端输出不变。

### 手工验证清单

- [ ] PC 主题：控制栏显隐（mousemove / 3s / 5s / 暂停常显 / 单击 / 双击）
- [ ] TV 主题：大字号、时间居中、无全屏按钮
- [ ] 画质切换：位置保持、画面变小、恢复播放
- [ ] 解码切换：硬解 ↔ 软解不炸流；无硬编机器不显示硬解选项
- [ ] 倍速 0.75–3x；音量拖动与静音切换
- [ ] 精确 seek（拖到未缓冲区）、断网 5s 自动恢复
- [ ] 静音自动播放 → 点音量恢复

## 开发

从源码构建（`npm run build` / `npm test`）需要 Node ≥ 22（vite@8 / vitest@5 工具链要求）；构建产物与已发布的包本身在 Node ≥ 18 上运行。

## 许可

MIT
