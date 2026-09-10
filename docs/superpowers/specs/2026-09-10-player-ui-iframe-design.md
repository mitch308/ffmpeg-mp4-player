# 播放器 UI 改版 + iframe 嵌入 + 画质/解码设置 设计文档

日期：2026-09-10
状态：待评审

## 1. 背景与目标

当前 `public/` 的 demo 页是原生 `<video controls>` + 简陋 loading/error 覆盖层。目标：

1. 播放器 UI 参照 etsme-h5 项目 `app-base/components/src/components/file-preview/video-preview/`（下称「参考组件」）的视觉与交互重做。
2. 播放器支持作为 **iframe 嵌入**：视频 URL 等经 URL 参数传入，供其它项目复用。
3. 本项目 demo 页（`index.html`）改为通过 iframe 嵌入该播放器。

### 明确的范围裁决（用户已确认）

- **两套控制器都要**：参考组件默认的 TVController（TV 大字号风格）与 PCController（PC 紧凑风格）都移植，经 URL 参数 `ui=pc|tv` 切换，默认 pc。
- **控制栏功能保留**：倍速、画面比例、全屏、画质、解码设置。
  - **画质**为真功能：档位 720p / 1080p / 2K / 原画质；只展示原画质与**严格低于源分辨率**的档位；各档位固定码率，切换时后端按新码率重转码。
  - **解码设置**为真功能：硬解 / 软解；默认优先硬解；硬解不可用时（部署机无硬件编码器）前端不显示硬解选项。
  - **画面比例**为纯前端 CSS 处理（原始 / 16:9 / 4:3，照搬参考组件 WebPlayer.vue 的容器查询实现），后端输出画面尺寸不变。
- **iframe 参数为基础参数集**（无 postMessage 接口）：`url`（必需）、`title`、`ui`、`quality`、`mode`、`autoplay`。
- **码率阶梯（推荐方案）**：720p→2.5Mbps、1080p→5Mbps、2K→10Mbps、原画质→现行逻辑（可直通则 copy，否则 0.1bpp 启发式）。
- **参考组件中"解码设置/画质"原本只是摆设**，本设计将其落实为真功能。

## 2. 参照组件分析

参考组件结构：`VideoPlayer.vue`（外壳：交互层 + 顶栏 + loader + 控制栏调度）→ `WebPlayer.vue`（video 元素 + 画面比例容器查询）→ `controller/TVController.vue` 与 `PCController.vue`（两套控制器）+ `Icons/*.vue`（5 个 SVG 图标）+ `store/use-player.ts`（播放状态）。

需移植的核心视觉/交互：

| 项 | 参考组件行为 |
|---|---|
| 顶栏 | 毛玻璃渐变背景（`linear-gradient(90deg, rgba(123,123,155,.5), rgba(42,42,53,.5))` + `backdrop-filter: blur(90px)`），slide-up 过渡 |
| 控制栏 | TV：通栏底部 `rgba(51,51,51,.9)`；PC：520px 居中悬浮圆角条、同背景色 |
| 主色 | `#59b9ff`（进度条、loader spinner、thumb） |
| 自动隐藏 | 200ms 节流 mousemove 显示；播放中 3s 隐藏；5s 无操作隐藏；暂停常显；单击切控制栏/双击切播放；触屏 touchstart 逻辑同单击 |
| loader | 48px 蓝色圆环 spinner（`#59b9ff`，1s 旋转） |
| ext 面板 | 控制栏上方展开：画质 / 倍速 / 更多设置（画面比例 + 解码设置），带标题 + 分割线 + 返回键 |
| 画面比例 | 容器查询实现 contain 效果：`@container video-player (max-aspect-ratio: …)` |
| 键盘 | ↑↓ 音量 ±0.05，←→ seek ±5s（Mousetrap 实现，本项目用原生 keydown 等价实现） |
| 音量条 | PC：宽 95px、thumb 8px、hover 百分比 tips；TV：宽 200px、60px 高 |
| 图标 | IconPlay / IconPause / IconVolumeMute / IconVolumeUnMute / IconCog（1em SVG，currentColor）；另需补充 arrow-down（ext 返回）、全屏进/出两个图标（参考组件用 et-icon/ant-design 图标） |

