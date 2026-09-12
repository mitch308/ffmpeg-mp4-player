// src/client/player-core.ts — MSE 播放核心：会话管理、fMP4 流式播放、精确 seek（重建 MediaSource）。
// 自 public/player.js 迁移：DOM 解耦为回调；流请求携带 quality/mode（画质档/解码模式）。
//
// 设计要点（沿袭原实现，勿改）：
// - 服务端固定输出 H.264 fMP4（frag_keyframe+empty_moov+default_base_moof），
//   SourceBuffer codec 恒取 H.264 候选 + AAC-LC。
// - 每次流请求触发服务端 kill 旧 ffmpeg 并从新位置重转码，时间线从 0 起算 →
//   seek/换档必须重建 MediaSource（timestampOffset 对齐原片位置）。
// - pumpReader 水位线（45s 暂停 / 15s 恢复）不能删：转码快于实时，无水位线会
//   撑爆 MSE 配额 → QuotaExceededError 静默丢 chunk → buffered 空洞永久卡死。
// - 流中断走自动恢复（连续 4 次失败才报错）：长片瞬时网络抖动是常态。

export type QualityId = 'origin' | '720p' | '1080p' | '2k';
export type ModeId = 'auto' | 'hw' | 'sw';

export interface SessionMeta {
  sessionId: string;
  duration: number;
  width: number;
  height: number;
  codec: string;
  audioCodec: string | null;
  pixFmt: string;
  streamMode: string;
  encoder: string | null;
  qualities: QualityId[];
  hwAvailable: boolean;
}

export interface PlayerCoreCallbacks {
  /** 过程性状态文案（seek/恢复/切换中） */
  onStatus?(msg: string): void;
  /** 终态错误（UI 展示后不可恢复） */
  onError?(msg: string): void;
  /** 加载态变化（true = 显示 loader） */
  onLoading?(loading: boolean): void;
}

// 候选 codec：服务端输出恒为 H.264（直通保留源 profile/level，故候选覆盖高级别）；
// 音频存在时恒为 AAC-LC（mp4a.40.2）
const VIDEO_CODECS = [
  'avc1.42E01E', // Baseline 3.0
  'avc1.4d401e', // Main 3.0
  'avc1.640028', // High 4.0
  'avc1.640029', // High 4.1
  'avc1.640032', // High 5.0
  'avc1.640033'  // High 5.1
];

function pickCodec(hasAudio: boolean): string {
  const suffix = hasAudio ? ',mp4a.40.2' : '';
  const fallback = 'video/mp4; codecs="' + VIDEO_CODECS[0] + suffix + '"';
  if (window.MediaSource && typeof MediaSource.isTypeSupported === 'function') {
    for (const c of VIDEO_CODECS) {
      const mime = 'video/mp4; codecs="' + c + suffix + '"';
      if (MediaSource.isTypeSupported(mime)) return mime;
    }
  }
  return fallback;
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return pad(h) + ':' + pad(m) + ':' + pad(sec);
}

export class PlayerCore {
  readonly video: HTMLVideoElement;
  readonly meta: SessionMeta;
  quality: QualityId;
  mode: ModeId;

  private cb: PlayerCoreCallbacks;
  private gen = 0;                 // 代次令牌，使在途异步操作失效
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectURL: string | null = null;
  private abortController: AbortController | null = null;
  private pendingBuffers: ArrayBuffer[] = [];
  private rebuilding = false;      // MediaSource 重建期间，抑制 seeking 处理
  private selfSeeking = false;     // 程序化设置 currentTime 标志，onSeeking 消费一次
  private autoPlay = false;        // canplay 后是否自动续播
  private networkFailStreak = 0;   // 连续网络失败次数（收到数据即清零）
  private destroyed = false;

  private constructor(meta: SessionMeta, quality: QualityId, mode: ModeId, cb: PlayerCoreCallbacks) {
    this.meta = meta;
    this.quality = quality;
    this.mode = mode;
    this.cb = cb;
    this.video = document.createElement('video');
    this.video.preload = 'auto';
    this.bindVideoEvents();
    window.addEventListener('beforeunload', this.onBeforeUnload);
  }

