/* engines.js — 引擎层：Capstone 实例缓存、Keystone/Unicorn Worker 宿主、引擎状态 pill
 * 依赖：js/core/arches.js、vendor/capstone.js、js/ui/{dom,state,log}.js */
'use strict';

(function () {
  const AE = window.AE;
  const { $, I } = AE.dom;
  const state = AE.state;
  const LOG = AE.log;

  let CS = null;                 // Capstone 模块（MCapstone() 的产物）
  const csCache = new Map();     // archId|syntax -> Capstone 实例

  function arch() { return ARCHES[state.archId]; }
  function regList(a) { return ArchesModule.regList(a); }

  function getCs() {
    const key = state.archId + '|' + state.syntax;
    if (!csCache.has(key)) {
      const a = arch();
      const inst = new CS.Capstone(CS[a.cs.arch], a.cs.modes.reduce((acc, n) => acc | CS[n], 0));
      const syn = a.syntaxes && a.syntaxes[state.syntax];
      if (syn && syn.length) inst.option(CS.OPT_SYNTAX, CS[syn[0]]);
      csCache.set(key, inst);
    }
    return csCache.get(key);
  }

  async function loadCapstone() {
    CS = await MCapstone();
    return CS;
  }

  /* 汇编结果形状的空壳（引擎挂死/加载失败时使用） */
  function hangResult(message) {
    return {
      ok: false,
      errors: [{ line: 0, message: message || I('status.engineHang') }],
      segments: [], image: [], codeSegments: [], dataSegments: [],
      symbols: {}, equ: {}, startAddr: 0, untilAddr: 0,
      lineInfo: [], deferredAny: false, totalInsns: 0, totalBytes: 0, cleaned: '',
    };
  }

  /* ---------------- Keystone Worker 宿主（带看门狗） ----------------
   * keystone wasm 对个别畸形输入会挂死——Worker + 看门狗保证主线程永不冻结。 */
  function makeKsHost() {
    return {
      worker: null, seq: 0, pending: new Map(), readyPromise: null,
      ensure() {
        if (!this.worker) {
          this.worker = new Worker('js/workers/keystone-worker.js?v=' + AE.BUILD);
          this.worker.onmessage = (ev) => this.onMsg(ev.data);
          this.worker.onerror = () => this.respawn();
          this.readyPromise = new Promise((res, rej) => { this._res = res; this._rej = rej; });
          this.worker.postMessage({ type: 'init' });
        }
        return this.readyPromise;
      },
      onMsg(m) {
        if (!m) return;
        if (m.type === 'ready') { LOG.ok('KS', 'Keystone 就绪'); this._res(); }
        else if (m.type === 'load-error') { LOG.error('KS', 'Keystone 加载失败: ' + m.message); this._rej(new Error(m.message)); }
        else {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); p(m); }
        }
      },
      respawn() {
        if (!this.worker) return;
        const w = this.worker;
        this.worker = null; this.readyPromise = null;
        LOG.warn('KS', '汇编 Worker 已重建（上一次调用超时或异常）');
        setTimeout(() => { try { w.terminate(); } catch (e) {} }, 30);
      },
      call(msg, timeoutMs) {
        return new Promise((resolve) => {
          this.ensure().then(() => {
            const id = ++this.seq;
            const timer = setTimeout(() => {
              if (this.pending.has(id)) {
                this.pending.delete(id);
                LOG.error('KS', '汇编引擎响应超时（' + (timeoutMs || 10000) + 'ms），已自动重建');
                resolve({ type: 'result', res: hangResult() });
                this.respawn(); // 挂死的引擎整体重建
              }
            }, timeoutMs || 10000);
            this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
            this.worker.postMessage(Object.assign({ id }, msg));
          }).catch((e) => {
            LOG.error('KS', 'Worker 加载失败: ' + e.message);
            resolve({ type: 'result', res: hangResult('Worker 加载失败: ' + e.message) });
          });
        });
      },
    };
  }

  /* ---------------- Unicorn Worker 宿主 ---------------- */
  function makeUcHost() {
    return {
      worker: null, seq: 0, pending: new Map(), readyPromise: null,
      ensure() {
        if (!this.worker) {
          this.worker = new Worker('js/workers/unicorn-worker.js?v=' + AE.BUILD);
          this.worker.onmessage = (ev) => this.onMsg(ev.data);
          this.worker.onerror = () => this.respawn();
          this.readyPromise = new Promise((res, rej) => { this._res = res; this._rej = rej; });
          this.worker.postMessage({ type: 'load', ucFile: arch().uc.file });
        }
        return this.readyPromise;
      },
      onMsg(m) {
        if (!m) return;
        if (m.type === 'ready') { LOG.ok('UC', 'Unicorn(' + arch().uc.file + ') 就绪'); this._res(); }
        else if (m.type === 'load-error') { LOG.error('UC', 'Unicorn 加载失败: ' + m.message); this._rej(new Error(m.message)); }
        else {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); p(m); }
          if (m.type === 'error' && m.fatal) {
            LOG.error('UC', '模拟引擎致命错误: ' + (m.message || '?'));
            this.respawn();
          }
        }
      },
      respawn() {
        if (!this.worker) return;
        const w = this.worker;
        this.worker = null; this.readyPromise = null;
        LOG.warn('UC', '模拟 Worker 已重建');
        setTimeout(() => { try { w.terminate(); } catch (e) {} }, 30);
      },
      call(msg) {
        return new Promise((resolve) => {
          this.ensure().then(() => {
            const id = ++this.seq;
            const timer = setTimeout(() => {
              if (this.pending.has(id)) {
                this.pending.delete(id);
                LOG.error('UC', '模拟引擎响应超时（60s），已自动重建');
                resolve({ type: 'error', id, message: 'Worker timeout', fatal: true });
                this.respawn();
              }
            }, 60000);
            this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
            this.worker.postMessage(Object.assign({ id }, msg));
          }).catch((e) => {
            LOG.error('UC', 'Unicorn 加载失败: ' + e.message);
            resolve({ type: 'error', id: -1, message: 'Unicorn load failed: ' + e.message, fatal: true });
          });
        });
      },
    };
  }

  function updatePills() {
    const p = state.enginePills;
    const a = arch();
    const pill = (ok, name) => ok
      ? '<span class="pill on">' + name + ' ✓</span>'
      : '<span class="pill">' + name + ' …</span>';
    const el = $('status');
    if (el) {
      el.innerHTML = pill(p.ks, 'Keystone') + pill(p.cs, 'Capstone') +
        pill(p.uc, I('engines.uc', { arch: a.uc.file.toUpperCase() }));
    }
  }

  AE.engines = {
    arch, regList, getCs, loadCapstone, hangResult,
    makeKsHost, makeUcHost, updatePills,
    ks: null,   // app.js 启动时赋值
    uc: null,
  };
})();
