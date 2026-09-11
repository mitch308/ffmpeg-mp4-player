// public/demo.js — demo 页逻辑：URL 输入 → iframe 加载 /player.html + 生成嵌入代码
(function () {
  'use strict';

  var urlInput = document.getElementById('urlInput');
  var loadBtn = document.getElementById('loadBtn');
  var errorBox = document.getElementById('error');
  var embedArea = document.getElementById('embedArea');
  var playerFrame = document.getElementById('playerFrame');
  var embedCode = document.getElementById('embedCode');
  var embedCodeText = document.getElementById('embedCodeText');
  var copyBtn = document.getElementById('copyBtn');

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }
  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
  }

  function buildEmbedUrl(videoUrl, title) {
    // ui/quality/mode 等参数由嵌入方按需追加，demo 用默认值
    return location.origin + '/player.html' +
      '?url=' + encodeURIComponent(videoUrl) +
      '&title=' + encodeURIComponent(title) +
      '&autoplay=1';
  }

  function load() {
    clearError();
    var v = urlInput.value.trim();
    if (!v) { showError('请输入视频 URL'); return; }
    // 标题取路径最后一段（去扩展名），仅展示用
    var title = decodeURIComponent(v.split('/').pop() || '').replace(/\.[^.]+$/, '');
    var embed = buildEmbedUrl(v, title);
    playerFrame.src = embed;
    embedArea.classList.remove('hidden');
    embedCode.classList.remove('hidden');
    embedCodeText.textContent =
      '<iframe src="' + embed + '" allow="autoplay; fullscreen" allowfullscreen></iframe>';
  }

  loadBtn.addEventListener('click', load);
  urlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') load();
  });

  copyBtn.addEventListener('click', function () {
    var text = embedCodeText.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      copyBtn.textContent = '已复制';
      setTimeout(function () { copyBtn.textContent = '复制'; }, 1500);
    }
  });
})();