不移植：Vue 响应式 store、Mousetrap 依赖、ant-design Tooltip（PC 用原生 `title` 属性）、localStorage 音量记忆（iframe 场景可简化，保留也不影响）。

## 3. iframe 播放器页设计

### 3.1 前端源码结构与构建（TypeScript + Vite）

前端从无构建原生 JS 改为 **TypeScript 源码 + Vite 构建**：

```
src/client/                → 前端 TS 源码
  player-entry.ts          → 播放器页入口（读 URL 参数、装配 UI + MSE 核心）
  player-core.ts           → MSE 核心管线（自现 public/player.js 演进：保留
                             水位线/自动恢复/seek 重建/QuotaExceeded 处理，
                             增加 quality/mode 请求参数；暴露 play/pause/seek/
                             setVolume/setQuality/setMode/setRate 接口与状态回调）
  player-ui.ts             → 控制栏 UI：双主题渲染、控制栏显隐、进度条拖拽、
                             音量、倍速/画质/比例/解码 ext 面板、键盘、全屏
  player.html / player.css → 播放器页模板与样式（PC/TV 双主题经根元素 class 切换）
  icons/*.svg              → 复制的图标（静态文件，<img> 引用会丢 currentColor，
                             改为启动时 fetch 后以 inline SVG 注入 DOM）

public/                    → demo 页（无构建，保持原生）
  index.html / style.css   → demo 页：URL 输入 + iframe 嵌入展示 + 嵌入代码片段
```

构建（Vite 多入口，产出进 `dist/client/`）：

- 新增 `vite.config.client.ts`：`root: 'src/client'`，rollupOptions.input 为
  `player.html`；`build.outDir: '../../dist/client'`；静态资源（css 由 html link、
  icons）随构建拷贝。
- `package.json` 的 `build` 脚本追加 `vite build -c vite.config.client.ts`；
  `files` 数组把 `public` 换成 `dist/client`（public 只剩 demo 页，仍保留发布）。
- `.gitignore` 补 `dist/` 已有，无需改。
- server.ts 的静态目录逻辑不变（`public/`）；**demo 页与 server 部署在同源时，
  `/player.html` 不可用**——需要新增静态路由把 `/player.html`、`/player.css`、
  `/player.js`、`/icons/*` 同时映射到 `dist/client/`（express.static 多目录 fallback，
  顺序 public → dist/client），这样单进程部署时 demo 页 iframe 直接可用。
- TS 配置沿用根 tsconfig（DOM lib 需确认，前端入口单独 tsconfig 若必要）。

### 3.2 URL 参数约定

`GET /player.html?url=<encoded>&title=&ui=pc|tv&quality=auto|720p|1080p|2k|origin&mode=auto|hw|sw&autoplay=0|1`

注：`/player.html` 由 server 从 `dist/client/` 静态服务（见 3.1 构建一节）。

| 参数 | 默认 | 说明 |
|---|---|---|
| `url` | 必需 | 视频地址（encodeURIComponent 后传入） |
| `title` | 空 | 顶栏标题 |
| `ui` | `pc` | 控制器主题 `pc` / `tv` |
| `quality` | `origin` | 初始画质档 |
| `mode` | `auto` | 转码/解码模式 `auto`（现行逻辑）/ `hw`（强制硬编，失败降级 sw）/ `sw`（强制软件） |
| `autoplay` | `1` | 浏览器策略限制：**先静音自动播放**；用户点音量图标或拖音量条解除静音。`autoplay=0` 时不自动播 |

注：iframe 嵌入方需 `allow="autoplay; fullscreen"`。全屏 API 在 iframe 内需父页面 allow 列表授权。

### 3.3 交互规范（照抄参考组件参数）

