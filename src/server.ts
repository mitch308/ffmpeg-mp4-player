// src/server.ts — express app 工厂：从旧 server.js 转换，不再自行 listen
import express, { Express } from 'express';
import path from 'path';
import { existsSync } from 'fs';
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
import { parseQuality, parseMode, availableQualities } from './lib/quality';
import { getCaps } from './lib/hw-accel';

// 兼容两种运行位置：src/server.ts（vitest）→ 仓库根/public；dist/index.mjs|index.cjs → 包根/public
// CJS 产物中 esbuild 把 import.meta 垫成空对象（import.meta.url → undefined），退回 __filename
const here = path.dirname(
  typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
);
const publicDir = path.resolve(here, '../public');

// 前端 TS 构建产物（player.html 等，见 vite.config.client.ts）：
// dist 产物模式下与 public 同级（here=<pkg>/dist → <pkg>/dist/client）；
// 源码模式（vitest，here=<repo>/src）下同一相对路径解析到 <repo>/dist/client，两种位置统一。
// 不要把 <repo>/src/client 加进候选：那是未编译的前端源码，命中后静态服务会指错目录，
// server.test 的 dist/client 断言也随之空转。
const clientDir = [path.resolve(here, '../dist/client')].find((p) => existsSync(p));

export function createApp(options: { staticPlayer?: boolean } = {}): Express {
  const app = express();

  // 启动即探测硬件能力（结果缓存，供会话决策与状态查询）
  const hwCapsPromise = getCaps();

  app.use(express.json());
  if (options.staticPlayer !== false) {
    // 先 public（demo 页）后 dist/client（播放器页）：两目录文件名不冲突，
    // 顺序仅决定同名文件（不存在）的优先级
    app.use(express.static(publicDir));
    if (clientDir) app.use(express.static(clientDir));
  }

  // 以下路由与旧 server.js 逐行一致（模块导入换成 src/lib/*.ts；app.listen 移除）：
  // createSession/getSession/startStream/stopStream/destroySession/touchSession/
  // getSessionCount/currentStrategy 的用法、CORS 头、close handler 的
  // session.process === myProc 校验均不动。

  // 创建会话
  app.post('/api/sessions', async (req, res) => {
    try {
      const { url, quality, mode } = req.body ?? {};
      if (!url) {
        return res.status(400).json({ error: 'url is required' });
      }
      // 画质档/解码模式：非法值 400；合法值持久化到会话（后续流请求沿用）
      const q = parseQuality(quality ?? 'origin');
      const m = parseMode(mode ?? 'auto');
      if (!q) return res.status(400).json({ error: `invalid quality: ${quality}` });
      if (!m) return res.status(400).json({ error: `invalid mode: ${mode}` });

      const session = await createSession(url, { quality: q, mode: m });
      // 画质档必须在源可用范围内（不放大）；不可用时立即销毁会话，不留副作用
      if (!availableQualities(session.probeResult).includes(q)) {
        destroySession(session.id);
        return res.status(400).json({
          error: `quality ${q} 不可用（源 ${session.probeResult.width}x${session.probeResult.height}）`
        });
      }
      console.log(
        `Session created: ${session.id} for ${url} ` +
        `(strategy=${currentStrategy(session).label}, codec=${session.probeResult.codec}/${session.probeResult.pixFmt}, ` +
        `quality=${q}, mode=${m})`
      );

      const strategy = currentStrategy(session);
      const caps = await hwCapsPromise;
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
        hw: strategy.label === 'hw',
        // 可用画质档（降序，origin 恒在末位）与硬编可用性（前端渲染菜单/显隐"硬解"选项）
        qualities: availableQualities(session.probeResult),
        hwAvailable: caps.encoder !== 'libx264',
        requestedQuality: q,
        requestedMode: m
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

    // 可选画质/解码参数：非法值 400；合法值经 startStream 持久化到会话
    const quality = req.query.quality !== undefined ? parseQuality(req.query.quality) : undefined;
    const mode = req.query.mode !== undefined ? parseMode(req.query.mode) : undefined;
    if (req.query.quality !== undefined && !quality) {
      return res.status(400).json({ error: `invalid quality: ${req.query.quality}` });
    }
    if (req.query.mode !== undefined && !mode) {
      return res.status(400).json({ error: `invalid mode: ${req.query.mode}` });
    }
    // 显式携带合法画质档时，还需在源可用范围内（不放大）；未携带沿用会话已持久化值
    if (quality && !availableQualities(session.probeResult).includes(quality)) {
      return res.status(400).json({
        error: `quality ${quality} 不可用（源 ${session.probeResult.width}x${session.probeResult.height}）`
      });
    }

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
      },
      { quality: quality ?? undefined, mode: mode ?? undefined }
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
