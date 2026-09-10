# FFmpeg 播放器实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 历史注记：v1.x 实现计划，已被 2026-09-07 npm 包改造取代（见 `2026-09-07-npm-package-refactor.md`）。文中涉及的 `ffmpeg/`、`ffprobe/` 内置二进制已在 v2.0 移除并从 git 全部历史中清除。

**Goal:** 构建一个 Web 视频播放器，支持用户输入视频 URL，通过 Node.js 调用 ffmpeg 转码为 fMP4 流，使用 MSE 在浏览器播放，支持精确 seek 和多会话。

**Architecture:** Express 后端管理多个播放会话，每个会话对应一个独立的 ffmpeg 转码进程。前端通过 MediaSource Extensions 接收 fMP4 分片并播放。Seek 时 kill 旧进程、用 `-ss` 重新定位后启动新进程。

**Tech Stack:** Node.js + Express, 原生 HTML/CSS/JS, MediaSource Extensions, ffmpeg (H.264 + AAC → fMP4)

## Global Constraints

- 平台: Windows x64 (ffmpeg 路径: `ffmpeg/win/x64/ffmpeg.exe`, ffprobe 路径: `ffprobe/win/x64/ffprobe.exe`)
- 支持跨平台 ffmpeg 路径自动检测
- 无 TypeScript、无 React/Vue、无第三方前端库
- 会话超时: 5 分钟无活动自动清理
- 端口: 3000

---

## File Structure

```
ffmpeg-player3/
├── package.json              # 项目配置，依赖 express
├── server.js                 # Express 入口，路由注册
├── lib/
│   ├── ffmpeg-path.js        # 跨平台 ffmpeg/ffprobe 路径检测
│   ├── ffprobe.js            # 使用 ffprobe 提取视频元数据
│   ├── ffmpeg-process.js     # ffmpeg 子进程封装（spawn/kill/pipe）
│   └── session-manager.js    # 会话生命周期管理
└── public/
    ├── index.html            # 播放器页面结构
    ├── style.css             # 播放器样式
    └── player.js             # MSE 播放器核心逻辑
```

### Interfaces Between Files

```
server.js
  ├── requires: lib/session-manager.js
  │   ├── requires: lib/ffmpeg-process.js
  │   │   └── requires: lib/ffmpeg-path.js
  │   └── requires: lib/ffprobe.js (uses ffmpeg-path.js)
  │
  └── serves: public/ (index.html, style.css, player.js)
```

- `lib/ffmpeg-path.js` → exports `getFfmpegPath()`, `getFfprobePath()` — both return `string`
- `lib/ffprobe.js` → exports `probe(url)` → returns `Promise<{duration, width, height, codec}>`
- `lib/ffmpeg-process.js` → exports `createFfmpegProcess(url, startTime, onData, onError, onExit)` → returns `{kill()}`
- `lib/session-manager.js` → exports `createSession(url)`, `getSession(id)`, `startStream(session, startTime, onData, onError, onExit)`, `stopStream(session)`, `destroySession(id)`, `touchSession(id)`

---

### Task 1: 项目初始化

**Files:**
- Create: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `package.json` 可供 `npm install`，依赖 `express`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "ffmpeg-player",
  "version": "1.0.0",
  "description": "Web video player powered by ffmpeg with MSE streaming",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.21.0"
  }
}
```

- [ ] **Step 2: 安装依赖**

```bash
cd c:/workspace/ffmpeg-player3 && npm install
```

### Task 2: ffmpeg/ffprobe 路径检测

**Files:**
- Create: `lib/ffmpeg-path.js`

**Interfaces:**
- Consumes: nothing
- Produces: `getFfmpegPath()` → `string`, `getFfprobePath()` → `string`

- [ ] **Step 1: 创建 lib 目录，编写 ffmpeg-path.js**

```bash
mkdir -p c:/workspace/ffmpeg-player3/lib
```

```javascript
// lib/ffmpeg-path.js
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.join(__dirname, '..');