- 控制栏显隐：200ms 节流 mousemove / touchstart；播放中 3s 后隐藏；无操作 5s 后隐藏；暂停时显示并取消隐藏定时器。
- 单击画面：控制栏已显示 → 切换显示/隐藏；未显示 → 显示。双击画面：切播放/暂停。
- ext 面板：TV 在控制栏上方整宽展开（translate3d 过渡）；PC 在 520px 条内部向上展开（height 过渡）。
- 键盘：←→ ±5s；↑↓ 音量 ±0.05（仅播放器页内部监听，不劫持父页面）。

## 4. 服务端设计

### 4.1 新增 `src/lib/quality.ts`（纯函数，单测）

```ts
export type QualityLevel = '720p' | '1080p' | '2k' | 'origin';

// 档位定义：目标高度 + 固定码率
QUALITY_TIERS = { '720p': {height:720, kbps:2500}, '1080p': {height:1080, kbps:5000}, '2k': {height:1440, kbps:10000} }

availableQualities(probe) → QualityLevel[]
// 源高度 > 1440 → [720p, 1080p, 2k, origin]
// 源高度 > 1080 → [720p, 1080p, origin]
// 源高度 > 720  → [720p, origin]
// 否则          → [origin]

dimsFor(level, probe) → {width, height} | null
// 按源宽高比等比缩放到目标高度，宽高均向下取偶（硬件编码器要求）；
// 不使用 ffmpeg 滤镜的 -2 表达式（QSV 等路径需要显式偶数尺寸）
```

### 4.2 `stream-strategy.ts` 扩展（保持纯函数）

`strategyChain(probe, caps, opts?: { quality?: QualityLevel; mode?: 'auto'|'hw'|'sw' })`：

- `quality !== 'origin'`：跳过 copy（画质档必然重编码），videoBitrate 取阶梯值，strategy 新增 `scale: {width, height}`；输出尺寸由 scale 滤镜决定。
- `mode === 'sw'`：跳过 copy、强制 libx264（显式选择 = 明确要走软件路径，含源可直通时——用户选了软解软编）。
- `mode === 'hw'`：跳过 copy、硬件编码器优先，链上保留 libx264 作降级兜底（现行降级逻辑不变：仅未输出字节时降级；部署机本就无硬编时等价于直接 libx264）。
- `mode === 'auto'` 或缺省：**完全现行行为**（copy 资格则 copy → 转码）。
- `quality === 'origin' && mode === 'auto'`：现行策略链原样，码率维持 0.1bpp 启发式。
- 阶梯画质下 libx264 也改用 `-b:v/-maxrate/-bufsize`（固定码率阶梯，不再 CRF 23）；`origin` 转码保持 CRF 不变。
- audio 策略（copy/aac/none、声道布局）不受影响。

Strategy 类型新增字段：`scale?: { width: number; height: number } | null`。

### 4.3 `ffmpeg-process.ts` buildArgs 扩展

- `strategy.scale` 存在时追加 `-vf scale=W:H`。
  - **QSV 风险**：显式 qsv 解码器路径帧驻留 GPU，普通 `scale` 滤镜会触发自动 hwdownload（可用但多余拷贝）；若实测报错则改 `scale_qsv`（仅 qsv profile 加，放 EncoderProfile 新字段 `scaleFilter`）。实施时以真实 ffmpeg 验证。
  - nvenc/amf/vaapi 混合管线路径帧在系统内存（-hwaccel 提示 + 自动回退），`scale` 可用。
- 阶梯码率（`strategy.videoBitrate` 来自阶梯）时 libx264 走 `-b:v/-maxrate/-bufsize`，不再 CRF。

### 4.4 API 变更（向后兼容，不带参数 = 现行为）

`POST /api/sessions` 请求体新增可选 `quality`、`mode`（缺省分别为 `origin`、`auto`）：

- 非法值 400；`quality` 需在 `availableQualities(probe)` 结果内（如 720p 源选 1080p → 400）。
- 响应新增：`qualities: QualityLevel[]`（可用档位列表，前端据此渲染菜单）、`hwAvailable: boolean`（部署机编码器非 libx264，前端据此决定是否显示"硬解"选项）、`requestedQuality`/`requestedMode` 回显。

`GET /api/sessions/:id/stream?start=&quality=&mode=`：

