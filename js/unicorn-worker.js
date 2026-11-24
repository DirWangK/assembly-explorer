/* unicorn-worker.js — Unicorn 调试 Worker（emu-core.js 的消息协议薄封装）
 *
 * 为什么放 Worker：
 *  1. emu_start 同步阻塞，放主线程会卡死 UI；
 *  2. wasm 陷阱（未映射内存等）会污染当前引擎句柄——会话在 Worker 内
 *     结束并重建句柄即可恢复，主线程 UI 无感知。
 *
 * 协议（入）：
 *   {type:'load',   ucFile}                      按架构加载 Unicorn 构建
 *   {type:'session', id, payload}                创建调试会话（映射内存/写镜像/挂 Hook）
 *   {type:'step',   id, n?, until?}              步入 n 条（until 用于"步过到返回地址"）
 *   {type:'resume', id, chunk?, breakpoints?}    连续运行（块间响应 pause / 断点）
 *   {type:'pause',  id}                          请求暂停（下一块边界生效）
 *   {type:'end',    id}                          结束会话
 * 协议（出）：
 *   {type:'ready'} / {type:'load-error', message}
 *   {type:'session-ready', id, pc, reason, report}
 *   {type:'session-state', id, state, pc, reason, regs, instrs, ms, report}
 *   {type:'error', id, message, fatal}           意外错误（宿主可重建 Worker）
 */
'use strict';

/* 依赖脚本带上与 Worker 相同的版本参数，避免代理/浏览器缓存住旧实现 */
const VERSION_Q = (function () {
  try {
    const v = new URL(self.location.href).searchParams.get('v');
    return v ? '?v=' + encodeURIComponent(v) : '';
  } catch (e) { return ''; }
})();

let uc = null;

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      importScripts('../js/emu-core.js' + VERSION_Q, '../vendor/unicorn_' + msg.ucFile + '.js');
      const factory = self.MUnicorn;
      uc = await factory();
      self.postMessage({ type: 'ready' });
      return;
    }
    if (!uc) { postError(msg.id, 'Unicorn 未加载', true); return; }

    if (msg.type === 'session') {
      closeSession();
      session = EmuCore.createSession(uc, msg.payload);
      repIdx = { trace: 0, mem: 0, consoleBytes: 0 };
      const meta = session.snapshotMeta();
      self.postMessage(Object.assign({ type: 'session-ready', id: msg.id, report: report() }, meta));
      return;
    }
    if (msg.type === 'step') {
      if (!session) { postError(msg.id, '无活动会话', false); return; }
      const meta = session.step(msg.n || 1, msg.until);
      self.postMessage(Object.assign({ type: 'session-state', id: msg.id, report: report() }, meta));
      return;
    }
    if (msg.type === 'resume') {
      if (!session) { postError(msg.id, '无活动会话', false); return; }
      const meta = await session.resume({ chunk: msg.chunk, breakpoints: msg.breakpoints });
      self.postMessage(Object.assign({ type: 'session-state', id: msg.id, report: report() }, meta));
      return;
    }
    if (msg.type === 'pause') {
      if (session) session.pause();
      return;
    }
    if (msg.type === 'end') {
      closeSession();
      self.postMessage({ type: 'session-state', id: msg.id, state: 'idle', report: { trace: [], memops: [], console: '' } });
      return;
    }
  } catch (err) {
    postError(msg && msg.id, String(err && err.message || err), true);
    closeSession();
  }

  function report() {
    return session ? session.report(repIdx) : { trace: [], memops: [], console: '' };
  }
  function closeSession() {
    if (session) { try { session.end(); } catch (e) {} session = null; }
  }
  function postError(id, message, fatal) {
    self.postMessage({ type: 'error', id, message, fatal });
  }
};

let session = null;
let repIdx = { trace: 0, mem: 0, consoleBytes: 0 };
