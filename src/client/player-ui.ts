// src/client/player-ui.ts — 播放器控制栏 UI（PC/TV 双主题，同 DOM 不同 CSS）。
// 交互逻辑与视觉值移植自 etsme-h5 video-preview 组件：
// - 显隐：200ms 节流 mousemove 显示；播放中 3s 隐藏；5s 无操作隐藏；暂停常显
// - 单击画面切播放/暂停、双击切全屏（260ms 双击判定；按需求偏离参考组件）
// - ext 面板：画质 / 倍速 / 更多设置（画面比例 + 解码设置）
// - 拖拽进度条仅 UI 预览，松手才 seek（服务端 seek 成本高，与参考组件的有意差异）
import { injectIcon, type IconName } from './icons';
import type { ModeId, PlayerCore, PlayerCoreCallbacks, QualityId } from './player-core';

const PLAYBACK_RATES = [0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
// 展示顺序高→低（服务端返回的 qualities 即此序）
const QUALITY_LABELS: Record<QualityId, string> = {
  '2k': '2K', '1080p': '1080P', '720p': '720P', origin: '原画质'
};
// 画面比例（参考组件 const.ts radioList；key 1=原始 2=16:9 3=4:3）
const RADIO_LIST = [
  { key: 1, label: '原始' },
  { key: 2, label: '16:9' },
  { key: 3, label: '4:3' }
] as const;
const DECODE_LIST: Array<{ key: ModeId; label: string }> = [
  { key: 'hw', label: '硬解' },
  { key: 'sw', label: '软解' }
];
const EXT_TITLES = { videoQuality: '画质', playbackRate: '倍速', moreConfig: '更多设置' } as const;
type ExtType = keyof typeof EXT_TITLES;

// 显隐常量（照抄参考组件）
const CONTROL_HIDE_DELAY = 3000;   // 播放中 3s 后隐藏控制栏
const MOUSE_MOVE_THROTTLE = 200;   // 鼠标移动节流
const INACTIVITY_TIMEOUT = 5000;   // 5s 无操作视为不活跃
const DBLCLICK_MS = 260;           // 双击判定窗口

export interface PlayerUIOptions {
  root: HTMLElement;
  core: PlayerCore;
  callbacks: PlayerCoreCallbacks;
  title?: string;
  ui?: 'pc' | 'tv';
}

const TEMPLATE = `
  <div class="player"><video class="video radio-origin"></video></div>
  <div class="video-player-layer"></div>
  <div class="video-player-header"><span class="video-player-title"></span></div>
  <span class="loader hidden"></span>
  <div class="video-player-controller">
    <div class="ext hidden">
      <h3 class="ext-title"></h3>
      <div class="ext-back"><span class="icon" data-icon="arrow-down"></span></div>
      <div class="quality-list"></div>
      <div class="playback-rate-list hidden"></div>
      <div class="config-content hidden">
        <h3 class="config-title">画面比例</h3>
        <div class="radio-list"></div>
        <h3 class="config-title decode-title">解码设置</h3>
        <div class="decode-list"></div>
      </div>
      <div class="driver"></div>
    </div>
    <div class="ff-player-controller-main">
      <div class="first-row">
        <span class="ff-player-time time-l">00:00:00</span>
        <div class="player-bar-wrap">
          <div class="player-bar-time">00:00:00</div>
          <div class="player-bar">
            <div class="player-buffer-time"></div>
            <div class="player-played"><span class="player-thumb"><span></span></span></div>
          </div>
        </div>
        <span class="ff-player-time time-r">00:00:00</span>
      </div>
      <div class="second-row">
        <div class="left">
          <div class="icon-play-box"><span class="icon" data-icon="play"></span></div>
          <div class="icon-pause-box hidden"><span class="icon" data-icon="pause"></span></div>
          <div class="player-volume">
            <div class="icon-muted-box hidden"><span class="icon" data-icon="volume-mute"></span></div>
            <div class="icon-unmuted-box"><span class="icon" data-icon="volume-unmute"></span></div>
            <div class="player-volume-bar-wrap">
              <div class="player-volume-bar">
                <div class="player-volume-bar-inner"><span class="player-vol-thumb"><div class="player-vol-thumb-tips">100%</div></span></div>
              </div>
            </div>
          </div>
        </div>
        <div class="center">
          <span class="ff-player-time time-c1">00:00:00</span>
          <span class="ff-player-time-split">/</span>
          <span class="ff-player-time time-c2">00:00:00</span>
        </div>
        <div class="right">
          <div class="playback-rate" title="倍速">倍速</div>
          <div class="quality" title="画质">原画质</div>
          <div class="more-config-box" title="更多"><span class="icon" data-icon="cog"></span></div>
          <div class="fullscreen-box" title="全屏"><span class="icon" data-icon="fullscreen"></span></div>
        </div>
      </div>
    </div>
  </div>
  <div class="player-error hidden"></div>
`;

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return pad(h) + ':' + pad(m) + ':' + pad(sec);
}