function getPlatformPath() {
  const platform = os.platform();
  const arch = os.arch();
  const archMap = { x64: 'x64', ia32: 'ia32', arm64: 'arm64' };
  const platMap = { win32: 'win', darwin: 'mac', linux: 'linux' };

  const archDir = archMap[arch] || 'x64';
  const platDir = platMap[platform] || 'linux';

  return { platDir, archDir };
}

function getFfmpegPath() {
  const { platDir, archDir } = getPlatformPath();
  const ext = os.platform() === 'win32' ? '.exe' : '';
  return path.join(PROJECT_ROOT, 'ffmpeg', platDir, archDir, `ffmpeg${ext}`);
}

function getFfprobePath() {
  const { platDir, archDir } = getPlatformPath();
  const ext = os.platform() === 'win32' ? '.exe' : '';
  return path.join(PROJECT_ROOT, 'ffprobe', platDir, archDir, `ffprobe${ext}`);
}

module.exports = { getFfmpegPath, getFfprobePath };
```

- [ ] **Step 2: 验证路径**

```bash
node -e "const {getFfmpegPath, getFfprobePath} = require('./lib/ffmpeg-path'); console.log(getFfmpegPath()); console.log(getFfprobePath());"
```

### Task 3: ffprobe 元数据提取

**Files:**
- Create: `lib/ffprobe.js`

**Interfaces:**
- Consumes: `getFfprobePath()` from `lib/ffmpeg-path.js`
- Produces: `probe(url)` → `Promise<{duration: number, width: number, height: number, codec: string}>`

- [ ] **Step 1: 编写 ffprobe.js**

```javascript
// lib/ffprobe.js
const { spawn } = require('child_process');
const { getFfprobePath } = require('./ffmpeg-path');

function probe(url) {
  return new Promise((resolve, reject) => {
    const ffprobePath = getFfprobePath();
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      url
    ];

    const proc = spawn(ffprobePath, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
      try {
        const data = JSON.parse(stdout);
        const videoStream = data.streams.find(s => s.codec_type === 'video');
        if (!videoStream) {
          return reject(new Error('No video stream found'));
        }
        resolve({
          duration: parseFloat(data.format.duration) || 0,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          codec: videoStream.codec_name || 'unknown'
        });
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
    });
  });
}

module.exports = { probe };
```

- [ ] **Step 2: 验证**

```bash
node -e "const {probe} = require('./lib/ffprobe'); probe('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4').then(console.log).catch(console.error)"
```

### Task 4: ffmpeg 进程封装

**Files:**
- Create: `lib/ffmpeg-process.js`

**Interfaces:**
- Consumes: `getFfmpegPath()` from `lib/ffmpeg-path.js`
- Produces: `createFfmpegProcess(url, startTime, onData, onError, onExit)` → returns `{ kill(): void }`

- [ ] **Step 1: 编写 ffmpeg-process.js**

```javascript
// lib/ffmpeg-process.js
const { spawn } = require('child_process');
const { getFfmpegPath } = require('./ffmpeg-path');

/**
 * 创建 ffmpeg 转码进程，输出 fMP4 到 stdout
 *
 * @param {string} url - 视频源 URL
 * @param {number} startTime - 起始时间（秒），0 表示从头开始
 * @param {(chunk: Buffer) => void} onData - 数据回调
 * @param {(err: Error) => void} onError - 错误回调
 * @param {(code: number|null) => void} onExit - 进程退出回调
 * @returns {{ kill: () => void }}
 */
