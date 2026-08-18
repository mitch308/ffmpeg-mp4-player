// lib/session-manager.js
const { createFfmpegProcess } = require('./ffmpeg-process');
const { probe } = require('./ffprobe');

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

const sessions = new Map();

/**
 * 创建会话并探测视频元数据
 * @param {string} url
 * @returns {Promise<{id: string, url: string, probeResult: object}>}
 */
async function createSession(url) {
  const id = generateId();
  const probeResult = await probe(url);
  const session = {
    id,
    url,
    probeResult,
    process: null,
    lastActivity: Date.now(),
    timeoutId: null
  };
  sessions.set(id, session);
  scheduleCleanup(session);
  return { id, url, probeResult };
}

/**
 * 获取会话
 * @param {string} id
 * @returns {object|undefined}
 */
function getSession(id) {
  return sessions.get(id);
}

/**
 * 启动/重启转码流
 * @param {object} session
 * @param {number} startTime
 * @param {(chunk: Buffer) => void} onData
 * @param {(err: Error) => void} onError
 * @param {(code: number|null) => void} onExit
 */
function startStream(session, startTime, onData, onError, onExit) {
  // 先停止旧进程
  stopStream(session);

  const proc = createFfmpegProcess(session.url, startTime, onData, onError, onExit);
  session.process = proc;
  touchSession(session);
}

/**
 * 停止当前转码流
 * @param {object} session
 */
function stopStream(session) {
  if (session.process) {
    session.process.kill();
    session.process = null;
  }
}

/**
 * 销毁会话
 * @param {string} id
 */
function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return;
  stopStream(session);
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  sessions.delete(id);
}

/**
 * 更新会话最后活动时间
 * @param {string|object} idOrSession
 */
function touchSession(session) {
  if (!session) return;
  session.lastActivity = Date.now();
  // 重置超时计时器
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  scheduleCleanup(session);
}

/**
 * 获取会话总数
 * @returns {number}
 */
function getSessionCount() {
  return sessions.size;
}

function scheduleCleanup(session) {
  session.timeoutId = setTimeout(() => {
    // 如果 session 正在 streaming（有活跃进程），不清理
    if (session.process) {
      scheduleCleanup(session); // 重新计时
      return;
    }
    destroySession(session.id);
  }, SESSION_TIMEOUT_MS);
}

function generateId() {
  return Math.random().toString(36).substring(2, 10) +
         Date.now().toString(36);
}

module.exports = {
  createSession,
  getSession,
  startStream,
  stopStream,
  destroySession,
  touchSession,
  getSessionCount
};