export function mountPlayerUI(opts: PlayerUIOptions): void {
  const { root, core, callbacks } = opts;
  const ui = opts.ui ?? 'pc';
  root.classList.remove('ui-pc', 'ui-tv');
  root.classList.add(ui === 'tv' ? 'ui-tv' : 'ui-pc');
  root.innerHTML = TEMPLATE;

  const video = core.video;
  video.className = 'video radio-origin';
  // 用核心持有的 video 替换 TEMPLATE 里的占位 video（brief 原稿为 appendChild，
  // 会留下两个 .video 兄弟节点被 flex 各挤到半宽，此处为最小修正）
  root.querySelector('.player video')!.replaceWith(video);

  // 图标注入
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    injectIcon(el, el.dataset.icon as IconName);
  });

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const layer = $('.video-player-layer');
  const header = $('.video-player-header');
  const controller = $('.video-player-controller');
  const loader = $('.loader');
  const errorBox = $('.player-error');
  const ext = $('.ext');
  const extTitle = $('.ext-title');
  const qualityList = $('.quality-list');
  const rateList = $('.playback-rate-list');
  const radioList = root.querySelector('.radio-list') as HTMLElement;
  const decodeList = $('.decode-list');
  const configContent = root.querySelector('.config-content') as HTMLElement;
  const barWrap = $('.player-bar-wrap');
  const barTime = $('.player-bar-time');
  const playedBar = $('.player-played');
  const bufferBar = $('.player-buffer-time');
  const thumb = $('.player-thumb');
  const timeL = $('.time-l');
  const timeR = $('.time-r');
  const timeC1 = $('.time-c1');
  const timeC2 = $('.time-c2');
  const playBox = $('.icon-play-box');
  const pauseBox = $('.icon-pause-box');
  const mutedBox = $('.icon-muted-box');
  const unmutedBox = $('.icon-unmuted-box');
  const volInner = $('.player-volume-bar-inner');
  const volTips = $('.player-vol-thumb-tips');
  const volBar = $('.player-volume-bar');
  const rateLabel = $('.playback-rate');
  const qualityLabel = $('.quality');
  const fullscreenIcon = root.querySelector('.fullscreen-box .icon') as HTMLElement;

  // ===== 状态渲染 =====

  if (opts.title) root.querySelector('.video-player-title')!.textContent = opts.title;
  else header.classList.add('hidden');

  const totalDuration = (): number => video.duration || core.meta.duration || 0;

  const renderTime = (): void => {
    const t = formatTime(video.currentTime);
    const d = formatTime(totalDuration());
    timeL.textContent = t;
    timeR.textContent = d;
    timeC1.textContent = t;
    timeC2.textContent = d;
    const dur = totalDuration();
    playedBar.style.width = dur ? Math.min(video.currentTime / dur, 1) * 100 + '%' : '0%';
  };

  const renderBuffer = (): void => {
    const dur = totalDuration();
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
        end = video.buffered.end(i);
        break;
      }
    }
    bufferBar.style.width = dur ? Math.min(end / dur, 1) * 100 + '%' : '0%';
  };

  const renderPlayState = (): void => {
    playBox.classList.toggle('hidden', !video.paused);
    pauseBox.classList.toggle('hidden', video.paused);
  };

  const renderVolume = (): void => {
    const v = video.muted ? 0 : video.volume;
    volInner.style.width = v * 100 + '%';
    volTips.textContent = Math.ceil(v * 100) + '%';
    mutedBox.classList.toggle('hidden', !video.muted);
    unmutedBox.classList.toggle('hidden', video.muted);
  };

  const renderQuality = (): void => {
    qualityLabel.textContent = QUALITY_LABELS[core.quality] ?? '原画质';
    qualityList.querySelectorAll('span').forEach(el => {
      el.classList.toggle('active', el.dataset.q === core.quality);
    });
  };

  const renderDecode = (): void => {
    const active: ModeId = core.mode === 'sw' ? 'sw' : 'hw';
    decodeList.querySelectorAll('span').forEach(el => {
      el.classList.toggle('active', el.dataset.mode === active);
    });
  };

  const renderRadio = (key: number): void => {
    // 画面比例纯前端处理（spec：后端输出画面比例不变）
    video.className = 'video ' + (key === 1 ? 'radio-origin' : key === 2 ? 'radio-16-9' : 'radio-4-3');
    radioList.querySelectorAll('span').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.key) === key);
    });
  };

  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('progress', renderBuffer);
  video.addEventListener('durationchange', renderTime);
  video.addEventListener('loadedmetadata', renderTime);
  video.addEventListener('seeked', renderTime);
  video.addEventListener('play', () => { renderPlayState(); scheduleHide(); });
  video.addEventListener('pause', () => { renderPlayState(); showControlsNow(); });
  video.addEventListener('volumechange', renderVolume);
  video.addEventListener('ended', () => showControlsNow());

  // ===== 控制栏显隐（移植 VideoPlayer.vue）=====

  let controlsVisible = true;
  let hideTimer: number | null = null;
  let inactivityTimer: number | null = null;
  let mouseMoveTimer: number | null = null;
  let lastMouseMove = Date.now();

  const isPlaying = (): boolean => !video.paused && !video.ended;

  const applyVisibility = (): void => {
    header.classList.toggle('is-hidden', !controlsVisible);
    controller.classList.toggle('is-hidden', !controlsVisible);
    if (!controlsVisible) hideExt();
  };

  function clearHideTimer(): void {
    if (hideTimer != null) { clearTimeout(hideTimer); hideTimer = null; }
  }
  function clearInactivityTimer(): void {
    if (inactivityTimer != null) { clearTimeout(inactivityTimer); inactivityTimer = null; }
  }
  function startHideTimer(): void {
    clearHideTimer();
    if (!isPlaying()) return;
    hideTimer = window.setTimeout(() => {
      if (isPlaying()) { controlsVisible = false; applyVisibility(); }
      hideTimer = null;
    }, CONTROL_HIDE_DELAY);
  }
  function resetInactivityTimer(): void {
    clearInactivityTimer();
    inactivityTimer = window.setTimeout(() => {
      if (isPlaying() && controlsVisible) { controlsVisible = false; applyVisibility(); }
    }, INACTIVITY_TIMEOUT);
  }
  function showControlsNow(): void {
    controlsVisible = true;
    applyVisibility();
    clearHideTimer();
    clearInactivityTimer();
  }
  function scheduleHide(): void {
    startHideTimer();
    resetInactivityTimer();
  }
  function onHoverControls(): void {
    showControlsNow();
  }

  const handleMouseMove = (): void => {
    const now = Date.now();
    if (mouseMoveTimer != null) return;      // 节流处理
    if (now - lastMouseMove < MOUSE_MOVE_THROTTLE) return;
    mouseMoveTimer = window.setTimeout(() => {
      mouseMoveTimer = null;
      lastMouseMove = now;
      showControlsNow();
      scheduleHide();
    }, MOUSE_MOVE_THROTTLE);
  };

  // 单击切播放/暂停、双击切全屏（画面区域，260ms 双击判定；
  // 按需求偏离参考组件的"单击切控制栏/双击切播放"）
  let clickTimer: number | null = null;
  layer.addEventListener('click', () => {
    if (clickTimer != null) {
      clearTimeout(clickTimer);
      clickTimer = null;
      // 双击：切全屏
      toggleFullScreen();
      return;
    }
    clickTimer = window.setTimeout(() => {
      clickTimer = null;
      // 单击：切播放/暂停
      if (video.paused) void video.play().catch(() => { /* 被阻止 */ });
      else video.pause();
    }, DBLCLICK_MS);
  });
  layer.addEventListener('mousemove', handleMouseMove);

  // ===== ext 面板 =====

  let extType: ExtType | null = null;
  function showExt(type: ExtType): void {
    if (extType === type && !ext.classList.contains('hidden')) { hideExt(); return; }
    extType = type;
    extTitle.textContent = EXT_TITLES[type];
    qualityList.classList.toggle('hidden', type !== 'videoQuality');
    rateList.classList.toggle('hidden', type !== 'playbackRate');
    configContent.classList.toggle('hidden', type !== 'moreConfig');
    ext.classList.remove('hidden');
    showControlsNow();
    // PC 主题的 ext 在条内部展开，高度动画需要显式高度；TV 主题全宽自适应
    if (ui === 'pc') ext.style.height = ext.scrollHeight + 'px';
  }
  function hideExt(): void {
    extType = null;
    ext.classList.add('hidden');
    if (ui === 'pc') ext.style.height = '0px';
  }
  $('.ext-back').addEventListener('click', hideExt);
  rateLabel.addEventListener('click', () => showExt('playbackRate'));
  qualityLabel.addEventListener('click', () => showExt('videoQuality'));
  $('.more-config-box').addEventListener('click', () => showExt('moreConfig'));
  controller.addEventListener('mouseenter', onHoverControls);

  // ===== 列表构建 =====

  // 画质（展示从低到高、原画质最后；服务端返回为降序，origin 恒在末位）
  // 显式标注 QualityId[]：TS 5.5+ 会从 filter 谓词窄化掉 origin，push 时报错
  const qualityOrder: QualityId[] = core.meta.qualities.filter(q => q !== 'origin').reverse();
  qualityOrder.push('origin');
  for (const q of qualityOrder) {
    const span = document.createElement('span');
    span.textContent = QUALITY_LABELS[q] ?? q;
    span.dataset.q = q;
    span.addEventListener('click', () => {
      if (q === core.quality) { hideExt(); return; }
      core.restartWith(q, core.mode);
      renderQuality();
      hideExt();
    });
    qualityList.appendChild(span);
  }
  // 倍速
  for (const r of PLAYBACK_RATES) {
    const span = document.createElement('span');
    span.textContent = r + 'x';
    span.dataset.rate = String(r);
    span.classList.toggle('active', r === 1.0);
    span.addEventListener('click', () => {
      video.playbackRate = r;
      rateLabel.textContent = r === 1.0 ? '倍速' : r + 'x';
      rateList.querySelectorAll('span').forEach(el =>
        el.classList.toggle('active', Number(el.dataset.rate) === r));
      hideExt();
    });
    rateList.appendChild(span);
  }
  // 画面比例
  for (const item of RADIO_LIST) {
    const span = document.createElement('span');
    span.textContent = item.label;
    span.dataset.key = String(item.key);
    span.classList.toggle('active', item.key === 1);
    span.addEventListener('click', () => { renderRadio(item.key); hideExt(); });
    radioList.appendChild(span);
  }
  // 解码设置：硬解不可用（部署机无硬编）时不显示硬解选项
  for (const item of DECODE_LIST) {
    if (item.key === 'hw' && !core.meta.hwAvailable) continue;
    const span = document.createElement('span');
    span.textContent = item.label;
    span.dataset.mode = item.key;
    span.addEventListener('click', () => {
      if (item.key === core.mode) { hideExt(); return; }
      core.restartWith(core.quality, item.key);
      renderDecode();
      hideExt();
    });
    decodeList.appendChild(span);
  }

  // ===== 进度条（拖拽预览，松手提交 seek）=====

  let dragging = false;
  const barPercentage = (e: MouseEvent): number => {
    const rect = barWrap.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  };
  barWrap.addEventListener('mousedown', (e) => {
    dragging = true;
    thumb.classList.add('player-thumb-active');
    const p = barPercentage(e);
    playedBar.style.width = p * 100 + '%';
    barTime.textContent = formatTime(p * totalDuration());
    document.addEventListener('mousemove', onBarMove);
    document.addEventListener('mouseup', onBarUp);
    e.preventDefault();
  });
  function onBarMove(e: MouseEvent): void {
    if (!dragging) return;
    const p = barPercentage(e);
    playedBar.style.width = p * 100 + '%';
    barTime.textContent = formatTime(p * totalDuration());
  }
  function onBarUp(e: MouseEvent): void {
    document.removeEventListener('mousemove', onBarMove);
    document.removeEventListener('mouseup', onBarUp);
    dragging = false;
    thumb.classList.remove('player-thumb-active');
    core.seek(barPercentage(e) * totalDuration());
  }
  barWrap.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const dur = totalDuration();
    if (!dur) return;
    const rect = barWrap.getBoundingClientRect();
    const p = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    barTime.style.left = (e.clientX - rect.left) + 'px';
    barTime.textContent = formatTime(p * dur);
  });
  barWrap.addEventListener('mouseenter', () => barTime.classList.add('player-bar-time-active'));
  barWrap.addEventListener('mouseleave', () => barTime.classList.remove('player-bar-time-active'));

  // ===== 音量 =====

  const setVolume = (v: number): void => {
    video.volume = Math.min(Math.max(v, 0), 1);
    video.muted = video.volume === 0;
  };
  const volPercentage = (e: MouseEvent): number => {
    const rect = volBar.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  };
  volBar.parentElement!.addEventListener('mousedown', (e) => {
    setVolume(volPercentage(e));
    document.addEventListener('mousemove', onVolMove);
    document.addEventListener('mouseup', onVolUp);
    e.preventDefault();
  });
  function onVolMove(e: MouseEvent): void {
    setVolume(volPercentage(e));
  }
  function onVolUp(): void {
    document.removeEventListener('mousemove', onVolMove);
    document.removeEventListener('mouseup', onVolUp);
  }
  playBox.addEventListener('click', () => void video.play().catch(() => { /* 被阻止 */ }));
  pauseBox.addEventListener('click', () => video.pause());
  mutedBox.addEventListener('click', () => { video.muted = false; });
  unmutedBox.addEventListener('click', () => { video.muted = true; });

  // ===== 全屏（PC 主题；TV 无此按钮，CSS 隐藏）=====

  function toggleFullScreen(): void {
    const fs = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen();
    fs.catch(() => { /* 拒绝/不支持 */ });
  }
  $('.fullscreen-box').addEventListener('click', toggleFullScreen);
  document.addEventListener('fullscreenchange', () => {
    injectIcon(fullscreenIcon, document.fullscreenElement ? 'fullscreen-exit' : 'fullscreen');
  });

  // ===== 键盘（等价参考组件 Mousetrap 绑定）=====

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') core.seek(Math.max(0, video.currentTime - 5));
    else if (e.key === 'ArrowRight') core.seek(video.currentTime + 5);
    else if (e.key === 'ArrowUp') { setVolume(video.volume + 0.05); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { setVolume(video.volume - 0.05); e.preventDefault(); }
  });

  // ===== 核心回调 → loader / 错误（覆盖 entry 传入的回调容器）=====

  callbacks.onLoading = (loading) => {
    loader.classList.toggle('hidden', !loading);
  };
  callbacks.onStatus = (msg) => {
    if (msg === '') callbacks.onLoading?.(false);
  };
  callbacks.onError = (msg) => {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    loader.classList.add('hidden');
  };

  // ===== 初始渲染 =====

  renderPlayState();
  renderVolume();
  renderTime();
  renderQuality();
  renderDecode();
  showControlsNow();
  // 初始显示控制栏，5s 后隐藏（如果视频在播放）——对齐参考组件 onMounted 逻辑
  setTimeout(() => {
    if (isPlaying()) scheduleHide();
  }, INACTIVITY_TIMEOUT);
}