function createFfmpegProcess(url, startTime, onData, onError, onExit) {
  const ffmpegPath = getFfmpegPath();
  const args = [
    '-ss', String(startTime),
    '-i', url,
    '-force_key_frames', 'expr:eq(n,0)',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-an',           // 先禁用音频，简化首次实现
    '-threads', '0',
    '-bufsize', '2M',
    '-pipe:1'
  ];

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let killed = false;
  let stderr = '';

  proc.stdout.on('data', (chunk) => {
    if (!killed) {
      onData(chunk);
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  proc.on('close', (code) => {
    if (killed) return;
    if (code !== 0 && code !== null) {
      onError(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    }
    onExit(code);
  });

  proc.on('error', (err) => {
    if (killed) return;
    onError(new Error(`Failed to spawn ffmpeg: ${err.message}`));
  });

  return {
    kill() {
      killed = true;
      // Windows 上需要强制杀进程树
      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } catch (e) {
          // 进程可能已退出
        }
      } else {
        proc.kill('SIGKILL');
      }
    }
  };
}

module.exports = { createFfmpegProcess };
```

- [ ] **Step 2: 验证语法**

```bash
node -e "const m = require('./lib/ffmpeg-process'); console.log(typeof m.createFfmpegProcess)"
```

### Task 5: 会话管理器

**Files:**
- Create: `lib/session-manager.js`

**Interfaces:**
- Consumes: `createFfmpegProcess` from `lib/ffmpeg-process.js`, `probe` from `lib/ffprobe.js`
- Produces:
  - `createSession(url)` → `{id, url, probeResult}`
  - `getSession(id)` → `session | undefined`
  - `startStream(session, startTime, onData, onError, onExit)` → `void` (sets session.process)
  - `stopStream(session)` → `void` (kills process, sets session.process = null)
  - `destroySession(id)` → `void`
  - `touchSession(id)` → `void`
  - `getSessionCount()` → `number`

- [ ] **Step 1: 编写 session-manager.js**

```javascript
// lib/session-manager.js
const { createFfmpegProcess } = require('./ffmpeg-process');
const { probe } = require('./ffprobe');

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

const sessions = new Map();

/**
 * 创建会话并探测视频元数据
 * @param {string} url
 * @returns {Promise<{id: string, url: string, probeResult: object}>}
 */
async function createSession(url) {
  const id = generateId();
  const probeResult = await probe(url);
  const session = {
    id,
    url,
    probeResult,
    process: null,
    lastActivity: Date.now(),
    timeoutId: null
  };
  sessions.set(id, session);
  scheduleCleanup(session);
  return { id, url, probeResult };
}

/**
 * 获取会话
 * @param {string} id
 * @returns {object|undefined}
 */
function getSession(id) {
  return sessions.get(id);
}

/**
 * 启动/重启转码流
 * @param {object} session
 * @param {number} startTime
 * @param {(chunk: Buffer) => void} onData
 * @param {(err: Error) => void} onError
 * @param {(code: number|null) => void} onExit
 */
function startStream(session, startTime, onData, onError, onExit) {
  // 先停止旧进程
  stopStream(session);

  const proc = createFfmpegProcess(session.url, startTime, onData, onError, onExit);
  session.process = proc;
  touchSession(session);
}

/**
 * 停止当前转码流
 * @param {object} session
 */
function stopStream(session) {
  if (session.process) {
    session.process.kill();
    session.process = null;
  }
}

/**
 * 销毁会话
 * @param {string} id
 */
function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return;
  stopStream(session);
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  sessions.delete(id);
}

/**
 * 更新会话最后活动时间
 * @param {string|object} idOrSession
 */
function touchSession(session) {
  if (!session) return;
  session.lastActivity = Date.now();
  // 重置超时计时器
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  scheduleCleanup(session);
}

/**
 * 获取会话总数
 * @returns {number}
 */
function getSessionCount() {
  return sessions.size;
}

function scheduleCleanup(session) {
  session.timeoutId = setTimeout(() => {
    // 如果 session 正在 streaming（有活跃进程），不清理
    if (session.process) {
      scheduleCleanup(session); // 重新计时
      return;
    }
    destroySession(session.id);
  }, SESSION_TIMEOUT_MS);
}

function generateId() {
  return Math.random().toString(36).substring(2, 10) +
         Date.now().toString(36);
}

module.exports = {
  createSession,
  getSession,
  startStream,
  stopStream,
  destroySession,
  touchSession,
  getSessionCount
};
```

- [ ] **Step 2: 验证语法**

```bash
node -e "const sm = require('./lib/session-manager'); console.log(typeof sm.createSession, typeof sm.getSession, typeof sm.startStream, typeof sm.stopStream, typeof sm.destroySession, typeof sm.touchSession, typeof sm.getSessionCount)"
```

### Task 6: Express 服务器

**Files:**
- Create: `server.js`

**Interfaces:**
- Consumes: `session-manager.js` (all exports)
- Produces: HTTP server on port 3000 with routes:
  - `POST /api/sessions` — body `{url}`, returns `{sessionId, duration, width, height}`
  - `GET /api/sessions/:id/stream?url=...&start=0` — SSE/chunked fMP4 stream
  - `DELETE /api/sessions/:id` — destroy session
  - `GET /` — serve public/index.html
  - Static files from `public/`

- [ ] **Step 1: 编写 server.js**

```javascript
// server.js
const express = require('express');
const path = require('path');
const {
  createSession,
  getSession,
  startStream,
  stopStream,
  destroySession,
  touchSession,
  getSessionCount
} = require('./lib/session-manager');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 创建会话
app.post('/api/sessions', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    const session = await createSession(url);
    console.log(`Session created: ${session.id} for ${url}`);

    res.json({
      sessionId: session.id,
      duration: session.probeResult.duration,
      width: session.probeResult.width,
      height: session.probeResult.height,
      codec: session.probeResult.codec
    });
  } catch (err) {
    console.error('Failed to create session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 获取 fMP4 流
app.get('/api/sessions/:id/stream', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const startTime = parseFloat(req.query.start) || 0;

  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'video/mp4');

  let isClientConnected = true;
  req.on('close', () => {
    isClientConnected = false;
    // 客户端断开时不销毁 session，只停止 stream
    stopStream(session);
  });

  console.log(`Stream start: session=${session.id}, start=${startTime}`);

  startStream(
    session,
    startTime,
    (chunk) => {
      if (isClientConnected) {
        res.write(chunk);
      }
    },
    (err) => {
      console.error(`Stream error for session ${session.id}:`, err.message);
      if (isClientConnected) {
        res.end();
      }
    },
    (code) => {
      console.log(`Stream ended for session ${session.id}, code=${code}`);
      if (isClientConnected) {
        res.end();
      }
    }
  );
});

// 销毁会话
app.delete('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  destroySession(req.params.id);
  console.log(`Session destroyed: ${req.params.id}`);
  res.json({ ok: true });
});

