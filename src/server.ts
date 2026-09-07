// src/server.ts — express app 工厂：从旧 server.js 转换，不再自行 listen
import express, { Express } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createSession,
  getSession,
  startStream,
  stopStream,
  destroySession,
  touchSession,
  getSessionCount,
  currentStrategy
} from './lib/session-manager';
import { getCaps } from './lib/hw-accel';

// 兼容两种运行位置：src/server.ts（vitest）→ 仓库根/public；dist/index.mjs|index.cjs → 包根/public
// CJS 产物中 esbuild 把 import.meta 垫成空对象（import.meta.url → undefined），退回 __filename
const here = path.dirname(
  typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
);
const publicDir = path.resolve(here, '../public');

export function createApp(options: { staticPlayer?: boolean } = {}): Express {
  const app = express();

  // 启动即探测硬件能力（结果缓存，供会话决策与状态查询）
  const hwCapsPromise = getCaps();

  app.use(express.json());
  if (options.staticPlayer !== false) {
    app.use(express.static(publicDir));
  }

  // 以下路由与旧 server.js 逐行一致（模块导入换成 src/lib/*.ts；app.listen 移除）：
  // createSession/getSession/startStream/stopStream/destroySession/touchSession/
  // getSessionCount/currentStrategy 的用法、CORS 头、close handler 的
  // session.process === myProc 校验均不动。

  // 创建会话
  app.post('/api/sessions', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'url is required' });
      }

      const session = await createSession(url);
      console.log(
        `Session created: ${session.id} for ${url} ` +
        `(strategy=${currentStrategy(session).label}, codec=${session.probeResult.codec}/${session.probeResult.pixFmt})`
      );

      const strategy = currentStrategy(session);
      res.json({
        sessionId: session.id,
        duration: session.probeResult.duration,
        width: session.probeResult.width,
        height: session.probeResult.height,
        codec: session.probeResult.codec,
        // 输出视频恒为 H.264；音频存在时恒为 AAC（拷贝或转码）
        audioCodec: session.probeResult.audio ? 'aac' : null,
        pixFmt: session.probeResult.pixFmt,
        streamMode: strategy.label,                       // copy | hw | sw
        encoder: strategy.encoder || strategy.label,      // 直通时无编码器
        hw: strategy.label === 'hw'
      });
    } catch (err) {
      console.error('Failed to create session:', (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 获取 fMP4 流
  app.get('/api/sessions/:id/stream', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const startTime = parseFloat(String(req.query.start)) || 0;

    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'video/mp4');

    let isClientConnected = true;
    console.log(`Stream start: session=${session.id}, start=${startTime}`);

    const myProc = startStream(
      session,
      startTime,
      (chunk) => {
        if (isClientConnected) {
          res.write(chunk);
        }
      },
      (err) => {
        console.error(`Stream error for session ${session.id}:`, err.message);
        if (isClientConnected && !res.writableEnded) {
          res.end();
        }
      },
      () => {
        if (isClientConnected && !res.writableEnded) {
          res.end();
        }
      }
    );

    // 客户端断开时只停止「本请求」启动的进程；若已被更新的 seek 请求替换，
    // 则不能误杀新进程（session.process !== myProc）。
    req.on('close', () => {
      isClientConnected = false;
      if (session.process === myProc) {
        stopStream(session);
      }
    });
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
  app.get('/api/status', async (req, res) => {
    const caps = await hwCapsPromise;
    res.json({
      activeSessions: getSessionCount(),
      hw: {
        encoder: caps.encoder,
        label: caps.label,
        mode: caps.mode
      }
    });
  });

  return app;
}
