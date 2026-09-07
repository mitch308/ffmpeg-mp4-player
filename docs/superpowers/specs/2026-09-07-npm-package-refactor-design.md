# ffmpeg-mp4-player npm 包化改造设计文档

**日期**: 2026-09-07
**状态**: 已确认
**前置文档**: [2026-08-18-ffmpeg-player-design.md](./2026-08-18-ffmpeg-player-design.md)

## 需求概述

将现有"仓库内自用服务"改造为可发布、可被宿主应用集成的 npm 包：

1. 移除仓库内置的 ffmpeg/ffprobe 二进制（约 744MB），包本身不含下载逻辑，README 指导用户通过 ffmpeg-static / ffprobe-static 或手动下载获取二进制并配置路径
2. 提供初始化/启动方法 `startServer(options)`，支持本进程与子进程两种启动模式
3. 配置项 `childProcess` 决定启动模式
4. 配置项 `port`；未配置时从 20000–30000 区间随机选取空闲端口；启动函数返回最终端口
5. ffmpeg/ffprobe 文件路径可配置（配置项、环境变量、自动探测三级来源）
6. 生命周期 API：返回值含 `stop()`，负责关闭服务、销毁会话、杀 ffmpeg 进程（子进程模式下杀子进程树）
7. 播放器前端 Demo 保留，可配置关闭
8. TypeScript 全面改写，Vite lib mode 统一构建（ESM + CJS 双格式 + d.ts）
9. 测试迁移到 vitest，二进制来自 devDependency 的 ffmpeg-static / ffprobe-static

## 技术选型

- **语言/构建**: TypeScript + Vite lib mode（`express` 与 `node:` 内置模块 external），`vite-plugin-dts` 生成类型
- **模块形态**: ESM + CJS 双格式，Node ≥ 18
- **测试**: vitest；`ffmpeg-static` + `ffprobe-static` 作为 devDependency 提供测试用二进制
- **包内二进制**: 无。运行时二进制来源见"路径解析链"

## 公共 API

```ts
import { startServer } from 'ffmpeg-mp4-player';

interface PlayerServerOptions {
  port?: number;           // 未配置 → 从 20000–30000 随机挑空闲端口
  host?: string;           // 默认 '127.0.0.1'
  childProcess?: boolean;  // 默认 false
  ffmpegPath?: string;     // 不传走解析链（见下）
  ffprobePath?: string;
  staticPlayer?: boolean;  // 默认 true，托管 public/ 播放器页面
}

interface PlayerServer {
  port: number;            // 最终监听端口
  url: string;             // http://host:port
  stop(): Promise<void>;   // 关闭服务 + 销毁全部会话/杀 ffmpeg
                           // 子进程模式下杀子进程树
}

const server = await startServer(options);
await server.stop();
```

### 启动模式

- **本进程模式**（默认）：`startServer` 内部创建 express app 并 `listen`，listen 成功后 resolve 出 `PlayerServer`。`stop()` 关闭 HTTP server 并销毁所有会话（杀掉各会话的 ffmpeg 进程）。
- **子进程模式**（`childProcess: true`）：父进程 `fork` 子进程入口脚本（`src/child.ts` 编译产物），子进程完成 listen 后通过 **IPC 消息**回报 `{ type: 'ready', port }`，父进程收到消息后 resolve；子进程启动失败（崩溃/退出）时 reject。两种模式下 API 调用方式完全一致，调用方无感知。

### 端口选取

- 显式指定 `port` 时直接使用；被占用则报错（不静默换端口）。
- 未指定时在 20000–30000 区间随机取值，用 `net.createServer` 探测空闲后绑定（探测与绑定之间存在竞态，listen 失败则重试，设上限次数）。

## ffmpeg/ffprobe 路径解析链

替换现有 `lib/ffmpeg-path.js` 的"仓库内置目录"逻辑，优先级从高到低：

