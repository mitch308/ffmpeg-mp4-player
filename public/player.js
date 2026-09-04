// public/player.js
// MSE 播放器逻辑：加载会话、fMP4 流式播放、精确 seek（重建 MediaSource）
//
// 设计要点：
// - 服务端固定将源转码为 libx264（H.264）+ 禁用音频（-an），并以
//   frag_keyframe+empty_moov+default_base_moof 输出 fMP4。因此 SourceBuffer 的
//   codec 始终取 H.264，与 ffprobe 报告的源编码无关。
// - 每次请求 /stream?start=<秒> 都会触发服务端 kill 旧 ffmpeg 并从新位置重新转码，
//   产出一份全新的 ftyp+moov+fragments（时间线从 0 起算）。故精确 seek 时必须
//   重建 MediaSource（不能向既有 SourceBuffer 追加第二个 moov）。

(function () {
  'use strict';

  // ===== DOM =====
  var urlInput = document.getElementById('urlInput');
  var loadBtn = document.getElementById('loadBtn');
  var video = document.getElementById('video');
  var loading = document.getElementById('loading');
  var errorBox = document.getElementById('error');
  var status = document.getElementById('status');
  var info = document.getElementById('info');
  var infoDuration = document.getElementById('infoDuration');
  var infoResolution = document.getElementById('infoResolution');
  var infoCodec = document.getElementById('infoCodec');
  var infoAudio = document.getElementById('infoAudio');
  var infoMode = document.getElementById('infoMode');

  // 编码器名 → 展示名
  var ENCODER_LABELS = {
    h264_nvenc: 'NVIDIA NVENC',
    h264_qsv: 'Intel QSV',
    h264_amf: 'AMD AMF',
    h264_vaapi: 'VA-API',
    h264_videotoolbox: 'VideoToolbox',
    libx264: 'libx264'
  };

  function describeMode(s) {
    if (s.streamMode === 'copy') return '直通（无转码）';
    var enc = ENCODER_LABELS[s.encoder] || s.encoder || '';
    return (s.streamMode === 'hw' ? '硬件转码 ' : '软件转码 ') + enc;
  }

  // ===== 候选 codec =====
  // 服务端输出恒为 H.264（直通保留源 profile/level，故候选需覆盖高级别），
  // 音频存在时恒为 AAC-LC（mp4a.40.2）。编码器为 libx264 转码时通常是 High profile。
  var VIDEO_CODECS = [
    'avc1.42E01E', // Baseline 3.0
    'avc1.4d401e', // Main 3.0
    'avc1.640028', // High 4.0
    'avc1.640029', // High 4.1
    'avc1.640032', // High 5.0
    'avc1.640033'  // High 5.1
  ];

  function pickCodec(session) {
    var hasAudio = !!(session && session.audioCodec);
    var fallback = 'video/mp4; codecs="' + VIDEO_CODECS[0] + (hasAudio ? ',mp4a.40.2' : '') + '"';
    if (window.MediaSource && typeof MediaSource.isTypeSupported === 'function') {
      for (var i = 0; i < VIDEO_CODECS.length; i++) {
        var mime = 'video/mp4; codecs="' + VIDEO_CODECS[i] + (hasAudio ? ',mp4a.40.2' : '') + '"';
        if (MediaSource.isTypeSupported(mime)) return mime;
      }
    }
    return fallback;
  }

  function mseAvailable() {
    return !!(window.MediaSource && typeof MediaSource.isTypeSupported === 'function' &&
              MediaSource.isTypeSupported(pickCodec(session)));
  }

  // ===== 运行时状态 =====
  var session = null;          // { id, duration, width, height, codec }
  var mediaSource = null;
  var sourceBuffer = null;
  var objectURL = null;
  var abortController = null;
  var gen = 0;                 // 代次令牌，使在途异步操作失效
  var pendingBuffers = [];     // 待 append 的分片队列
  var rebuilding = false;      // MediaSource 重建期间，抑制 seeking 处理
  var selfSeeking = false;     // 程序化设置 currentTime 以对齐新缓冲区时置位，onSeeking 消费一次
  var autoPlay = false;        // canplay 后是否自动续播

  // ===== UI helpers =====
  // 注意：#video 与 #info 在 HTML 中带 inline style="display:none"，
  // 仅切换 'hidden' class 无法覆盖内联样式，故同时操作内联 display。
  function show(el) { el.classList.remove('hidden'); el.style.display = ''; }
  function hide(el) { el.classList.add('hidden'); el.style.display = 'none'; }

  function setError(msg) {
    // 统一复位重建标记：错误路径（addSourceBuffer 抛错、流读取失败等）下
    // loadedmetadata 不会触发，需在此复位，否则一次失败后 seek 永久失效。
    rebuilding = false;
    errorBox.textContent = msg;
    show(errorBox);
  }
  function clearError() { errorBox.textContent = ''; hide(errorBox); }
  function setStatus(msg) {
    status.textContent = msg || '';
    if (msg) show(status); else hide(status);
  }

  function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = Math.floor(s % 60);
    var ss = String(sec).padStart(2, '0');
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
    return m + ':' + ss;
  }

  // ===== 会话销毁 =====
  function destroyCurrentSession() {
    var s = session;
    session = null;
    if (!s) return Promise.resolve();
    return fetch('/api/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' })
      .catch(function () { /* 忽略：服务端 5min 超时会兜底清理 */ });
  }

  // ===== 流终止 / 资源释放 =====
  function teardownMediaSource() {
    gen++; // 使所有在途异步操作失效
    selfSeeking = false; // 复位自激标志，防止上次程序化 seek 未被消费而残留
    if (abortController) {
      try { abortController.abort(); } catch (e) {}
      abortController = null;
    }
    pendingBuffers = [];
    sourceBuffer = null;
    if (mediaSource) {
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch (e) {}
      mediaSource = null;
    }
    if (objectURL) {
      URL.revokeObjectURL(objectURL);
      objectURL = null;
    }
  }

  // ===== SourceBuffer 追加（带队列，避免 updating 时冲突）=====
  function enqueueBuffer(data) {
    if (!sourceBuffer) return;
    pendingBuffers.push(data);
    pumpBuffer();
  }

  function pumpBuffer() {
    if (!sourceBuffer || sourceBuffer.updating || pendingBuffers.length === 0) return;
    var next = pendingBuffers.shift();
    try {
      sourceBuffer.appendBuffer(next);
    } catch (e) {
      if (e && e.name === 'QuotaExceededError' && sourceBuffer.buffered.length > 0) {
        // 缓冲区配额耗尽：异步移除已播放部分（currentTime 之前 20s）释放空间，
        // 把当前分片放回队头，等 remove 触发的 updateend 后由 pumpBuffer 自动重试。
        var removeEnd = Math.max(0, video.currentTime - 20);
        if (sourceBuffer.buffered.start(0) < removeEnd) {
          pendingBuffers.unshift(next);
          try { sourceBuffer.remove(sourceBuffer.buffered.start(0), removeEnd); }
          catch (e2) { /* remove 失败：丢弃当前分片，继续排空队列 */
            pumpBuffer();
          }
        } else {
          // 无可移除范围：丢弃当前分片，继续排空，避免死循环。
          pumpBuffer();
        }
      } else {
        // 其他类型错误：丢弃当前分片，继续排空。
        pumpBuffer();
      }
    }
  }

  // ===== 加载流（从给定 start 秒）=====
  function startStreamAt(start) {
    var myGen = gen;
    var codec = pickCodec(session);

    rebuilding = true;
    mediaSource = new MediaSource();
    objectURL = URL.createObjectURL(mediaSource);
    video.src = objectURL;
    video.load();

    mediaSource.addEventListener('sourceopen', function onOpen() {
      mediaSource.removeEventListener('sourceopen', onOpen);
      if (myGen !== gen) return; // 已过期
      try {
        sourceBuffer = mediaSource.addSourceBuffer(codec);
      } catch (e) {
        setError('不支持的视频编码: ' + e.message);
        return;
      }
      sourceBuffer.mode = 'segments';
      // 关键：seek 重建后新 ffmpeg 流的时间戳从 0 重新起算（-ss 重置了时间线），
      // 用 timestampOffset 把它偏移到原片的 start 位置，使 video.currentTime
      // 始终反映原片真实位置，进度条刻度与总时长对齐（而非从 0 重新计数）。
      // 初始加载 start=0，offset=0 无副作用。
      try { sourceBuffer.timestampOffset = start; } catch (e) {}
      // 设置 MediaSource 时长为原片总时长，使原生进度条覆盖整片范围。
      try { mediaSource.duration = session.duration; } catch (e) {}
      // 关键：video.load() 后 currentTime 通常被重置为 0（m2ts 等源不会保留 seek 目标，
      // 与某些 mp4 的保留行为不同）。但 timestampOffset 让新缓冲区从 start 开始，若播放头
      // 停在 0，会落在缓冲区外 → 永远 waiting 不播放。故必须把播放头拨回 start。
      // 该程序化赋值会触发 seeking 事件：用 selfSeeking 标志让 onSeeking 识别这是自触发
      // （而非用户拖拽），跳过重建，避免无限循环。标志在 onSeeking 顶部消费。
      if (start > 0) {
        try {
          selfSeeking = true;
          video.currentTime = start;
        } catch (e) {
          selfSeeking = false;
        }
      }
      sourceBuffer.addEventListener('updateend', pumpBuffer);
      sourceBuffer.addEventListener('error', function (e) {
        if (myGen !== gen) return;
        var err = e.target && e.target.error;
        setError('解码错误: ' + (err ? err.message : 'unknown'));
      });

      fetchStream(start, myGen);
    });
  }

  var networkFailStreak = 0; // 连续网络失败次数（收到数据即清零）

  // 流中断自动恢复：长片（数小时）播放中任何瞬时网络抖动都不应终局。
  // 从当前播放位置重建流（与 seek 同路径），连续失败超限才报错。
  // 服务端在客户端断开时会 kill 旧 ffmpeg，重建即从 resumeAt 精确重转。
  function handleStreamFailure(myGen) {
    if (myGen !== gen) return; // 已有新流接管（如用户 seek）
    if (networkFailStreak >= 4) {
      setError('流中断且自动恢复失败，请重新加载');
      return;
    }
    networkFailStreak++;
    var resumeAt = video.currentTime;
    var wasPlaying = !video.paused && !video.ended;
    setStatus('连接中断，正在从 ' + formatTime(resumeAt) + ' 恢复...');
    setTimeout(function () {
      if (myGen !== gen) return; // 期间发生了 seek/重建
      teardownMediaSource();
      autoPlay = wasPlaying;
      startStreamAt(resumeAt);
    }, 1000);
  }

  function fetchStream(start, myGen) {
    abortController = new AbortController();
    var url = '/api/sessions/' + encodeURIComponent(session.id) +
              '/stream?start=' + encodeURIComponent(start);

    fetch(url, { signal: abortController.signal })
      .then(function (resp) {
        if (myGen !== gen) return;
        if (!resp.ok) { setError('流请求失败: HTTP ' + resp.status); return; }
        var reader = resp.body.getReader();
        return pumpReader(reader, myGen);
      })
      .catch(function (e) {
        if (myGen !== gen) return;
        if (e.name !== 'AbortError') handleStreamFailure(myGen);
      });
  }

  function pumpReader(reader, myGen) {
    // 水位线：缓冲领先播放头过多时暂停读取。TCP 背压会沿
    // 浏览器→Node→ffmpeg stdout 管道传导，ffmpeg 阻塞在写出上，
    // 全链路（浏览器 MSE 配额 / Node 缓冲 / ffmpeg 内存）都不再堆积。
    // 没有它，4x 实时的转码速度会迅速撑爆 Chrome MSE 配额（约 150MB），
    // 之后 appendBuffer 连续 QuotaExceededError、chunk 被静默丢弃，
    // buffered 出现空洞，播放头撞洞后永久卡死。
    var READ_HIGH_WATER = 45; // 领先播放头超过该秒数 → 暂停读取
    var READ_LOW_WATER = 15;  // 领先回落到该秒数以下 → 恢复读取

    function bufferedAhead() {
      if (!video.buffered) return 0;
      for (var i = 0; i < video.buffered.length; i++) {
        if (video.currentTime >= video.buffered.start(i) &&
            video.currentTime <= video.buffered.end(i)) {
          return video.buffered.end(i) - video.currentTime;
        }
      }
      return 0;
    }

    function step() {
      if (myGen !== gen) return;
      if (bufferedAhead() > READ_HIGH_WATER) {
        // 停靠：等播放消耗。timeupdate 仅在播放时触发，暂停时停靠是正确行为；
        // seek/换流会 gen++，监听器自行退役。
        var onCheck = function () {
          if (myGen !== gen) {
            video.removeEventListener('timeupdate', onCheck);
            return;
          }
          if (bufferedAhead() <= READ_LOW_WATER) {
            video.removeEventListener('timeupdate', onCheck);
            step();
          }
        };
        video.addEventListener('timeupdate', onCheck);
        return;
      }
      reader.read().then(function (res) {
        if (myGen !== gen) return;
        if (res.done) {
          // 流自然结束：结束当前 MediaSource
          if (mediaSource && mediaSource.readyState === 'open' &&
              sourceBuffer && !sourceBuffer.updating) {
            try { mediaSource.endOfStream(); } catch (e) {}
          }
          return;
        }
        enqueueBuffer(res.value);
        networkFailStreak = 0; // 收到数据：恢复链路健康
        step();
      }).catch(function (e) {
        if (myGen !== gen) return;
        if (e.name !== 'AbortError') handleStreamFailure(myGen);
      });
    }
    step();
  }

  // ===== seek 判定 =====
  function isBufferedAt(t) {
    if (!video.buffered || video.buffered.length === 0) return false;
    for (var i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) && t <= video.buffered.end(i)) return true;
    }
    return false;
  }

  function onSeeking() {
    if (!mseAvailable()) return;     // 无 MSE 回退模式：direct /stream 不支持 Range，原生 seek 本就受限，不处理
    if (rebuilding) return;            // src 变更期间忽略
    // 消费 startStreamAt 中程序化设置 currentTime 触发的自激 seek（拨回 start 以对齐新缓冲区）。
    // 置位必伴随一次 currentTime 变化，seeking 必触发，标志必被消费；此处 return 跳过重建，防无限循环。
    if (selfSeeking) {
      selfSeeking = false;
      return;
    }
    if (!session) return;
    var t = video.currentTime;
    if (isBufferedAt(t)) return;       // 已缓冲，交给原生播放
    // 真正拖到未缓冲区域（无论前后向）-> 按 spec 结束当前 ffmpeg、从 t 精确 seek 重新转码
    setStatus('精确 seek 到 ' + formatTime(t) + ' ...');
    show(loading);
    teardownMediaSource();
    autoPlay = true;
    startStreamAt(t);
  }

  // ===== 直接 src 回退（MSE 不可用时）=====
  function playWithDirectSrc(start) {
    var url = '/api/sessions/' + encodeURIComponent(session.id) +
              '/stream?start=' + encodeURIComponent(start);
    video.src = url;
    video.load();
    autoPlay = true;
  }

  // ===== 加载入口 =====
  function load() {
    clearError();
    networkFailStreak = 0;
    var url = urlInput.value.trim();
    if (!url) { setError('请输入视频 URL'); return; }

    loadBtn.disabled = true;
    hide(video);
    hide(info);
    show(loading);
    setStatus('正在探测视频元数据...');

    teardownMediaSource();
    destroyCurrentSession()
      .then(function () {
        return fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url })
        });
      })
      .then(function (resp) {
        if (!resp.ok) {
          return resp.json().catch(function () { return {}; }).then(function (err) {
            throw new Error(err.error || ('HTTP ' + resp.status));
          });
        }
        return resp.json();
      })
      .then(function (data) {
        session = {
          id: data.sessionId,
          duration: data.duration,
          width: data.width,
          height: data.height,
          codec: data.codec,
          audioCodec: data.audioCodec || null,
          streamMode: data.streamMode || 'sw',
          encoder: data.encoder || null
        };

        infoDuration.textContent = '时长: ' + formatTime(session.duration);
        infoResolution.textContent = '分辨率: ' + session.width + 'x' + session.height;
        infoCodec.textContent = '编码: ' + session.codec + ' / ' + (data.pixFmt || '');
        infoAudio.textContent = '音频: ' + (session.audioCodec ? 'AAC' : '无');
        infoMode.textContent = '方式: ' + describeMode(session);
        show(info);

        setStatus(session.streamMode === 'copy' ? '正在缓冲...' : '正在转码并缓冲...');
        show(video);
        autoPlay = true;

        if (mseAvailable()) {
          startStreamAt(0);
        } else {
          setStatus('浏览器不支持 MSE，使用直接播放（精确 seek 不可用）');
          playWithDirectSrc(0);
        }
      })
      .catch(function (e) {
        setError('加载失败: ' + e.message);
        hide(loading);
      })
      .then(function () {
        loadBtn.disabled = false;
      });
  }

  // ===== 事件绑定 =====
  loadBtn.addEventListener('click', load);
  urlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') load();
  });

  video.addEventListener('seeking', onSeeking);

  // 防御：播放头撞进 buffered 空洞（如历史丢 chunk 造成）时跳到下一段起点。
  // 若是无数据可播（直播边缘/转码跟不上），前方没有 range，不会触发误跳。
  video.addEventListener('waiting', function () {
    if (!session || video.seeking || rebuilding) return;
    var t = video.currentTime;
    for (var i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) > t) {
        video.currentTime = video.buffered.start(i);
        return;
      }
    }
  });

  video.addEventListener('loadedmetadata', function () {
    rebuilding = false; // src 重建窗口结束
  });

  video.addEventListener('canplay', function () {
    hide(loading);
    setStatus('');
    if (autoPlay) {
      autoPlay = false;
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* 自动播放被阻止，忽略 */ });
    }
  });

  video.addEventListener('error', function () {
    if (session) setError('播放错误');
  });

  // 页面卸载时尽力清理
  window.addEventListener('beforeunload', function () {
    teardownMediaSource();
    if (session) {
      try {
        fetch('/api/sessions/' + encodeURIComponent(session.id), {
          method: 'DELETE',
          keepalive: true
        });
      } catch (e) {}
    }
  });
})();