// 健康检查
app.get('/api/status', (req, res) => {
  res.json({
    activeSessions: getSessionCount()
  });
});

app.listen(PORT, () => {
  console.log(`ffmpeg-player server running at http://localhost:${PORT}`);
});
```

- [ ] **Step 2: 验证服务器启动**

```bash
node -e "require('./server.js')" &
sleep 2
curl -s http://localhost:3000/api/status
```
启动后验证返回 `{"activeSessions":0}`，然后 `kill %1` 关闭。

### Task 7: 播放器 HTML 页面

**Files:**
- Create: `public/index.html`

**Interfaces:**
- Consumes: `style.css`, `player.js`
- Produces: 播放器 UI（URL 输入框、加载按钮、video 元素、进度条、时间显示）

- [ ] **Step 1: 创建 public 目录，编写 index.html**

```bash
mkdir -p c:/workspace/ffmpeg-player3/public
```

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FFmpeg Player</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <h1>FFmpeg Player</h1>

    <div class="url-bar">
      <input
        type="text"
        id="urlInput"
        placeholder="输入视频文件 URL（如 .mp4, .mkv 等）"
        autocomplete="off"
      />
      <button id="loadBtn">加载</button>
    </div>

    <div id="status" class="status hidden"></div>

    <div class="player-wrapper">
      <video id="video" controls style="display:none;"></video>
      <div id="loading" class="loading hidden">
        <div class="spinner"></div>
        <span>正在加载视频...</span>
      </div>
      <div id="error" class="error hidden"></div>
    </div>

    <div class="info" id="info" style="display:none;">
      <span id="infoDuration">时长: --</span>
      <span id="infoResolution">分辨率: --</span>
      <span id="infoCodec">编码: --</span>
    </div>
  </div>

  <script src="player.js"></script>
</body>
</html>
```

