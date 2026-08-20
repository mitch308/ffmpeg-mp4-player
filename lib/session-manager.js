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

  const proc = createFfmpegProcess(session.url, startTime, onData, onError, (code) => {
    // 进程自然退出（如播放至结尾 code=0），释放引用，
    // 否则 scheduleCleanup 会因 session.process 为 truthy 而无限续期，导致会话泄漏
    if (session.process === proc) session.process = null;
    onExit(code);
  });
  session.process = proc;
  touchSession(session);
  return proc;  // 供调用方在 close handler 中校验是否仍为当前进程，避免旧请求误杀新进程
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
 * @param {object} session
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
  let id;
  do {
    id = Math.random().toString(36).substring(2, 10) +
         Date.now().toString(36);
  } while (sessions.has(id)); // 碰撞防御：极小概率撞上现存会话 id 时重新生成
  return id;
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
