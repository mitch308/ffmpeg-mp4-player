# AGENTS.md

## 常用命令

- `npm start` — 启动服务端（`server.js`）；端口用 `PORT` 环境变量（默认 4000）
- `npm test` — 运行 `node --test "test/*.test.js"`（Node 内置测试运行器）
- 跑单个测试文件：`node --test test/ffmpeg-process.test.js`
- 没有配置 lint/typecheck。运行时唯一依赖是 `express`（无构建步骤）。
- `FFMPEG_HW_ENCODER=none npm start` 强制软件编码；也可设为具体编码器名（如 `h264_qsv`）。不设置时探测顺序：nvenc > qsv > amf > vaapi > videotoolbox > libx264。

## 内置的 ffmpeg/ffprobe

二进制文件直接放在仓库内：`ffmpeg/<平台>/<架构>/` 和 `ffprobe/<平台>/<架构>/`（平台：win/mac/linux；架构：x64/ia32/arm64），由 `lib/ffmpeg-path.js` 根据 `os.platform()`/`os.arch()` 解析。绝不要调用系统 `ffmpeg`/`ffprobe` 或硬编码路径——一律通过 `getFfmpegPath()`/`getFfprobePath()`。

## 架构

调用链：`server.js`（Express API）→ `lib/session-manager.js`（内存 sessions Map，5 分钟空闲清理）→ `lib/ffmpeg-process.js`（spawn；fMP4 通过 stdout 输出）。

- `lib/stream-strategy.js` 和 `ffmpeg-process.js` 里的 `buildArgs` 是纯函数——新的决策逻辑放在这里，便于单测。
- 每个会话的策略链：copy（remux 直通）→ hw（硬编）→ sw（软编），只在策略**尚未输出任何字节**时失败才降级（把两份 fMP4 混进同一响应流会损坏数据）。
- 输出不变式：视频恒为 H.264；音频为 AAC（拷贝或转码）或不存在。源必须是 H.264 8bit yuv420p 才有直通资格。
- 硬件编码采用「混合」管线（`-hwaccel` 硬解提示 + 硬件编码器）；全 GPU 帧驻留方案已实测并被有意放弃（见 `lib/hw-accel.js` 注释）。

## 踩坑记录

- Windows 上杀 ffmpeg 必须用 `taskkill /pid X /T /F`（杀进程树）；直接 `proc.kill()` 会留孤儿进程。用 `ffmpeg-process.js` 里现成的异步 spawn 写法——不要改成同步。
- Seek = 杀旧 ffmpeg + 带 `-ss` 重新拉起。新的流请求不能杀掉不是自己启动的进程：调用方需比较 `session.process` 身份（见 `server.js` 的 close handler）。
- ffmpeg 自然退出时必须清掉 `session.process = null`，否则空闲清理定时器会无限续期，导致会话泄漏。
- stdout 管道必须用 `pipe:1`（不能是 `-`），且要用 fMP4 的 movflags（`frag_keyframe+empty_moov+default_base_moof`）；普通 mp4 输出到管道会破坏 MSE。
- 必须带 `-map_chapters -1`：MKV 章节表会被 mov muxer 写成 QuickTime 章节文本轨（`gmhd`+`tref chap`），Chrome MSE 的 fMP4 解析器拒绝含该轨的 init segment。
- 环绕声源转 AAC 必须经 `aformat=channel_layouts=5.1/7.1` 强制标准布局：ffmpeg AAC 编码器对 `5.1(side)` 等布局会写出 `channelConfiguration=0`（声道信息放 PCE）的 ASC，Chrome MSE 拒绝。立体声/单声道源不需要。
- 以上两类问题在浏览器端均只表现为 `CHUNK_DEMUXER_ERROR_APPEND_FAILED`（UI 上是泛泛的"播放错误"），服务端与 console 都无报错——遇到"播放失败但无日志"先用无头浏览器对 init segment 做最小 append 实验。
- QSV 硬解必须用显式解码器（`-c:v hevc_qsv` 等，见 `hw-accel.js` 的 `decoderByCodec`），不要用 `-hwaccel qsv` 提示：提示路径 + 硬件编码器组合存在每帧表面泄漏（内存 ~48MB/s 增长，数分钟后 ffmpeg 无声崩溃，表现为播放中途断流且无任何日志）；显式解码器稳定且约 3-4x 实时。其他厂商（nvenc/amf）未经本机验证，暂保留 -hwaccel 提示。
- 客户端 `pumpReader` 的水位线（45s 暂停 / 15s 恢复）不能删：转码速度远快于实时，若无水位线会撑爆 Chrome MSE 配额（4K 片约 117 秒 ≈ 150MB），之后 appendBuffer 连续 QuotaExceededError 走静默丢 chunk 分支，buffered 出现空洞、播放头撞洞永久卡死（表现为"播放到某处停止且无任何报错"）。
- 客户端流中断走自动恢复（`handleStreamFailure`：从当前播放位置重建流，连续 4 次失败才报错），不要改回直接 setError：数小时长片播放中瞬时网络抖动（切后台被系统/浏览器切断、休眠唤醒等）是常态，终态报错等于播放报废。

## 测试

测试会拉起**真实的 ffmpeg** 进程：`test/helpers/samples.js` 懒生成 lavfi 样本到临时目录（1 秒短片；每次运行内缓存）。e2e 测试会启动真实 server（端口 4123）。`hw-accel.detect.test.js` 和 `hw-pipeline.test.js` 依赖本机 GPU/驱动——那里的硬件相关失败可能是环境问题，而非代码 bug。

## 约定

- 注释、日志、测试名都用中文。保持同一风格。
