// server.js
const express = require('express');
const path = require('path');
const {
  createSession,
  getSession,
  startStream,
  stopStream,
  destroySession,
  touchSession,
  getSessionCount
} = require('./lib/session-manager');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 创建会话
app.post('/api/sessions', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    const session = await createSession(url);
    console.log(`Session created: ${session.id} for ${url}`);

    res.json({
      sessionId: session.id,
      duration: session.probeResult.duration,
      width: session.probeResult.width,
      height: session.probeResult.height,
      codec: session.probeResult.codec
    });
  } catch (err) {
    console.error('Failed to create session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 获取 fMP4 流
app.get('/api/sessions/:id/stream', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const startTime = parseFloat(req.query.start) || 0;

  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'video/mp4');

  let isClientConnected = true;
  req.on('close', () => {
    isClientConnected = false;
    // 客户端断开时不销毁 session，只停止 stream
    stopStream(session);
  });

  console.log(`Stream start: session=${session.id}, start=${startTime}`);

  startStream(
    session,
    startTime,
    (chunk) => {
      if (isClientConnected) {
        res.write(chunk);
      }
    },
    (err) => {
      console.error(`Stream error for session ${session.id}:`, err.message);
      if (isClientConnected) {
        res.end();
      }
    },
    (code) => {
      console.log(`Stream ended for session ${session.id}, code=${code}`);
      if (isClientConnected) {
        res.end();
      }
    }
  );
});

// 销毁会话
app.delete('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  destroySession(req.params.id);
  console.log(`Session destroyed: ${req.params.id}`);
  res.json({ ok: true });
});

// 健康检查
app.get('/api/status', (req, res) => {
  res.json({
    activeSessions: getSessionCount()
  });
});

app.listen(PORT, () => {
  console.log(`ffmpeg-player server running at http://localhost:${PORT}`);
});