1. **显式配置**：`options.ffmpegPath` / `options.ffprobePath`
2. **环境变量**：`FFMPEG_PATH` / `FFPROBE_PATH`
3. **自动探测 static 包**：宿主 node_modules 中已安装的 `ffmpeg-static` / `ffprobe-static`
4. **报错**：错误信息说明三级来源并指向 README 安装指引

解析出的路径需验证文件存在且可执行，缺失时按下一级继续；全部落空才报错。

## 目录结构

```
src/
  index.ts          # 公共 API 导出（startServer、类型）
  server.ts         # express app 工厂（从 server.js 改造，不再自行 listen）
  config.ts         # 配置解析、默认值、端口探测
  child.ts          # 子进程入口脚本（listen 后 IPC 回报端口）
  bin.ts            # CLI 入口（npx <pkg> 直接起服务，读环境变量）
  lib/
    ffmpeg-path.ts      # 路径解析链
    ffmpeg-process.ts   # 原 ffmpeg-process.js 转 TS，逻辑不动
    ffprobe.ts
    hw-accel.ts
    session-manager.ts
    stream-strategy.ts
public/             # 播放器前端，纯静态文件原样随包发布（不参与构建）
test/
  *.test.ts         # vitest
docs/
```

### CLI

`package.json` 的 `bin` 字段指向 `bin.ts` 编译产物。行为：解析环境变量（PORT、FFMPEG_PATH 等）后调用 `startServer`，监听 SIGINT/SIGTERM 调 `stop()` 后退出。库模式（被宿主 import）不注册信号处理，信号交给宿主。

## 保持不变的部分

以下为项目踩坑换来的核心逻辑，原样迁移到 TS：

- 策略链 copy → hw → sw，以及"仅策略尚未输出字节时才降级"的约束
- MSE 兼容性约定：`pipe:1`、fMP4 movflags（`frag_keyframe+empty_moov+default_base_moof`）、`-map_chapters -1`、环绕声 AAC 标准声道布局
- QSV 显式解码器路径；Windows 杀进程树用 `taskkill /pid X /T /F`
- 前端水位线（45s 暂停 / 15s 恢复）与流中断自动恢复（`handleStreamFailure`）
- 全部 REST API 路径（`/api/sessions` 等）与响应结构

## README 补充内容

- 安装与快速开始（API 用法 + CLI 用法）
- ffmpeg/ffprobe 获取指引（覆盖 win/mac/linux）：
  - 方式一：`npm i ffmpeg-static ffprobe-static`（装上即被自动探测，零配置）
  - 方式二：手动下载（gyan.dev / BtbN / evermeet 等）后通过 options 或环境变量配置路径
- 全部配置项说明与 `stop()` 生命周期说明

## 测试方案

- vitest 运行全部测试，TS 原生支持
- `test/helpers/samples.ts`：lavfi 样本懒生成逻辑保留
- 二进制定位：setup 阶段从 devDependency 的 `ffmpeg-static` / `ffprobe-static` 解析路径，注入被测模块
- e2e 测试端口从固定 4123 改为随机空闲端口，避免冲突
- `hw-accel.detect` / `hw-pipeline` 测试保留"无 GPU 环境跳过"逻辑
- 新增测试：路径解析链三级优先级、端口随机选取与冲突重试、子进程模式启动/回报/停止、`stop()` 后会话与 ffmpeg 进程清理

## 错误处理

- `startServer` 失败（端口占用、子进程启动失败、二进制缺失）时抛出含明确原因的异常，并保证不留半启动资源（已 spawn 的子进程要杀掉）
- 子进程模式中子进程意外退出：`PlayerServer` 上的 `port` 等字段保持最后已知值；后续请求自然失败，由宿主决定是否重启（与现有"流中断由前端自动恢复"的职责分层一致）

## 非目标（YAGNI）

- 包内不实现二进制下载/解压/校验逻辑
- 不做鉴权、HTTPS、多实例编排
- 不迁移前端到框架/构建工具链，保持纯静态