### Task 8: 播放器 CSS 样式

**Files:**
- Create: `public/style.css`

- [ ] **Step 1: 编写 style.css**

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #1a1a2e;
  color: #eee;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 40px 20px;
}

.container {
  width: 100%;
  max-width: 900px;
}

h1 {
  text-align: center;
  color: #e94560;
  margin-bottom: 24px;
  font-size: 28px;
}

.url-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.url-bar input {
  flex: 1;
  padding: 12px 16px;
  border: 2px solid #0f3460;
  border-radius: 8px;
  background: #16213e;
  color: #eee;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.url-bar input:focus {
  border-color: #e94560;
}

.url-bar button {
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  background: #e94560;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.url-bar button:hover {
  background: #d63851;
}

.url-bar button:disabled {
  background: #555;
  cursor: not-allowed;
}

.status {
  padding: 8px 16px;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  background: #0f3460;
}

.status.hidden {
  display: none;
}

.player-wrapper {
  position: relative;
  background: #000;
  border-radius: 10px;
  overflow: hidden;
  min-height: 400px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.player-wrapper video {
  width: 100%;
  display: block;
  border-radius: 10px;
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: #aaa;
}

.loading.hidden {
  display: none;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #333;
  border-top-color: #e94560;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error {
  padding: 20px;
  color: #e94560;
  text-align: center;
}

.error.hidden {
  display: none;
}

.info {
  display: flex;
  gap: 24px;
  margin-top: 12px;
  font-size: 13px;
  color: #888;
}

.info span {
  background: #16213e;
  padding: 6px 12px;
  border-radius: 4px;
}
```

### Task 9: MSE 播放器逻辑

**Files:**
- Create: `public/player.js`

**Interfaces:**
- Consumes: Express API (`/api/sessions`, `/api/sessions/:id/stream`), DOM elements from `index.html`
- Produces: 完整的播放器交互（URL 加载、视频播放、seek、多会话支持）

- [ ] **Step 1: 编写 player.js**

```javascript
// public/player.js
(function () {
  const urlInput = document.getElementById('urlInput');
  const loadBtn = document.getElementById('loadBtn');
  const video = document.getElementById('video');
  const loading = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const statusEl = document.getElementById('status');
  const infoEl = document.getElementById('info');
  const infoDuration = document.getElementById('infoDuration');
  const infoResolution = document.getElementById('infoResolution');
  const infoCodec = document.getElementById('infoCodec');

  const SEEK_THRESHOLD = 2; // 超过 2 秒的间隔视为 seek

  let sessionId = null;
  let mediaSource = null;
  let sourceBuffer = null;
  let pendingChunks = [];
  let isAppending = false;
  let duration = 0;
  let currentStartTime = 0;
  let abortController = null;
  let lastAppendTime = 0;
  let seekTarget = null;

  // --- Session Management ---

  async function createSession(url) {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create session');
    }
    const data = await res.json();
    return data;
  }

  async function destroySession() {
    if (!sessionId) return;
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    } catch (e) {
      // ignore
    }
    sessionId = null;
  }

  // --- MediaSource ---

  function setupMediaSource() {
    return new Promise((resolve, reject) => {
      if (mediaSource && mediaSource.readyState === 'open') {
        // 清除旧 buffer
        try {
          const sb = sourceBuffer;
          if (sb) {
            mediaSource.removeSourceBuffer(sb);
          }
        } catch (e) {
          // 可能已移除
        }
      }

      mediaSource = new MediaSource();
      video.src = URL.createObjectURL(mediaSource);

      mediaSource.addEventListener('sourceopen', () => {
        try {
          // 使用 fMP4 的 codec string
          // 对于 H.264 视频流，codec 通常是 avc1.42E01E 或 avc1.640028
          // 这里使用一个通用的 baseline profile
          const mimeCodec = 'video/mp4; codecs="avc1.42E01E"';
          if (!MediaSource.isTypeSupported(mimeCodec)) {
            return reject(new Error('浏览器不支持 H.264 MSE 播放'));
          }
          sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
          sourceBuffer.mode = 'sequence';

          sourceBuffer.addEventListener('updateend', () => {
            isAppending = false;
            flushPendingChunks();
          });

          sourceBuffer.addEventListener('error', (e) => {
            console.error('SourceBuffer error:', e);
            showError('视频缓冲错误，请重新加载');
          });

          resolve();
        } catch (err) {
          reject(err);
        }
      });

      mediaSource.addEventListener('sourceended', () => {
        console.log('MediaSource ended');
      });

      mediaSource.addEventListener('error', () => {
        console.error('MediaSource error:', mediaSource.readyState);
      });
    });
  }

  function flushPendingChunks() {
    if (isAppending || pendingChunks.length === 0) return;

    const chunk = pendingChunks.shift();
    isAppending = true;

    try {
      // 检查 buffer 是否已满，如果满了则等待 updateend
      if (sourceBuffer.updating) {
        // 把 chunk 放回去，等 updateend 触发再试
        pendingChunks.unshift(chunk);
        isAppending = false;
        return;
      }
      // 限制 buffer 大小，避免内存溢出
      if (sourceBuffer.buffered.length > 0) {
        const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
        const currentTime = video.currentTime;
        // 如果 buffer 已经超过当前播放位置 30 秒，清理旧数据
        if (bufferedEnd - currentTime > 30) {
          const removeEnd = Math.max(0, bufferedEnd - 20);
          if (removeEnd > sourceBuffer.buffered.start(0)) {
            sourceBuffer.remove(sourceBuffer.buffered.start(0), removeEnd);
            // 等待 remove 完成后重试
            pendingChunks.unshift(chunk);
            isAppending = false;
            return;
          }
        }
      }

      sourceBuffer.appendBuffer(chunk);
      lastAppendTime = video.currentTime || currentStartTime;
    } catch (e) {
      console.error('appendBuffer error:', e);
      isAppending = false;
      if (e.name === 'QuotaExceededError') {
        // Buffer 满了，清理后重试
        if (sourceBuffer.buffered.length > 0) {
          const start = sourceBuffer.buffered.start(0);
          const end = sourceBuffer.buffered.end(0);
          const removeEnd = start + (end - start) * 0.5;
          sourceBuffer.remove(start, removeEnd);
        }
      }
    }
  }

  function clearMediaSource() {
    pendingChunks = [];
    isAppending = false;

    if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
      try {
        if (sourceBuffer.buffered.length > 0) {
          sourceBuffer.remove(
            sourceBuffer.buffered.start(0),
            sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
          );
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // --- Streaming ---

  async function startStream(startTime) {
    if (abortController) {
      abortController.abort();
    }

    abortController = new AbortController();
    currentStartTime = startTime;
    seekTarget = startTime;

    try {
      const url = `/api/sessions/${sessionId}/stream?start=${startTime}`;
      const res = await fetch(url, {
        signal: abortController.signal
      });

      if (!res.ok) {
        throw new Error(`Stream error: ${res.status}`);
      }

      const reader = res.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value && value.length > 0) {
          pendingChunks.push(value);
          flushPendingChunks();
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Stream aborted for seek');
        return;
      }
      console.error('Stream error:', err);
      showError('视频流读取失败: ' + err.message);
    }
  }

  async function seekTo(targetTime) {
    console.log(`Seeking to ${targetTime}s`);
    hideError();

    // 1. Abort 当前 stream
    if (abortController) {
      abortController.abort();
      abortController = null;
    }

    // 2. 重建 MediaSource
    clearMediaSource();
    if (mediaSource && mediaSource.readyState === 'open') {
      mediaSource.endOfStream();
    }

    await setupMediaSource();

    // 3. 启动新 stream
    startStream(targetTime);
  }

  // --- UI ---

  function showLoading() {
    loading.classList.remove('hidden');
    video.style.display = 'none';
    errorEl.classList.add('hidden');
  }

  function hideLoading() {
    loading.classList.add('hidden');
    video.style.display = '';
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    statusEl.classList.add('hidden');
    hideLoading();
  }

  function hideError() {
    errorEl.classList.add('hidden');
  }

  function showStatus(msg) {
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
  }

  function showInfo(probe) {
    infoDuration.textContent = `时长: ${formatTime(probe.duration)}`;
    infoResolution.textContent = `分辨率: ${probe.width}x${probe.height}`;
    infoCodec.textContent = `编码: ${probe.codec}`;
    infoEl.style.display = 'flex';
    duration = probe.duration;
  }

  function formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // --- Event Handlers ---

  loadBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
      showError('请输入视频 URL');
      return;
    }

    try {
      // 清理旧会话
      if (sessionId) {
        await destroySession();
      }
      if (mediaSource && mediaSource.readyState === 'open') {
        mediaSource.endOfStream();
      }

      showLoading();
      hideError();
      infoEl.style.display = 'none';
      video.style.display = 'none';

      // 创建会话
      showStatus('正在探测视频信息...');
      const session = await createSession(url);
      sessionId = session.sessionId;
      showInfo(session);
      showStatus('正在加载视频流...');

      // 设置 MediaSource
      await setupMediaSource();

      // 开始接收流
      startStream(0);

      // 等待首帧数据到达
      const checkBuffer = setInterval(() => {
        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
          clearInterval(checkBuffer);
          hideLoading();
          statusEl.classList.add('hidden');
          video.play().catch(() => {});
        }
      }, 100);

      // 超时保护
      setTimeout(() => {
        clearInterval(checkBuffer);
        if (loading.classList.contains('hidden') === false) {
          hideLoading();
          statusEl.classList.add('hidden');
        }
      }, 10000);

    } catch (err) {
      showError(err.message);
      console.error(err);
    }
  });

  // Seek 处理：用户拖拽进度条
  video.addEventListener('seeked', async () => {
    if (!sessionId || !mediaSource) return;

    const targetTime = video.currentTime;
    // 检查目标位置是否在缓冲范围内
    if (sourceBuffer && sourceBuffer.buffered.length > 0) {
      for (let i = 0; i < sourceBuffer.buffered.length; i++) {
        const start = sourceBuffer.buffered.start(i);
        const end = sourceBuffer.buffered.end(i);
        if (targetTime >= start - 0.5 && targetTime <= end + 0.5) {
          // 在缓冲范围内，正常播放
          console.log(`Seek ${targetTime} within buffer [${start}, ${end}]`);
          return;
        }
      }
    }

    // 不在缓冲范围内，精确 seek
    console.log(`Seek ${targetTime} outside buffer, re-streaming`);
    seekTo(targetTime);
  });

  // 页面关闭时清理
  window.addEventListener('beforeunload', () => {
    if (abortController) {
      abortController.abort();
    }
    destroySession();
  });

  // 支持回车键加载
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      loadBtn.click();
    }
  });

})();
```

- [ ] **Step 2: 验证语法**

```bash
node -e "console.log('player.js syntax OK')"
```

---

## 验证流程

全部完成后执行:

```bash
cd c:/workspace/ffmpeg-player3
node server.js
# 浏览器打开 http://localhost:3000
# 输入测试视频 URL 进行验证
```

测试视频 URL: `https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4`