  /** 创建会话（POST /api/sessions）并构造播放核心 */
  static async create(
    url: string,
    opts: { quality?: QualityId; mode?: ModeId } = {},
    cb: PlayerCoreCallbacks = {}
  ): Promise<PlayerCore> {
    const resp = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality: opts.quality ?? 'origin', mode: opts.mode ?? 'auto' })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}) as { error?: string });
      throw new Error(err.error || 'HTTP ' + resp.status);
    }
    const meta = await resp.json() as SessionMeta;
    return new PlayerCore(meta, opts.quality ?? 'origin', opts.mode ?? 'auto', cb);
  }

  // ===== 对 UI 暴露的动作 =====

  /** 从给定 start 秒建立 MediaSource 并拉流（首次加载入口） */
  start(startAt = 0, autoplay = true): void {
    this.autoPlay = autoplay;
    // 首次加载到 canplay 前显示 loading（与 seek/换档同路径；canplay 统一回调关闭）
    this.cb.onLoading?.(true);
    this.startStreamAt(startAt);
  }

  /** 用户 seek：写入 currentTime，由 seeking 监听判定缓冲内/外（外 → 重建流） */
  seek(t: number): void {
    this.video.currentTime = t;
  }

  /** 切换画质档/解码模式：与 seek 同路径（杀流重建），从当前位置继续 */
  restartWith(quality: QualityId = this.quality, mode: ModeId = this.mode): void {
    const changed = quality !== this.quality || mode !== this.mode;
    this.quality = quality;
    this.mode = mode;
    if (!changed) return;
    const t = this.video.currentTime;
    const wasPlaying = !this.video.paused && !this.video.ended;
    this.teardownMediaSource();
    this.autoPlay = wasPlaying;
    this.cb.onStatus?.('正在切换…');
    this.cb.onLoading?.(true);
    this.startStreamAt(t);
  }

  /** 销毁：断流 + 删除服务端会话 */
  async destroy(): Promise<void> {
    this.destroyed = true;
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.teardownMediaSource();
    try {
      await fetch('/api/sessions/' + encodeURIComponent(this.meta.sessionId), { method: 'DELETE' });
    } catch { /* 忽略：服务端 5min 超时会兜底清理 */ }
  }

  // ===== 内部：MediaSource 生命周期 =====

  private teardownMediaSource(): void {
    this.gen++; // 使所有在途异步操作失效
    this.selfSeeking = false; // 复位自激标志，防止上次程序化 seek 未被消费而残留
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* 已中止 */ }
      this.abortController = null;
    }
    this.pendingBuffers = [];
    this.sourceBuffer = null;
    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
      } catch { /* 已关闭 */ }
      this.mediaSource = null;
    }
    if (this.objectURL) {
      URL.revokeObjectURL(this.objectURL);
      this.objectURL = null;
    }
  }

  private startStreamAt(start: number): void {
    const myGen = this.gen;
    const codec = pickCodec(!!this.meta.audioCodec);

    this.rebuilding = true;
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectURL = URL.createObjectURL(ms);
    this.video.src = this.objectURL;
    this.video.load();

    const onOpen = (): void => {
      ms.removeEventListener('sourceopen', onOpen);
      if (myGen !== this.gen) return; // 已过期
      let sb: SourceBuffer;
      try {
        sb = ms.addSourceBuffer(codec);
      } catch (e) {
        this.fail('不支持的视频编码: ' + (e as Error).message);
        return;
      }
      this.sourceBuffer = sb;
      sb.mode = 'segments';
      // 关键：seek/换档重建后新 ffmpeg 流的时间戳从 0 重新起算（-ss 重置了时间线），
      // 用 timestampOffset 偏移到原片位置，使 video.currentTime 恒反映原片真实位置。
      // 初始加载 start=0，offset=0 无副作用。
      try { sb.timestampOffset = start; } catch { /* 部分 SB 不支持 */ }
      // MediaSource 时长设为原片总时长，使进度条覆盖整片范围
      try { ms.duration = this.meta.duration; } catch { /* 忽略 */ }
      // 关键：video.load() 后 currentTime 通常被重置为 0，而 timestampOffset 让新缓冲区
      // 从 start 开始 → 播放头停在 0 会落在缓冲区外 → 永远 waiting 不播放。
      // 必须把播放头拨回 start。该程序化赋值触发 seeking：用 selfSeeking 标志
      // 识别自触发（而非用户拖拽），跳过重建防无限循环。标志在 onSeeking 顶部消费。
      if (start > 0) {
        try {
          this.selfSeeking = true;
          this.video.currentTime = start;
        } catch {
          this.selfSeeking = false;
        }
      }
      sb.addEventListener('updateend', () => this.pumpBuffer());
      sb.addEventListener('error', (e) => {
        if (myGen !== this.gen) return;
        // error 事件规范上是普通 Event，但部分实现会在 target 上挂 error 属性；
        // 受控窄化尽量带出细节，拿不到保持固定文案
        const detail = (e.target as (EventTarget & { error?: { message?: string } }) | null)?.error?.message;
        this.fail(detail ? '解码错误: ' + detail : '解码错误');
      });

      this.fetchStream(start, myGen);
    };
    ms.addEventListener('sourceopen', onOpen);
  }

  private fetchStream(start: number, myGen: number): void {
    this.abortController = new AbortController();
    // 显式携带当前画质档/解码模式：服务端持久化到会话，
    // 断线自动恢复的重连请求不带参数也沿用（不会静默跳回原画质）
    const url = '/api/sessions/' + encodeURIComponent(this.meta.sessionId) +
      '/stream?start=' + encodeURIComponent(start) +
      '&quality=' + this.quality + '&mode=' + this.mode;

    fetch(url, { signal: this.abortController.signal })
      .then(resp => {
        if (myGen !== this.gen) return;
        if (!resp.ok) { this.fail('流请求失败: HTTP ' + resp.status); return; }
        if (!resp.body) { this.fail('浏览器不支持流式响应'); return; }
        return this.pumpReader(resp.body.getReader(), myGen);
      })
      .catch((e: Error) => {
        if (myGen !== this.gen) return;
        if (e.name !== 'AbortError') this.handleStreamFailure(myGen);
      });
  }

  // 流中断自动恢复：长片播放中瞬时网络抖动（切后台被系统切断、休眠唤醒等）不应终局。
  // 从当前播放位置重建流（与 seek 同路径），连续失败超限才报错
  private handleStreamFailure(myGen: number): void {
    if (myGen !== this.gen) return; // 已有新流接管（如用户 seek）
    if (this.networkFailStreak >= 4) {
      this.fail('流中断且自动恢复失败，请重新加载');
      return;
    }
    this.networkFailStreak++;
    const resumeAt = this.video.currentTime;
    const wasPlaying = !this.video.paused && !this.video.ended;
    this.cb.onStatus?.('连接中断，正在从 ' + formatTime(resumeAt) + ' 恢复…');
    this.cb.onLoading?.(true);
    setTimeout(() => {
      if (myGen !== this.gen) return; // 期间发生了 seek/重建
      this.teardownMediaSource();
      this.autoPlay = wasPlaying;
      this.startStreamAt(resumeAt);
    }, 1000);
  }

  private pumpReader(reader: ReadableStreamDefaultReader<Uint8Array>, myGen: number): void {
    // 水位线：缓冲领先播放头过多时暂停读取。TCP 背压沿浏览器→Node→ffmpeg stdout
    // 传导，ffmpeg 阻塞在写出上，全链路不再堆积。没有它 4x 实时的转码速度会
    // 撑爆 Chrome MSE 配额（约 150MB），之后 QuotaExceededError 静默丢 chunk，
    // buffered 出现空洞，播放头撞洞后永久卡死。
    const READ_HIGH_WATER = 45; // 领先播放头超过该秒数 → 暂停读取
    const READ_LOW_WATER = 15;  // 领先回落到该秒数以下 → 恢复读取

    const bufferedAhead = (): number => {
      const b = this.video.buffered;
      if (!b) return 0;
      for (let i = 0; i < b.length; i++) {
        if (this.video.currentTime >= b.start(i) && this.video.currentTime <= b.end(i)) {
          return b.end(i) - this.video.currentTime;
        }
      }
      return 0;
    };

    const step = (): void => {
      if (myGen !== this.gen) return;
      if (bufferedAhead() > READ_HIGH_WATER) {
        // 停靠：等播放消耗。timeupdate 仅在播放时触发，暂停时停靠是正确行为；
        // seek/换流会 gen++，监听器自行退役
        const onCheck = (): void => {
          if (myGen !== this.gen) {
            this.video.removeEventListener('timeupdate', onCheck);
            return;
          }
          if (bufferedAhead() <= READ_LOW_WATER) {
            this.video.removeEventListener('timeupdate', onCheck);
            step();
          }
        };
        this.video.addEventListener('timeupdate', onCheck);
        return;
      }
      reader.read().then(res => {
        if (myGen !== this.gen) return;
        if (res.done) {
          // 流自然结束：结束当前 MediaSource
          const ms = this.mediaSource;
          if (ms && ms.readyState === 'open' && this.sourceBuffer && !this.sourceBuffer.updating) {
            try { ms.endOfStream(); } catch { /* 已结束 */ }
          }
          return;
        }
        // 拷贝一份再入队（reader 复用底层缓冲的风险规避）
        this.enqueueBuffer(res.value.slice().buffer);
        this.networkFailStreak = 0; // 收到数据：恢复链路健康
        step();
      }).catch((e: Error) => {
        if (myGen !== this.gen) return;
        if (e.name !== 'AbortError') this.handleStreamFailure(myGen);
      });
    };
    step();
  }

  // SourceBuffer 追加（带队列，避免 updating 时冲突）
  private enqueueBuffer(data: ArrayBuffer): void {
    if (!this.sourceBuffer) return;
    this.pendingBuffers.push(data);
    this.pumpBuffer();
  }

  private pumpBuffer(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.pendingBuffers.length === 0) return;
    const next = this.pendingBuffers.shift()!;
    try {
      sb.appendBuffer(next);
    } catch (e) {
      if ((e as Error).name === 'QuotaExceededError' && sb.buffered.length > 0) {
        // 缓冲区配额耗尽：异步移除已播放部分（currentTime 之前 20s）释放空间，
        // 把当前分片放回队头，等 remove 触发的 updateend 后自动重试
        const removeEnd = Math.max(0, this.video.currentTime - 20);
        if (sb.buffered.start(0) < removeEnd) {
          this.pendingBuffers.unshift(next);
          try { sb.remove(sb.buffered.start(0), removeEnd); }
          catch { this.pumpBuffer(); } // remove 失败：丢弃当前分片，继续排空
        } else {
          this.pumpBuffer(); // 无可移除范围：丢弃当前分片，避免死循环
        }
      } else {
        this.pumpBuffer(); // 其他错误：丢弃当前分片，继续排空
      }
    }
  }

  // ===== 内部：video 元素事件 =====

  private isBufferedAt(t: number): boolean {
    const b = this.video.buffered;
    if (!b || b.length === 0) return false;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) && t <= b.end(i)) return true;
    }
    return false;
  }

  private onSeeking = (): void => {
    if (this.rebuilding) return;           // src 变更期间忽略
    // 消费 startStreamAt 中程序化设置 currentTime 触发的自激 seek（拨回 start 以对齐
    // 新缓冲区）。置位必伴随一次 currentTime 变化，seeking 必触发，标志必被消费；
    // 此处 return 跳过重建，防无限循环。
    if (this.selfSeeking) {
      this.selfSeeking = false;
      return;
    }
    const t = this.video.currentTime;
    if (this.isBufferedAt(t)) return;      // 已缓冲，交给原生播放
    // 真正拖到未缓冲区域（无论前后向）→ 结束当前 ffmpeg、从 t 精确 seek 重新转码
    this.cb.onStatus?.('精确 seek 到 ' + formatTime(t) + ' …');
    this.cb.onLoading?.(true);
    this.teardownMediaSource();
    this.autoPlay = true;
    this.startStreamAt(t);
  };

  private bindVideoEvents(): void {
    this.video.addEventListener('seeking', this.onSeeking);

    // 防御：播放头撞进 buffered 空洞（如历史丢 chunk 造成）时跳到下一段起点。
    // 若是无数据可播（直播边缘/转码跟不上），前方没有 range，不会触发误跳
    this.video.addEventListener('waiting', () => {
      if (this.video.seeking || this.rebuilding) return;
      const t = this.video.currentTime;
      const b = this.video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) > t) {
          this.video.currentTime = b.start(i);
          return;
        }
      }
    });

    this.video.addEventListener('loadedmetadata', () => {
      this.rebuilding = false; // src 重建窗口结束
    });

    this.video.addEventListener('canplay', () => {
      this.cb.onLoading?.(false);
      this.cb.onStatus?.('');
      if (this.autoPlay) {
        this.autoPlay = false;
        const p = this.video.play();
        if (p && p.catch) p.catch(() => { /* 自动播放被阻止，忽略 */ });
      }
    });

    this.video.addEventListener('error', () => {
      if (!this.destroyed) this.fail('播放错误');
    });
  }

  private fail(msg: string): void {
    this.cb.onLoading?.(false);
    this.cb.onError?.(msg);
  }

  private onBeforeUnload = (): void => {
    this.teardownMediaSource();
    try {
      fetch('/api/sessions/' + encodeURIComponent(this.meta.sessionId), {
        method: 'DELETE',
        keepalive: true
      });
    } catch { /* 卸载期尽力而为 */ }
  };
}
