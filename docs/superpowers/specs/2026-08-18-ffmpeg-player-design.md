# FFmpeg 播放器设计文档

**日期**: 2026-08-18
**状态**: 已被 2026-09-07 npm 包改造取代（见 `2026-09-07-npm-package-refactor-design.md`）

> 历史注记：本文描述 v1.x 单服务形态。文中 `ffmpeg/`、`ffprobe/` 内置二进制已在 v2.0（npm 包化）移除，并已从 git 全部历史中清除；仓库结构、端口等以 v2.0 文档与源码为准。

## 需求概述

用户在 Web 页面输入视频文件 URL，通过 Node 服务调用 ffmpeg 输出 fMP4 视频流，使用 MSE 在浏览器播放。支持拖拽 seek 到未缓冲区域（结束旧 ffmpeg 进程，精确 seek 重新转码），支持多个并发会话。

## 技术选型

- **后端**: Node.js + Express
- **前端**: 原生 HTML/JS + MediaSource Extensions
- **输出**: 分段 MP4 (fMP4, H.264 + AAC)
- **Seek**: 精确 seek (`-ss` 在 `-i` 之后)
- **多会话**: 独立会话隔离，架构预留共享缓存扩展点

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  index.html                                          │ │
│  │  ┌──────────┐  ┌──────────────────────────────────┐ │ │
│  │  │ URL 输入  │  │  <video> (MediaSource)            │ │ │
│  │  └──────────┘  │  ┌──────────────────────────────┐ │ │ │
│  │                │  │  SourceBuffer (fMP4 chunks)   │ │ │ │
│  │  ┌──────────┐  │  └──────────────────────────────┘ │ │ │
│  │  │ 进度条    │  └──────────────────────────────────┘ │ │ │
│  │  │ 缓冲区域  │                                        │ │ │
│  │  └──────────┘                                        │ │ │
│  └─────────────────────────────────────────────────────┘ │
│         │  HTTP GET /stream    │  POST /seek              │
└─────────┼─────────────────────┼──────────────────────────┘
          │                      │
┌─────────┼─────────────────────┼──────────────────────────┐
│  Express Server                                             │
│  ┌──────┴──────────────────────┴───────────────────────┐  │
│  │  SessionManager                                      │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │  │
│  │  │ Session1 │  │ Session2 │  │ Session3 │  ...     │  │
│  │  │ ffmpeg   │  │ ffmpeg   │  │ ffmpeg   │          │  │
│  │  │ process  │  │ process  │  │ process  │          │  │
│  │  └──────────┘  └──────────┘  └──────────┘          │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌──────────┐  ┌──────────────────┐                       │
│  │ ffprobe  │  │ Temp file cache  │  (预留共享缓存扩展)    │
│  └──────────┘  └──────────────────┘                       │
└──────────────────────────────────────────────────────────┘
```

## API 设计

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sessions` | 创建会话，返回 `{ sessionId }` |
| `GET` | `/api/sessions/:id/stream?url=...&start=0` | 获取 fMP4 流（chunked），启动或重新定位 ffmpeg |
| `GET` | `/api/sessions/:id/probe?url=...` | 获取视频元信息（时长、分辨率、编解码器） |
| `DELETE` | `/api/sessions/:id` | 销毁会话，kill ffmpeg，清理资源 |

## Seek 流程

```
用户拖拽进度条
  → 前端 abort 当前 GET /stream 请求
  → 前端 GET /stream?url=...&start=<新位置>
  → 服务端 kill 旧 ffmpeg 进程
  → 服务端启动新 ffmpeg -ss <新位置> -i <url> ...
  → 前端清除 MediaSource 旧 buffer
  → 前端接收新 stream，追加到 SourceBuffer
```

## ffmpeg 命令

```
ffmpeg -ss <start_time> -i <url> \
  -force_key_frames expr:eq(n,0) \
  -c:v libx264 -c:a aac \
  -f mp4 \
  -movflags frag_keyframe+empty_moov+default_base_moof \
  -preset ultrafast -tune zerolatency \
  -pipe:1
```

## 项目结构

```
ffmpeg-player3/
├── package.json
├── server.js                # Express 入口
├── lib/
│   ├── session-manager.js   # 会话管理
│   ├── ffmpeg-process.js    # ffmpeg 进程封装
│   └── ffprobe.js           # 元数据提取
├── public/
│   ├── index.html           # 播放器页面
│   ├── player.js            # MSE 播放器逻辑
│   └── style.css            # 样式
└── ffmpeg/                  # 已有二进制文件（v1.x 时代；v2.0 已移除并从 git 历史清除）
```

## 关键设计决策

### 1. 为什么用 fMP4 + MSE 而不是直接 pipe MP4

- 边转码边播放，无需等待完整文件
- 精确 seek 时只需重新建立 MediaSource，无需下载完整 moov atom
- 浏览器原生支持度高

### 2. 为什么 ffmpeg `-ss` 放在 `-i` 之后

- 放在 `-i` 之前是 input seeking（快速但不精确，跳到最近关键帧）
- 放在 `-i` 之后是 output seeking（精确到帧，稍慢但位置准确）
- 用户选择了精确 seek

### 3. Session 生命周期

- 创建时生成 UUID
- 5 分钟无活动自动清理（可配置）
- 客户端断开连接时异步清理
- DELETE 接口手动销毁

### 4. 错误处理

- 无效 URL → 400 错误
- ffmpeg 进程异常退出 → 500 + stderr 信息
- 浏览器不支持 MSE → 前端提示降级
- SourceBuffer 满 → 暂停 append 等待 `updateend` 事件

## 测试策略

- 单元测试：session-manager 的创建/销毁/超时逻辑
- 集成测试：ffmpeg 进程启动/输出/退出
- 手动测试：多浏览器标签页同时播放不同视频
- 边界测试：seek 到视频末尾、seek 到 0、极短视频