- 可选 `quality`/`mode`；非法值 400。
- 请求参数持久化到 session（`requestedQuality`/`requestedMode`），后续不带参数的流请求（seek、断线自动恢复重连）沿用最后设置——否则自动恢复会静默跳回原画质。

会话策略链：`startStream` 时按当前 `requestedQuality/Mode` 调 `strategyChain` 重新计算（会话创建时算好的链仅在 auto/origin 下使用；参数变更 = 换链）。降级语义不变。

### 4.5 画质/模式切换的前端路径

与 seek 同路径（已验证的设计复用）：

1. 用户在 ext 面板选画质/解码 → `teardownMediaSource()` → 从当前 `video.currentTime` 带 `quality`/`mode` 参数重新拉 `/stream`。
2. 服务端 kill 旧 ffmpeg、按新参数重算策略链重启转码；前端重建 MediaSource、`timestampOffset` 对齐原片位置。
3. 自动恢复（`handleStreamFailure`）重连时带上会话当前参数，不回退。

## 5. demo 页改造

`index.html` 保留：URL 输入 + 加载按钮。点击后：生成 `player.html?url=...&title=文件名` 设为 iframe `src`（`allow="autoplay; fullscreen"`），并在页面下方展示可复制的嵌入代码片段（含 encodeURIComponent 后的完整 URL）。原调试信息栏（时长/分辨率/编码/方式）移除（相关信息在播放器内不再展示；需要时看 `/api/status`）。

## 6. 测试计划

- 新增 `test/quality.test.ts`：档位过滤（各源高度边界）、尺寸计算（比例保持 + 偶数对齐）、码率表。
- `test/stream-strategy.test.ts`：opts 组合——sw 跳过 copy、hw 链含 libx264 兜底、阶梯码率、scale 字段、auto/origin 与现行为一致（回归）。
- `test/ffmpeg-process.test.ts`：buildArgs 断言 `-vf scale=W:H`、阶梯码率下 libx264 用 `-b:v` 而非 `-crf`。
- `test/server.test.ts`：POST 响应含 qualities/hwAvailable；非法 quality/mode 400；stream 非法参数 400；参数持久化；`/player.html` 可访问。
- `test/e2e.test.ts`：真实 ffmpeg 拉 `quality=720p` 流，ffprobe 验证输出高度 720、码率量级正确；`mode=sw` 输出 libx264。
- 前端为构建产物（dist/client），不单独跑前端单测；交互靠手工验证清单（写入 README）：PC/TV 两主题、控制栏显隐各场景、倍速/画质/比例/解码切换、静音自动播放、iframe 嵌入示例页。

## 7. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| QSV 显式解码路径加缩放滤镜未验证 | 实施时先实测 `scale`（hwdownload 自动插入）→ 失败改 `scale_qsv`（EncoderProfile 加 `scaleFilter` 字段）；仍失败则 qsv 缩放路径降级 sw 解码 + sw scale + 硬编 |
| nvenc/amf/vaapi/videotoolbox 的缩放未在本机验证 | 与现状一致的"失败沿策略链降级"语义覆盖（未输出字节时） |
| 阶梯画质切换的等待体验（杀流重启 + 转码起播延迟） | 复用现有 loading spinner + 状态文案；画质档转码快于实时，预期可接受 |
| 硬解/软解术语（前端按钮）实指硬编/软编 | UI 文案按用户语言"硬解/软解"，实际控制编码路径（mode 参数）；文档注明 |
| autoplay 被浏览器拦截 | 默认静音自动播放（业界通行），点音量解除；`autoplay=0` 可关 |

## 8. 不做的事

- 前端不做 postMessage 双向控制接口（用户选基础参数集）。
- 前端不引入运行时框架（Vue/React）；纯 TS + DOM。
- 前端不独立起 dev server；构建产物为静态文件。
- 不做多码率自适应（HLS/DASH）；画质为手动选择。
- 不改变输出不变式：视频恒 H.264、音频恒 AAC（或无）。
- 不移植参考组件的"解码设置=纯摆设"行为，而是落实为真功能。
- 不移植 Vue 响应式/store/ant-design Tooltip/Mousetrap 依赖。