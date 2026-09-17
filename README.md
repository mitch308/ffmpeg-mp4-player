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

### 生命周期事件

`server` 实例支持事件监听（继承 EventEmitter，事件与负载有 TS 类型约束）：

```js
server.on('start', ({ port, url, host, childProcess }) => { /* 服务就绪 */ });
server.on('stop', () => { /* 已完全停止（会话销毁/子进程已杀/监听关闭） */ });
server.on('idle', () => { /* 进入空闲：无任何会话且持续 10s 确认期 */ });
server.on('busy', () => { /* 从空闲态恢复繁忙：新会话接入 */ });
server.on('crash', ({ code, signal, message }) => { /* 子进程意外退出 */ });
```

| 事件 | 负载 | 触发时机 |
|------|------|----------|
| `start` | `{ port, url, host, childProcess }` | 服务就绪。在 `startServer` resolve 后异步发出，`await` 之后挂监听即可收到 |
| `stop` | 无 | 首次 `stop()` 成功完成后；重复 `stop()` 幂等，不再重复发出 |
| `idle` | 无 | 无任何会话且持续 10s 确认期（吸收"关旧页开新页"的会话间隙）。边缘触发：恢复繁忙后重新武装。播放暂停/断连不算空闲（会话仍存在，见 `server.isIdle()` 与自动清理语义） |
| `busy` | 无 | 从已确认的空闲态出现新会话时立即发出；确认期内创建会话不算（从未离开过繁忙态） |
| `crash` | `{ code, signal, message }` | 仅子进程模式：子进程意外退出（非 `stop()` 发起）时发出。本进程模式不发 `crash`（与宿主同生共死；服务层 error 走日志，进程级崩溃需宿主自行监听 `process` 事件兜底） |

`stop()` 幂等：仅首次调用执行真实关闭。`off(event, listener)` 可取消监听。`server.isIdle()` 同步查询当前是否处于已确认空闲态（确认期内返回 `false`）。

### 状态查询

`await server.getStatus()` 返回服务状态快照（不依赖事件，随时主动查询）：

| 字段 | 说明 |
|---|---|
| `port` / `url` / `pid` | 监听端口 / 地址 / 子进程 pid（本进程模式为 `null`） |
| `childProcess` | 是否子进程模式 |
| `stopped` | 是否已 `stop()` |
| `idle` | 是否已确认空闲（同 `isIdle()`） |
| `activeSessions` | 当前会话数（子进程模式经 IPC 同步，毫秒级滞后） |
| `hw` | `{ encoder, label, mode }` 硬件编码能力 |
| `uptimeSec` | 运行时长（秒） |

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
| `logger` | function | console | 自定义日志函数 `(level: 'info'\|'warn'\|'error', message: string) => void`；消息带统一前缀 `[fmp4]`。子进程模式下同样生效：子进程日志经 IPC 转发回父进程由此函数输出 |
| `readHighWaterSec` | number | `45` | 前端读泵高水位（秒）：缓冲领先播放头超过该值暂停读取，防撑爆 MSE 配额。需大于低水位且 ≤600 |
| `readLowWaterSec` | number | `15` | 前端读泵低水位（秒）：缓冲领先回落到该值以下恢复读取。非法配置启动即报错 |
| `connectionKeepAliveSec` | number | `30` | 服务端 TCP keepalive 起始空闲时长（秒），`0` 显式禁用。用于清理网络级静默死亡（断电/拔网线/休眠）的半开连接，防 ffmpeg 残留；健康连接（含长暂停）不受影响。探测间隔/次数取 OS 默认 |

日志统一以 `[fmp4][<组件>:<上下文>]` 开头（如 `[fmp4][session:abc123]`、`[fmp4][ffmpeg pid=1 session:abc123]`、`[fmp4][client ...]`），按会话 id grep 即可串联前后端全链路。前端播放器日志除浏览器 console 外，还会经 `POST /api/logs` 上报到服务端统一输出。

## HTTP API

- `POST /api/sessions` — 创建会话并探测源。请求体 `{ "url": "..." }`，另有两个可选字段：
  - `quality`：画质档 `origin`（默认）/ `720p` / `1080p` / `2k`；仅允许不高于源分辨率的档位（超出 → 400）
  - `mode`：解码模式 `auto`（默认，直通优先）/ `hw`（硬解硬编）/ `sw`（软解软编）
- `GET /api/sessions/:id/stream?start=秒` → fMP4 流（`video/mp4`）；可选 query 参数 `quality` / `mode`，语义同上，合法值持久化到会话（后续流请求沿用）
- `DELETE /api/sessions/:id` → 销毁会话
- `GET /api/status` → `{ activeSessions, hw: { encoder, label, mode } }`
- `GET /api/player-config` → `{ readHighWaterSec, readLowWaterSec }`（播放器读泵水位线，源自启动配置）
- `POST /api/logs` — 前端播放器日志批量上报。请求体 `{ entries: [{ level, tag, message }] }`（单批 ≤100 条，message 截断 2000 字符），服务端经统一 logger 以 `[fmp4][client <tag>]` 前缀输出

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
| `autoplay` | `1` | 自动播放；无手势策略可能拦截，用户点一下播放即可 |
| `volume` | `1` | 初始音量：`0`~`1`（小数，如 `0.5`）或 `1`~`100`（百分数，如 `50`） |
| `mute` | `0` | `1` 静音起播，点音量图标/条解除；`0` 显式不静音 |
| `highwater` | 服务端配置 | 读泵高水位（秒）：覆盖 `/api/player-config` 下发的值 |
| `lowwater` | 服务端配置 | 读泵低水位（秒）：覆盖 `/api/player-config` 下发的值；非法组合（low ≥ high）整体回退默认 |

音量/静音会自动记入 `localStorage`（key `fmp4-player:volume`），下次打开未传 `volume`/`mute` 时沿用上次设置；显式传参优先于缓存，两个维度相互独立。播放器处于 iframe 中时，音量或静音变化（含挂载后的初始值）会通过 `postMessage` 通知父窗口：

```js
window.addEventListener('message', (e) => {
  if (e.data?.source !== 'fmp4-player') return;
  if (e.data.type === 'volumechange') {
    console.log(e.data.volume, e.data.muted); // volume: 0~1 小数；muted: boolean
  }
});
```

### 画质阶梯

720p→2.5Mbps、1080p→5Mbps、2K→10Mbps，切换画质从当前播放位置重转码。画面比例（原始/16:9/4:3）为纯前端 CSS 处理，后端输出不变。

## 开发

从源码构建（`npm run build` / `npm test`）需要 Node ≥ 22（vite@8 / vitest@5 工具链要求）；构建产物与已发布的包本身在 Node ≥ 18 上运行。

## 许可

MIT
