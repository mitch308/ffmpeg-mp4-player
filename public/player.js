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

  // ===== 候选 codec（服务端固定输出 libx264，均为 H.264）=====
  var CODEC_CANDIDATES = [
    'video/mp4; codecs="avc1.42E01E"', // Baseline 3.0
    'video/mp4; codecs="avc1.4d401e"', // Main 3.0
    'video/mp4; codecs="avc1.640028"', // High 4.0
    'video/mp4; codecs="avc1.640029"'  // High 4.1
  ];

  function pickCodec() {
    if (window.MediaSource && typeof MediaSource.isTypeSupported === 'function') {
      for (var i = 0; i < CODEC_CANDIDATES.length; i++) {
        if (MediaSource.isTypeSupported(CODEC_CANDIDATES[i])) return CODEC_CANDIDATES[i];
      }
    }
    return CODEC_CANDIDATES[0];
  }

  function mseAvailable() {
    return !!(window.MediaSource && typeof MediaSource.isTypeSupported === 'function' &&
              MediaSource.isTypeSupported(pickCodec()));
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
    var codec = pickCodec();

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
      // 设置 MediaSource 时长，使原生 <video controls> 进度条可达未缓冲点，
      // 否则 empty_moov 输出下 video.duration 保持 Infinity/NaN，精确 seek 不可达。
      try { mediaSource.duration = session.duration; } catch (e) {}
      sourceBuffer.addEventListener('updateend', pumpBuffer);
      sourceBuffer.addEventListener('error', function (e) {
        if (myGen !== gen) return;
        var err = e.target && e.target.error;
        setError('解码错误: ' + (err ? err.message : 'unknown'));
      });

      fetchStream(start, myGen);
    });
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
        if (e.name !== 'AbortError') setError('请求流失败: ' + e.message);
      });
  }

  function pumpReader(reader, myGen) {
    return reader.read().then(function (res) {
      if (res.done) {
        // 流自然结束：结束当前 MediaSource
        if (myGen === gen && mediaSource && mediaSource.readyState === 'open' &&
            sourceBuffer && !sourceBuffer.updating) {
          try { mediaSource.endOfStream(); } catch (e) {}
        }
        return;
      }
      if (myGen !== gen) return;
      enqueueBuffer(res.value);
      return pumpReader(reader, myGen);
    }).catch(function (e) {
      if (myGen !== gen) return;
      if (e.name !== 'AbortError') setError('读取流失败: ' + e.message);
    });
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
    if (!session) return;
    var t = video.currentTime;
    if (isBufferedAt(t)) return;       // 已缓冲，交给原生播放
    // 未缓冲 -> 精确 seek：abort 当前 stream、重建 MediaSource、用新 start 重新请求
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
          codec: data.codec
        };

        infoDuration.textContent = '时长: ' + formatTime(session.duration);
        infoResolution.textContent = '分辨率: ' + session.width + 'x' + session.height;
        infoCodec.textContent = '编码: ' + session.codec;
        show(info);

        setStatus('正在转码并缓冲...');
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
