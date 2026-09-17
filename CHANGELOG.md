# Changelog

## [1.2.2](https://github.com/mitch308/ffmpeg-mp4-player/compare/v1.2.1...v1.2.2) (2026-09-17)

### Features

* 音量/静音 localStorage 缓存，变化经 postMessage 上报父窗口 ([8f82e79](https://github.com/mitch308/ffmpeg-mp4-player/commit/8f82e79877340062bbee203e81a29732370ecde9))

## [1.2.1](https://github.com/mitch308/ffmpeg-mp4-player/compare/v1.2.0...v1.2.1) (2026-09-17)

### Bug Fixes

* 退出全屏图标更换为设计稿版本，加载期只显示图标不显示文案 ([1d8191c](https://github.com/mitch308/ffmpeg-mp4-player/commit/1d8191c527b23602178499c4d16be8f1e7b231f0))

## [1.2.0](https://github.com/mitch308/ffmpeg-mp4-player/compare/v1.1.0...v1.2.0) (2026-09-16)

### Features

* 服务崩溃重启后播放自动恢复（客户端会话重建） ([9fdb41e](https://github.com/mitch308/ffmpeg-mp4-player/commit/9fdb41e3a5356ade58f00e6f5cdcaac6d7ffc122))
* idle/busy 生命周期事件、getStatus() 状态快照、读泵水位线可配置 ([3112e74](https://github.com/mitch308/ffmpeg-mp4-player/commit/3112e74cbb424a1627f752d3315e24b7397841bc))

### Bug Fixes

* 服务端 TCP keepalive 清理半开连接，防 ffmpeg 残留 ([5296909](https://github.com/mitch308/ffmpeg-mp4-player/commit/52969095245c4eac0a45501e9bb2ecdc283efaea))

## 1.1.0 (2026-09-15)

### Features

* 播放器控制栏 UI（PC 主题 + 共享外壳，移植 etsme-h5 交互） ([ceea4d7](https://github.com/mitch308/ffmpeg-mp4-player/commit/ceea4d7617492b4a6dff9a3b69fa23aac3304af6))
* 播放器图标资产（复制 5 个 + 补齐 3 个）与注入模块 ([d6f7dfb](https://github.com/mitch308/ffmpeg-mp4-player/commit/d6f7dfb97d2dd82ddee6d223902660d7d8bbfc4e))
* 播放器页装配（URL 参数解析 + 静音自动播放策略） ([57527a1](https://github.com/mitch308/ffmpeg-mp4-player/commit/57527a1426e58c2d3181631c3045a46f48a9a9d7))
* 策略链支持画质档与解码模式（阶梯码率/缩放/直通豁免） ([c2c993f](https://github.com/mitch308/ffmpeg-mp4-player/commit/c2c993fe8cdbfdbc0ba3123a2f03f26654402f46))
* 发布配置切自建仓库（[@etsme](https://github.com/etsme) scope + registry，版本从 1.0.0 起） ([6a19078](https://github.com/mitch308/ffmpeg-mp4-player/commit/6a19078f81947064651f37aac93c5357c953d843))
* 发布前自动合并 master 分支（冲突则中止发布） ([3f31023](https://github.com/mitch308/ffmpeg-mp4-player/commit/3f31023db618a071ef9bc2da852ba22c36bd3180))
* 画质菜单低到高排序、单击切播放双击切全屏、音量容器去掉手势指针 ([f8e39b4](https://github.com/mitch308/ffmpeg-mp4-player/commit/f8e39b46fd8ae505d0732cc2d305888bc15acdc8))
* 画质档位纯函数模块（阶梯码率/可用性过滤/缩放尺寸） ([5df3e62](https://github.com/mitch308/ffmpeg-mp4-player/commit/5df3e62cf202cc943e304b554e41c540717de898))
* 会话/流路由支持画质与解码参数，静态服务覆盖 dist/client ([6031a77](https://github.com/mitch308/ffmpeg-mp4-player/commit/6031a772a9302a40ebc59e4e71d21e9902a89e05))
* 会话持久化画质/解码参数并按需重算策略链 ([06a8eb4](https://github.com/mitch308/ffmpeg-mp4-player/commit/06a8eb41536b22099ba72bffc4598429816394b0))
* 前端 TS 构建链（vite client 多入口 + typecheck） ([b664c4e](https://github.com/mitch308/ffmpeg-mp4-player/commit/b664c4eae6b6e1707819929a7de9b53d76b81d3d))
* 统一日志体系——[fmp4] 统一关键字、logger 自定义出口、前端日志经 /api/logs 上报统一输出 ([44c943b](https://github.com/mitch308/ffmpeg-mp4-player/commit/44c943bb661e80db91a4080c060da00641d820d0))
* 移除内置二进制，README/AGENTS 重写，npm 包形态收尾 ([af4f2d9](https://github.com/mitch308/ffmpeg-mp4-player/commit/af4f2d9df65def20bdfe564ceb33517fbdd93c48))
* 引入 release-it 发布工具（自动生成 CHANGELOG + tag + publish） ([da1e933](https://github.com/mitch308/ffmpeg-mp4-player/commit/da1e9335a937452993e7f8dcca6f49384b928ffd))
* 在 package-lock.json 中添加 license 字段 ([dc42b21](https://github.com/mitch308/ffmpeg-mp4-player/commit/dc42b215dd89ccc27346ac2e0f745230649321d1))
* 子进程启动模式（fork + IPC 端口回报 + 跨平台杀进程树） ([3153fc9](https://github.com/mitch308/ffmpeg-mp4-player/commit/3153fc9713ce7a9e0e4595afef2e6958d99a23b6))
* add Express server with session and MSE streaming API ([1a7fe6e](https://github.com/mitch308/ffmpeg-mp4-player/commit/1a7fe6e54448bd209a01b96c242835c419c44144))
* add ffmpeg transcode subprocess wrapper for fMP4 streaming ([31ed652](https://github.com/mitch308/ffmpeg-mp4-player/commit/31ed652ec6cf252cb05a80afce7ef19a7dc7ef4e))
* add ffmpeg/ffprobe cross-platform path detection module ([b66a66a](https://github.com/mitch308/ffmpeg-mp4-player/commit/b66a66ae046950927166dcdb7eb1c7ba0598b6a2))
* add ffprobe metadata extraction module ([c6a64f7](https://github.com/mitch308/ffmpeg-mp4-player/commit/c6a64f756560552e968fadc6aaceb62d7ebaa15c))
* add MSE player logic with precise seek via MediaSource rebuild ([0af2774](https://github.com/mitch308/ffmpeg-mp4-player/commit/0af2774ae42fd9089a2c74416c83531313859236))
* add player HTML page with URL bar, video element, and info section ([4362721](https://github.com/mitch308/ffmpeg-mp4-player/commit/436272123b3ee7d53c50f787d9c91730ba00d3a4))
* add player page CSS styles ([5d833e5](https://github.com/mitch308/ffmpeg-mp4-player/commit/5d833e5d995d7177706d3a9359ccd015e5cd3d96))
* add session manager for MSE streaming sessions ([b4345bd](https://github.com/mitch308/ffmpeg-mp4-player/commit/b4345bd3ea8eeb094c52398ae1dae087e9c9c0c8))
* buildArgs 支持画质档缩放滤镜与 libx264 固定码率 ([df847da](https://github.com/mitch308/ffmpeg-mp4-player/commit/df847da6c2e5229af1f5a46b81ca6b0512b3024b))
* CLI 入口（--port/--host 与环境变量配置，信号优雅退出） ([17d4e70](https://github.com/mitch308/ffmpeg-mp4-player/commit/17d4e70f2eb9505a9368d1c61a4770ef13993dd7))
* demo 页改为 iframe 嵌入播放器并展示嵌入代码 ([d8df0cb](https://github.com/mitch308/ffmpeg-mp4-player/commit/d8df0cbbc376005e7ca8d7bcd95b8f2123233f31))
* format-adaptive strategy chain (copy/hw/sw) with verified MSE compat fixes ([b2093cb](https://github.com/mitch308/ffmpeg-mp4-player/commit/b2093cb236fba7aa069b30d4c897d7148a51a0be))
* iframe 参数支持 volume/mute，首次加载起播前显示 loading，文档同步 ([e7345b9](https://github.com/mitch308/ffmpeg-mp4-player/commit/e7345b910fedd3c43937bc64ca2417d9fee417bf))
* MSE 播放核心迁移 TS（画质/解码参数 + 动作接口） ([c28879a](https://github.com/mitch308/ffmpeg-mp4-player/commit/c28879a96885d7afaf13c33e2e70fe9973279c29))
* PlayerServer 生命周期事件——start/stop/crash，子进程崩溃可监听 ([d2ccba4](https://github.com/mitch308/ffmpeg-mp4-player/commit/d2ccba4b7b1f0a50078beac351e93aa98f43999d))
* startServer API（本进程模式）+ 随机空闲端口选取 + server 工厂化 ([5e63064](https://github.com/mitch308/ffmpeg-mp4-player/commit/5e630641afb22d0be3af7ef527e5d04cb2e9b5b6))

### Bug Fixes

* 补 .embed-code.hidden 规则（首屏嵌入代码块误显示） ([818f97a](https://github.com/mitch308/ffmpeg-mp4-player/commit/818f97af5e080a153c29634d2984417a3f6efc90))
* 控制栏第二行 .left/.right 缺 flex 导致内部元素纵向堆叠 ([39142d8](https://github.com/mitch308/ffmpeg-mp4-player/commit/39142d84ef8b3bce0a7b817a06df7ff9d6609150))
* 流中断自动恢复，从当前播放位置重建流而非终态报错 ([e414b4a](https://github.com/mitch308/ffmpeg-mp4-player/commit/e414b4a8e95badc50aacc94be6a8e8b76f1cbe2f))
* 音量条用手势指针，自动播放不再默认静音 ([ee4ec5a](https://github.com/mitch308/ffmpeg-mp4-player/commit/ee4ec5afd5dd49cea7300f17fd0d40be04a2d1c4))
* 源 URL 的 localhost 重写为 127.0.0.1，规避 Windows 双栈解析导致的 ffmpeg 连接挂死 ([b9ac20c](https://github.com/mitch308/ffmpeg-mp4-player/commit/b9ac20cc26828120311002e8f4fce29d27f1f1a3))
* 最终评审修复波次（README API 契约/clientDir 候选/流画质校验/码率断言/注释收敛） ([a2feb09](https://github.com/mitch308/ffmpeg-mp4-player/commit/a2feb09421726795fe36ed3bda6076f5378e70e7))
* add 15s timeout to ffprobe probe to prevent process leak ([b30b4ba](https://github.com/mitch308/ffmpeg-mp4-player/commit/b30b4ba73828fb8a532504e28dd5d2f8d1495fc5))
* childProcess 模式下显式 ffmpegPath/ffprobePath 在子进程侧重新校验 ([bd7553a](https://github.com/mitch308/ffmpeg-mp4-player/commit/bd7553a3c550937d60ad58bbeb5a60935e02319e))
* clear session.process on natural ffmpeg exit to prevent session leak ([78b1850](https://github.com/mitch308/ffmpeg-mp4-player/commit/78b1850a209be360989e4180a51f10f2aaa95108))
* PC 进度条固定 347px 并与两侧时间留出间距（对齐 PCController.vue） ([4a96e1b](https://github.com/mitch308/ffmpeg-mp4-player/commit/4a96e1bf6e875c1035051a0ded326a498f80b259))
* PC 时间标签自适应宽度防溢出，进度条 flex 占余量并固定 10px 间距 ([8b76aec](https://github.com/mitch308/ffmpeg-mp4-player/commit/8b76aecab7f4dbbf6e22ba0e953cb991650164a4))
* player.css 补全局 box-sizing border-box 重置（移植尺寸隐含此前提） ([38d39b9](https://github.com/mitch308/ffmpeg-mp4-player/commit/38d39b9bf6cb385d50fd4c7998b5677b74bfe8a1))
* seek rebuild loop, forward/backward seek to unbuffered, port 4000 ([0aac950](https://github.com/mitch308/ffmpeg-mp4-player/commit/0aac950c57f151aaca2e529f879695b48da492a6))
* set MediaSource duration, reset rebuilding on error, evict buffer on quota, guard seek without MSE ([03f59b7](https://github.com/mitch308/ffmpeg-mp4-player/commit/03f59b7fd2a3a437baa74b8a8adf6cc17addaa31))
* stop() 先销毁会话再关闭监听防死锁；补 license 字段与子进程 pid 复用守卫 ([71ab235](https://github.com/mitch308/ffmpeg-mp4-player/commit/71ab235358aad38675b7a423bb687adc8cb98ad0))
* **test:** hw-pipeline 跳过改用 vitest ctx.skip()，无 GPU 环境不再误判失败 ([78d6c68](https://github.com/mitch308/ffmpeg-mp4-player/commit/78d6c684e6457627c3b2275bb788932d316eaecf))
