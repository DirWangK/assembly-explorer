/* main.js — UI 编排：
 *   Keystone（汇编）→ Capstone（反汇编回环）→ Unicorn（单步调试/连续执行）
 *   主题 / 多语言 / 断点 / 步入步过 / 分享链接
 */
'use strict';

const $ = (id) => document.getElementById(id);
const I = (key, params) => I18N.t(key, params);

const HELLO = 'Hello, WASM!\n';

const state = {
  archId: 'x86_64',
  syntax: 'intel',
  base: 0x10000,
  maxCount: 200000,
  autoEmu: true,
  theme: 'dark',
  hexMode: false,       // true = 由机器码输入驱动流水线
  hexDirty: false,      // 用户手动编辑过机器码输入（切 Tab 时不覆盖）
  last: null,           // 最近一次汇编结果（源码或机器码驱动）
  enginePills: { ks: false, cs: false, uc: false },
  loadedExample: null,
};

/* ---------------- 调试器状态 ---------------- */
const dbg = {
  seq: 0,
  session: null,        // 活动会话 promise 句柄标记
  state: 'idle',        // idle | ready | running | paused | ended | error | pausing
  pc: 0,
  reason: { type: 'init' },
  instrs: 0, ms: 0,
  repIdx: { trace: 0, mem: 0, consoleBytes: 0 },
  traceRows: [],        // 已注解的轨迹行 HTML
  memopsRows: [],
  consoleText: '',
  initRegs: {},         // name -> BigInt（会话启动时的初值）
  breakpoints: new Set(),
  busy: false,
};

let CS = null;
let editor = null;
let ucHost = null;
let ksHost = null;

/* ---------------- 小工具 ---------------- */

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtHex(v, widthBytes) {
  const b = BigInt(v);
  const w = widthBytes * 2;
  return b < 0n
    ? '-0x' + (-b).toString(16).toUpperCase().padStart(w, '0')
    : '0x' + b.toString(16).toUpperCase().padStart(w, '0');
}

function utf8Bytes(s) { return Array.from(new TextEncoder().encode(s)); }

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function arch() { return ARCHES[state.archId]; }
function regList(a) { return ArchesModule.regList(a); }

/* ---------------- Keystone 汇编 Worker 宿主（带看门狗） ----------------
 * keystone wasm 对个别畸形输入会挂死——Worker + 看门狗保证主线程永不冻结。 */
function makeKsHost() {
  const host = {
    worker: null, seq: 0, pending: new Map(), readyPromise: null,
    ensure() {
      if (!this.worker) {
        this.worker = new Worker('js/keystone-worker.js');
        this.worker.onmessage = (ev) => this.onMsg(ev.data);
        this.worker.onerror = () => this.respawn();
        this.readyPromise = new Promise((res, rej) => { this._res = res; this._rej = rej; });
        this.worker.postMessage({ type: 'init' });
      }
      return this.readyPromise;
    },
    onMsg(m) {
      if (!m) return;
      if (m.type === 'ready') this._res();
      else if (m.type === 'load-error') this._rej(new Error(m.message));
      else {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p(m); }
      }
    },
    respawn() {
      if (!this.worker) return;
      const w = this.worker;
      this.worker = null; this.readyPromise = null;
      setTimeout(() => { try { w.terminate(); } catch (e) {} }, 30);
    },
    call(msg, timeoutMs) {
      return new Promise((resolve) => {
        this.ensure().then(() => {
          const id = ++this.seq;
          const timer = setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              resolve({ type: 'result', res: hangResult() });
              this.respawn(); // 挂死的引擎整体重建
            }
          }, timeoutMs || 10000);
          this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
          this.worker.postMessage(Object.assign({ id }, msg));
        }).catch((e) => resolve({ type: 'result', res: hangResult('Worker 加载失败: ' + e.message) }));
      });
    },
  };
  return host;
}

function hangResult(message) {
  return {
    ok: false,
    errors: [{ line: 0, message: message || I('status.engineHang') }],
    segments: [], image: [], codeSegments: [], dataSegments: [],
    symbols: {}, equ: {}, startAddr: 0, untilAddr: 0,
    lineInfo: [], deferredAny: false, totalInsns: 0, totalBytes: 0, cleaned: '',
  };
}

/* ---------------- Keystone / Capstone 实例缓存 ---------------- */

const csCache = new Map();

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

/* ---------------- Unicorn Worker 宿主 ---------------- */

function makeUcHost() {
  const host = {
    worker: null, seq: 0, pending: new Map(), readyPromise: null,
    ensure() {
      if (!this.worker) {
        this.worker = new Worker('js/unicorn-worker.js');
        this.worker.onmessage = (ev) => this.onMsg(ev.data);
        this.worker.onerror = () => this.respawn();
        this.readyPromise = new Promise((res, rej) => { this._res = res; this._rej = rej; });
        this.worker.postMessage({ type: 'load', ucFile: arch().uc.file });
      }
      return this.readyPromise;
    },
    onMsg(m) {
      if (!m) return;
      if (m.type === 'ready') { this._res(); }
      else if (m.type === 'load-error') { this._rej(new Error(m.message)); }
      else {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p(m); }
        if (m.type === 'error' && m.fatal) this.respawn();
      }
    },
    respawn() {
      if (!this.worker) return;
      const w = this.worker;
      this.worker = null; this.readyPromise = null;
      setTimeout(() => { try { w.terminate(); } catch (e) {} }, 30);
    },
    call(msg) {
      return new Promise((resolve) => {
        this.ensure().then(() => {
          const id = ++this.seq;
          const timer = setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              resolve({ type: 'error', id, message: 'Worker timeout', fatal: true });
              this.respawn();
            }
          }, 60000);
          this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
          this.worker.postMessage(Object.assign({ id }, msg));
        }).catch((e) => resolve({ type: 'error', id: -1, message: 'Unicorn load failed: ' + e.message, fatal: true }));
      });
    },
  };
  return host;
}

/* ---------------- 主题 / 语言 ---------------- */

function applyTheme(mode) {
  state.theme = mode;
  try { localStorage.setItem('asmexplorer.theme', mode); } catch (e) {}
  let effective = mode;
  if (mode === 'system') {
    effective = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', effective);
  document.querySelectorAll('#theme-seg button').forEach(b => b.classList.toggle('on', b.dataset.themeOpt === mode));
}
function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('asmexplorer.theme') || 'dark'; } catch (e) {}
  applyTheme(saved);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme('system');
    });
  }
}
function applyLang(lang) {
  I18N.setLang(lang);
  document.querySelectorAll('#lang-seg button').forEach(b => b.classList.toggle('on', b.dataset.langOpt === lang));
  refreshSyntaxSelect(); refreshBaseInput();
}

/* ---------------- 流水线阶段 1：预处理 + Keystone 汇编（Worker 执行） ---------------- */

let assembleSeq = 0;
async function assemble() {
  if (state.hexMode) { assembleFromHex(); return; }
  const a = arch();
  const seq = ++assembleSeq;
  const r = await ksHost.call({
    type: 'assemble',
    params: { archId: state.archId, syntax: state.syntax, source: editor.value, base: a.layout.single ? 0 : state.base },
  });
  if (seq !== assembleSeq) return; // 已有更新的输入
  const res = r.res;
  state.last = res;

  editor.setLineStates(res.lineInfo.map(li => {
    if (!li.ok) return { cls: 'err', title: li.error || '' };
    if (li.deferred) return { cls: 'warn', title: I('status.deferredNote') };
    return null;
  }));

  const badLines = res.lineInfo.map((l, i) => l.ok ? -1 : i).filter(i => i >= 0);
  if (res.ok) {
    $('src-status').innerHTML =
      '<span class="ok-pill">✔ ' + I('status.insns', { n: res.totalInsns, b: res.totalBytes }) + '</span>' +
      (res.deferredAny ? '<span class="warn-note">' + I('status.deferredNote') + '</span>' : '');
  } else {
    $('src-status').innerHTML =
      '<span class="err-pill">✘ ' + I('status.errAt', { lines: badLines.map(i => i + 1).join(', ') }) + '</span>' +
      '<span class="hint">' + I('status.errHint') + '</span>';
  }

  renderOutput();
  scheduleDebug();
}

/* ---------------- 流水线阶段 1b：机器码输入驱动（Capstone 反汇编） ---------------- */

function concatImage(image) {
  let total = 0;
  for (const s of image) total += s.bytes.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const s of image) { out.set(s.bytes, off); off += s.bytes.length; }
  return out;
}

const assembleFromHex = debounce(function () {
  if (!state.hexMode) return;
  const a = arch();
  const base = a.layout.single ? 0 : state.base;
  const parsed = HexIO.parseHexInput($('hexin').value);
  const bytes = parsed.bytes;
  const cs = getCs();
  const insns = bytes.length ? cs.disasm(bytes, base) : [];
  const pseudo = {
    ok: bytes.length > 0 && parsed.errors.length === 0,
    errors: parsed.errors.map(e => ({ line: e.line, message: e.message })),
    segments: bytes.length ? [{ kind: 'code', addr: base, bytes, parts: [], labels: [] }] : [],
    image: bytes.length ? [{ addr: base, bytes, kind: 'code' }] : [],
    codeSegments: bytes.length ? [{ addr: base, bytes, parts: [], labels: [] }] : [],
    dataSegments: [],
    symbols: {},
    equ: {},
    startAddr: base,
    untilAddr: Math.max(base + bytes.length, base + 1),
    lineInfo: [],
    deferredAny: false,
    totalInsns: insns.length,
    totalBytes: bytes.length,
    cleaned: '',
  };
  state.last = pseudo;

  if (parsed.errors.length || !bytes.length) {
    /* 无效输入：清空旧解码并复位调试器，避免误导 */
    state.last = null;
    if (parsed.errors.length) {
      $('hexin-status').innerHTML = '<span class="err-pill">✘ ' +
        escHtml(parsed.errors.map(e => '第 ' + (e.line + 1) + ' 行：' + e.message).join(' / ')) + '</span>';
    } else {
      $('hexin-status').innerHTML = '<span class="hint">' + I('waitValid') + '</span>';
    }
    $('src-status').innerHTML = '<span class="hint">' + I('hexin.modeNote') + '</span>';
    editor.setLineStates([]);
    endSession(true);
    renderOutput();
    return;
  }
  if (bytes.length) {
    $('hexin-status').innerHTML = '<span class="ok-pill">✔ ' + I('hexin.statusOk', { n: bytes.length, m: insns.length }) + '</span>';
  }
  $('src-status').innerHTML = '<span class="hint">' + I('hexin.modeNote') + '</span>';
  editor.setLineStates([]);

  renderOutput();
  scheduleDebug();
}, 300);

/* 机器码 → 汇编源码（Capstone 反汇编 + 分支标签生成），填入编辑器并切回源码模式 */
function hexinToAsm() {
  const res = state.last;
  if (!res || !res.ok || !res.codeSegments.length) { toast(I('hexin.needBytes')); return; }
  const cs = getCs();
  const seg = res.codeSegments[0];
  const insns = cs.disasm(seg.bytes, seg.addr).map(i => ({
    address: Number(i.address), size: Number(i.size), mnemonic: i.mnemonic, op_str: i.op_str,
  }));
  const gen = HexIO.disasmToSource(insns, arch());
  editor.value = gen.source;
  state.hexDirty = false;
  setHexMode(false); // 切回源码模式并自动汇编
  toast(I('hexin.toAsmDone', { n: insns.length }));
}

/* 汇编产物 → 机器码文本（显式重新同步） */
function hexinGenFromAsm() {
  const res = state.last;
  if (!res || !res.ok || !res.image.some(s => s.bytes.length)) { toast(I('waitValid')); return; }
  $('hexin').value = HexIO.formatHexDump(concatImage(res.image), 16);
  state.hexDirty = false;
  assembleFromHex();
}

/* 文件导入：.s/.asm/.txt → 汇编源码；其余（.bin/.hex/.dump 等）→ 机器码 */
function hexinImportFile(file) {
  if (!file) return;
  const isSource = /\.(s|asm|S|ASM|txt)$/i.test(file.name);
  if (isSource) {
    const fr = new FileReader();
    fr.onload = () => {
      editor.value = String(fr.result);
      state.hexDirty = false;
      setHexMode(false);
      toast(I('hexin.importDone', { n: file.name }));
    };
    fr.readAsText(file);
  } else {
    const fr = new FileReader();
    fr.onload = () => {
      const u8 = new Uint8Array(fr.result);
      state.hexMode = true;
      syncModeSeg();
      $('hexin').value = HexIO.formatHexDump(u8, 16);
      state.hexDirty = false;
      toggleViews();
      assembleFromHex();
      toast(I('hexin.importDone', { n: file.name }));
    };
    fr.readAsArrayBuffer(file);
  }
}

/* ---------------- 模式切换（源码 ⇄ 机器码） ---------------- */

function syncModeSeg() {
  $('tab-disasm').classList.toggle('on', !state.hexMode);
  $('tab-hexin').classList.toggle('on', state.hexMode);
}

function toggleViews() {
  $('disasm-view').classList.toggle('hidden', state.hexMode);
  $('hexin-view').classList.toggle('hidden', !state.hexMode);
}

function setHexMode(on) {
  state.hexMode = on;
  syncModeSeg();
  toggleViews();
  if (on) {
    /* 自动同步：从汇编产物生成机器码文本（用户已有手改内容则不覆盖） */
    if (!state.hexDirty) {
      const res = state.last;
      if (res && res.ok && res.image.some(s => s.bytes.length)) {
        $('hexin').value = HexIO.formatHexDump(concatImage(res.image), 16);
      }
    }
    assembleFromHex();
  } else {
    assemble(); // 回到源码驱动
  }
}

/* ---------------- 流水线阶段 2：Capstone 反汇编回环 ---------------- */

function renderOutput() {
  const res = state.last;
  const hexEl = $('hexdump'), disEl = $('disasm'), dataEl = $('datadump'), metaEl = $('out-meta');
  if (!res || !res.ok) {
    hexEl.innerHTML = '<div class="empty">' + I('waitValid') + '</div>';
    disEl.innerHTML = '<div class="empty">—</div>';
    $('disasm-hex').innerHTML = '<div class="empty">—</div>';
    dataEl.innerHTML = '<div class="empty">—</div>';
    metaEl.textContent = '';
    return;
  }
  const image = res.image;
  if (!image.length || !image.some(s => s.bytes.length)) {
    hexEl.innerHTML = '<div class="empty">' + I('status.empty') + '</div>';
    disEl.innerHTML = '<div class="empty">' + I('status.empty') + '</div>';
    dataEl.innerHTML = '';
    metaEl.textContent = I('status.empty');
    return;
  }

  /* 十六进制视图（按段） */
  const rows = [];
  for (const seg of image) {
    for (let i = 0; i < seg.bytes.length; i += 16) {
      const chunk = [];
      for (let j = i; j < Math.min(i + 16, seg.bytes.length); j++) {
        chunk.push('<span class="hx">' + seg.bytes[j].toString(16).padStart(2, '0') + '</span>');
      }
      rows.push('<div class="hexrow"><span class="hxoff">' + fmtHex(seg.addr + i, 4) + '</span>' + chunk.join(' ') + '</div>');
    }
  }
  hexEl.innerHTML = rows.join('');

  /* Capstone 反汇编（逐代码段）：行号徽标 + 断点 + PC 标记 */
  const cs = getCs();
  const pcMasked = (dbg.pc & (arch().thumb ? ~1 : 0xFFFFFFFF)) >>> 0;
  const pcVisible = dbg.state !== 'idle';
  const disRows = [];
  res.segments.forEach((seg, segIdx) => {
    if (seg.kind !== 'code' || !seg.bytes.length) return;
    const insns = cs.disasm(seg.bytes, seg.addr);
    /* 行号徽标：lineInfo 中该段已回填 offset 的行 */
    const lineMap = [];
    res.lineInfo.forEach((l, i) => {
      if (l.segIndex === segIdx && l.bytes && l.bytes.length) {
        lineMap.push({ off: l.offset, line: i, len: l.bytes.length });
      }
    });
    let li = 0;
    for (const ins of insns) {
      const addr = Number(ins.address);
      let badge = '';
      if (lineMap.length) {
        while (li + 1 < lineMap.length && lineMap[li + 1].off <= addr - seg.addr) li++;
        const m = lineMap[li];
        if (m && addr - seg.addr >= m.off && addr - seg.addr < m.off + m.len) {
          badge = '<span class="linebadge">L' + (m.line + 1) + '</span>';
        }
      }
      const bs = Array.from(ins.bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      const cls = ['insrow'];
      if (dbg.breakpoints.has(addr)) cls.push('has-bp');
      if (pcVisible && addr === pcMasked) cls.push('at-pc');
      disRows.push('<div class="' + cls.join(' ') + '" data-addr="' + addr + '">' + badge +
        '<span class="insaddr">' + fmtHex(addr, 4) + '</span>' +
        '<span class="insbytes">' + bs + '</span>' +
        '<span class="insmnem">' + escHtml(ins.mnemonic) + '</span>' +
        '<span class="insops">' + escHtml(ins.op_str) + '</span></div>');
    }
    let covered = insns.reduce((acc, i) => acc + Number(i.size), 0);
    if (covered < seg.bytes.length) {
      for (let o = covered; o < seg.bytes.length; o++) {
        disRows.push('<div class="insrow unparsed"><span class="insaddr">' + fmtHex(seg.addr + o, 4) +
          '</span><span class="insbytes">' + seg.bytes[o].toString(16).padStart(2, '0') +
          '</span><span class="insops">' + I('status.unmapped') + '</span></div>');
      }
    }
  });
  disEl.innerHTML = disRows.join('') || '<div class="empty">—</div>';
  $('disasm-hex').innerHTML = disEl.innerHTML; // 机器码输入模式下共用同一份反汇编
  metaEl.textContent = res.totalInsns + ' insn · ' + res.totalBytes + ' B' +
    (res.deferredAny ? I('status.lineMapUnavailable') : '');

  /* 数据段 dump（hex + ascii） */
  const dataRows = [];
  for (const seg of res.dataSegments) {
    if (!seg.bytes.length) continue;
    for (let i = 0; i < seg.bytes.length; i += 16) {
      const slice = seg.bytes.slice(i, Math.min(i + 16, seg.bytes.length));
      const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = Array.from(slice).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
      dataRows.push('<div class="datarow"><span class="insaddr">' + fmtHex(seg.addr + i, 4) +
        '</span><span class="datahex">' + escHtml(hex) + '</span>' +
        '<span class="dataascii">|' + escHtml(ascii) + '|</span></div>');
    }
  }
  dataEl.innerHTML = dataRows.join('') || '<div class="empty">—</div>';
}

/* ---------------- 流水线阶段 3：Unicorn 调试会话 ---------------- */

function buildPayload(res) {
  const a = arch();
  const base = a.layout.single ? 0 : state.base;
  const { payload, warnings } = SessionPayload.buildSessionPayload({
    arch: a, base, res,
    initRegs: $('initregs').value,
    initMem: $('initmem').value,
    maxCount: state.maxCount,
  });
  if (warnings.regs.length) $('emu-warn').textContent = I('emuwarn.badRegs', { list: warnings.regs.join(' / ') });
  else if (warnings.mem.length) $('emu-warn').textContent = I('emuwarn.badMem', { list: warnings.mem.join(' / ') });
  else $('emu-warn').textContent = '';
  return payload;
}

async function startDebugSession() {
  return runSession(true);
}

/* 创建会话并渲染初始状态；autoResume=true 时连续运行到结束/断点 */
async function runSession(autoResume) {
  const res = state.last;
  if (!res || !res.ok || !res.image.some(s => s.bytes.length)) {
    dbg.state = 'idle';
    renderDbgState();
    $('emu-meta').textContent = I('waitValid');
    return;
  }
  endSession(false);
  const seq = ++dbg.seq;
  dbg.busy = true;
  setDbgStateChip('running');
  const r = await ucHost.call({ type: 'session', payload: buildPayload(res) });
  if (seq !== dbg.seq) return;
  dbg.busy = false;
  if (r.type === 'error') {
    dbg.state = 'error';
    dbg.errorMsg = r.message;
    dbg.reason = { type: 'fatal', message: r.message };
    renderDbgState();
    return;
  }
  // 会话就绪：初始化视图
  dbg.repIdx = { trace: 0, mem: 0, consoleBytes: 0 };
  dbg.traceRows = []; dbg.memopsRows = []; dbg.consoleText = '';
  buildInitRegs(r.regs);
  applySessionState(r);
  if (!autoResume) return; // 停在起点（paused），可立即步入/步过
  // 自动连续运行
  const r2 = await ucHost.call({ type: 'resume', chunk: 2000, breakpoints: [...dbg.breakpoints] });
  if (seq !== dbg.seq) return;
  applySessionState(r2);
}

function buildInitRegs(currentRegs) {
  const a = arch();
  dbg.initRegs = {};
  for (const [name] of regList(a)) dbg.initRegs[name] = 0n;
  if (a.layout.spInit !== undefined && a.spReg) dbg.initRegs[a.spReg[0]] = BigInt(a.layout.spInit);
  const { regs: userRegs } = SessionPayload.parseInitRegs(a, $('initregs').value);
  const nameByConst = {};
  regList(a).forEach(([n, c]) => nameByConst[c] = n);
  for (const [c, v] of userRegs) if (nameByConst[c]) dbg.initRegs[nameByConst[c]] = BigInt(v);
}

function applySessionState(r) {
  dbg.state = r.state;
  dbg.pc = r.pc;
  dbg.reason = r.reason;
  dbg.instrs = r.instrs;
  dbg.ms = r.ms;
  // 增量数据
  const rep = r.report || { trace: [], memops: [], console: '' };
  const cs = getCs();
  for (const [addr, size] of rep.trace) {
    dbg.traceRows.push(annotateTrace(addr, size, cs));
  }
  for (const [t, addr, size, val] of rep.memops) {
    dbg.memopsRows.push('<div class="memrow"><span class="memrw ' + (t === 'W' ? 'w' : 'r') + '">' +
      (t === 'W' ? I('row.write') : I('row.read')) + '</span>' +
      '<span class="memaddr">' + fmtHex(addr, 4) + '</span>' +
      '<span class="memsize">' + size + 'B</span>' +
      '<span class="memval">' + (val !== '' ? fmtHex(val, 8) : '') + '</span></div>');
  }
  if (rep.console) dbg.consoleText += rep.console;
  renderRegs(r.regs);
  renderTrace();
  renderMemops();
  renderConsole();
  renderDbgState();
  markPc();
}

function annotateTrace(addr, size, cs) {
  const res = state.last;
  let mnem = '—', ops = '', btxt = '';
  const seg = res && res.segments.find(s =>
    s.kind === 'code' && addr >= s.addr && addr + size <= s.addr + s.bytes.length);
  if (seg) {
    const slice = seg.bytes.slice(addr - seg.addr, addr - seg.addr + size);
    const dec = cs.disasm(slice, addr);
    if (dec && dec.length) { mnem = dec[0].mnemonic; ops = dec[0].op_str; }
    btxt = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
  } else {
    mnem = I('trace.external');
    ops = fmtHex(addr, 4);
  }
  return '<div class="trrow"><span class="traddr">' + fmtHex(addr, 4) + '</span>' +
    '<span class="trbytes">' + btxt + '</span>' +
    '<span class="trmnem">' + escHtml(mnem) + '</span>' +
    '<span class="trops">' + escHtml(ops) + '</span></div>';
}

function renderRegs(currentRegs) {
  const a = arch();
  const rows = [];
  for (const [name] of regList(a)) {
    const now = BigInt(currentRegs[name] || '0');
    const init = BigInt(dbg.initRegs[name] || 0n);
    const changed = now !== init;
    rows.push('<div class="regrow' + (changed ? ' chg' : '') + '">' +
      '<span class="regname">' + name + '</span>' +
      '<span class="regval">' + fmtHex(init, a.width) + '</span>' +
      '<span class="regval">' + fmtHex(now, a.width) + '</span></div>');
  }
  $('regs').innerHTML = '<div class="regrow head"><span>' + I('reg.name') + '</span><span>' +
    I('reg.init') + '</span><span>' + I('reg.now') + '</span></div>' + rows.join('');
}

function renderTrace() {
  const showN = 1500;
  let html = dbg.traceRows.slice(0, showN).join('');
  if (dbg.traceRows.length > showN) {
    html += '<div class="trrow more">' + I('trace.more', { n: dbg.traceRows.length - showN, m: showN }) + '</div>';
  }
  $('trace').innerHTML = html || '<div class="empty">—</div>';
  const el = $('trace');
  const paneBody = el.closest('.pane-body');
  if (paneBody && dbg.state === 'running') el.scrollTop = el.scrollHeight;
}

function renderMemops() {
  const showM = 600;
  let html = dbg.memopsRows.slice(0, showM).join('');
  if (dbg.memopsRows.length > showM) {
    html += '<div class="memrow more">' + I('memops.more', { n: dbg.memopsRows.length - showM }) + '</div>';
  }
  $('memops').innerHTML = html || '<div class="empty">' + I('memops.none') + '</div>';
}

function renderConsole() {
  $('console').innerHTML = dbg.consoleText
    ? '<pre class="console-text">' + escHtml(dbg.consoleText) + '</pre>'
    : '<div class="empty">' + I('console.none') + '</div>';
}

function reasonText(reason) {
  if (!reason) return '';
  switch (reason.type) {
    case 'init': return I('reason.init');
    case 'paused': return I('reason.paused');
    case 'ended': return I('reason.ended');
    case 'exit': return I('reason.exit', { code: reason.code });
    case 'bp': return I('dbg.bpHit') + ' @ ' + fmtHex(reason.addr, 4);
    case 'trace-limit': return I('reason.trace-limit');
    case 'count-limit': return I('reason.count-limit');
    case 'error': return reason.errnoText || I('reason.error', { errno: reason.errno });
    case 'fatal': return I('reason.fatal');
    default: return reason.type;
  }
}

function renderDbgState() {
  const chip = $('dbg-state');
  const key = { idle: 'idle', ready: 'ready', running: 'running', pausing: 'running', paused: 'paused', ended: 'ended', error: 'error' }[dbg.state] || 'idle';
  chip.dataset.state = key;
  chip.innerHTML = '<span class="st-dot"></span>' + escHtml(I('dbg.state.' + (dbg.state === 'ready' ? 'ready' : key)) +
    (dbg.reason && dbg.state !== 'idle' && dbg.reason.type !== 'init' ? ' · ' + reasonText(dbg.reason) : ''));

  const meta = $('emu-meta');
  if (dbg.state === 'idle') { meta.textContent = ''; }
  else if (dbg.state === 'error') {
    meta.innerHTML = '<span class="err-pill">✘ ' + escHtml(dbg.errorMsg || I('reason.fatal')) + '</span>';
  }
  else {
    const stopBits = [];
    if (dbg.instrs > 0) stopBits.push('<span class="ok-pill">✔ ' + dbg.instrs + ' · ' + dbg.ms + ' ms</span>');
    const rt = reasonText(dbg.reason);
    if (rt) stopBits.push('<span class="stop-pill">' + escHtml(rt) + '</span>');
    meta.innerHTML = stopBits.join(' ') || '';
  }
  // 按钮可用性
  $('dbg-run').disabled = dbg.state === 'running' || dbg.state === 'pausing';
  $('dbg-pause').disabled = dbg.state !== 'running';
  $('dbg-stepin').disabled = dbg.state !== 'paused';
  $('dbg-stepover').disabled = dbg.state !== 'paused';
  $('dbg-stop').disabled = dbg.state === 'idle';
}

function setDbgStateChip(mode) {
  dbg.state = mode;
  renderDbgState();
}

function toggleBreakpoint(addr, row) {
  if (dbg.breakpoints.has(addr)) dbg.breakpoints.delete(addr);
  else dbg.breakpoints.add(addr);
  row.classList.toggle('has-bp', dbg.breakpoints.has(addr));
}

function markPc() {
  const sel = '#disasm .insrow.at-pc, #disasm-hex .insrow.at-pc';
  if (dbg.state === 'idle') {
    document.querySelectorAll(sel).forEach(el => el.classList.remove('at-pc'));
    return;
  }
  const a = arch();
  const pcShown = (dbg.pc & (a.thumb ? ~1 : 0xFFFFFFFF)) >>> 0;
  document.querySelectorAll(sel).forEach(el => el.classList.remove('at-pc'));
  document.querySelectorAll('#disasm .insrow[data-addr="' + pcShown + '"], #disasm-hex .insrow[data-addr="' + pcShown + '"]')
    .forEach(el => el.classList.add('at-pc'));
}

function endSession(clear) {
  dbg.seq++;
  if (ucHost) ucHost.call({ type: 'end' }).catch(() => {});
  if (clear) {
    dbg.state = 'idle'; dbg.reason = { type: 'init' }; dbg.pc = 0;
    dbg.traceRows = []; dbg.memopsRows = []; dbg.consoleText = '';
    dbg.instrs = 0; dbg.ms = 0;
    renderTrace(); renderMemops(); renderConsole(); renderDbgState(); markPc();
  }
}

const scheduleDebug = debounce(() => { if (state.autoEmu) startDebugSession(); }, 450);

/* ---------------- 调试控制 ---------------- */

async function dbgRun() {
  if (dbg.state === 'paused') {
    const seq = ++dbg.seq;
    setDbgStateChip('running');
    const r = await ucHost.call({ type: 'resume', chunk: 2000, breakpoints: [...dbg.breakpoints] });
    if (seq !== dbg.seq) return;
    applySessionState(r);
  } else {
    startDebugSession();
  }
}
async function dbgStepIn() {
  if (dbg.state !== 'paused') return;
  const seq = ++dbg.seq;
  const r = await ucHost.call({ type: 'step', n: 1 });
  if (seq !== dbg.seq) return;
  applySessionState(r);
}
async function dbgStepOver() {
  if (dbg.state !== 'paused') return;
  const a = arch();
  const cs = getCs();
  const pcShown = (dbg.pc & (a.thumb ? ~1 : 0xFFFFFFFF)) >>> 0;
  // 在当前 PC 反汇编一条，判断是否为 call 类指令
  const seg = state.last && state.last.segments.find(s =>
    s.kind === 'code' && pcShown >= s.addr && pcShown + 16 <= s.addr + s.bytes.length);
  let isCall = false, callSize = 0;
  if (seg) {
    const slice = seg.bytes.slice(pcShown - seg.addr, pcShown - seg.addr + 16);
    const dec = cs.disasm(slice, pcShown);
    if (dec && dec.length && a.callLike.includes(dec[0].mnemonic)) {
      isCall = true;
      callSize = Number(dec[0].size);
    }
  }
  const seq = ++dbg.seq;
  let r;
  if (isCall) {
    const until = (pcShown + callSize) >>> 0;
    r = await ucHost.call({ type: 'step', n: state.maxCount, until });
  } else {
    r = await ucHost.call({ type: 'step', n: 1 });
  }
  if (seq !== dbg.seq) return;
  applySessionState(r);
}
async function dbgStop() {
  /* 停止 = 结束当前运行并回到起点暂停态：可立即步入/步过/再次运行 */
  await runSession(false);
}

/* ---------------- UI 装配 ---------------- */

function populateArchSelect() {
  const sel = $('arch');
  const groups = {};
  for (const a of Object.values(ARCHES)) (groups[a.group] = groups[a.group] || []).push(a);
  const groupLabels = { x86: 'x86', arm: 'ARM', mips: 'MIPS', ppc: 'PowerPC', sparc: 'SPARC' };
  for (const [g, list] of Object.entries(groups)) {
    const og = document.createElement('optgroup');
    og.label = groupLabels[g] || g;
    for (const a of list) {
      const o = document.createElement('option');
      o.value = a.id; o.textContent = a.label;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

function refreshSyntaxSelect() {
  const a = arch(), sel = $('syntax');
  sel.disabled = !a.syntaxes;
  sel.innerHTML = '';
  if (!a.syntaxes) {
    const o = document.createElement('option');
    o.textContent = 'Intel';
    sel.appendChild(o);
    return;
  }
  const labels = { intel: 'Intel', att: 'AT&T' };
  for (const k of Object.keys(a.syntaxes)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = labels[k] || k;
    sel.appendChild(o);
  }
  if (!a.syntaxes[state.syntax]) state.syntax = 'intel';
  sel.value = state.syntax;
}

function refreshBaseInput() {
  const a = arch();
  const inp = $('base');
  if (a.layout.single) { inp.value = '0x0'; inp.disabled = true; state.base = 0; }
  else {
    inp.disabled = false;
    inp.value = '0x' + state.base.toString(16);
  }
}

function setArch(id, opts) {
  const prev = arch();
  state.archId = id;
  if (prev && prev.layout.single && !arch().layout.single) state.base = 0x10000;
  refreshSyntaxSelect();
  refreshBaseInput();
  editor.setArch(arch());
  $('arch').value = id;
  if (ucHost && prev && prev.uc.file !== arch().uc.file) {
    state.enginePills.uc = false;
    ucHost.respawn();
    updatePills();
    ucHost.ensure().then(() => { state.enginePills.uc = true; updatePills(); }).catch(() => {});
  }
  if (!opts || !opts.keepSource) {
    if (state.loadedExample === prev.id || editor.value.trim() === '') {
      editor.value = arch().example;
      state.loadedExample = id;
    }
  }
  assemble();
}

function wireEvents() {
  $('arch').addEventListener('change', (e) => setArch(e.target.value));
  $('syntax').addEventListener('change', (e) => { state.syntax = e.target.value; assemble(); });
  $('base').addEventListener('change', () => {
    const v = parseInt($('base').value, 16);
    if (!isNaN(v) && v >= 0 && v <= 0xffffffff && !(v & 0xf)) { state.base = v; assemble(); }
    else refreshBaseInput();
  });
  $('maxinsns').addEventListener('change', () => {
    const v = parseInt($('maxinsns').value, 10);
    if (v > 0 && v <= 20000000) { state.maxCount = v; startDebugSession(); }
  });
  $('autoemu').addEventListener('change', (e) => { state.autoEmu = e.target.checked; if (state.autoEmu) startDebugSession(); });
  $('example').addEventListener('click', () => {
    editor.value = arch().example;
    state.loadedExample = state.archId;
    if (state.hexMode) setHexMode(false); // 示例是汇编源码，回到源码模式
    else assemble();
  });
  $('share').addEventListener('click', shareLink);

  // 模式切换（源码 ⇄ 机器码）与机器码输入
  $('tab-disasm').addEventListener('click', () => { if (state.hexMode) setHexMode(false); });
  $('tab-hexin').addEventListener('click', () => { if (!state.hexMode) setHexMode(true); });
  $('hexin-toasm').addEventListener('click', hexinToAsm);
  $('hexin-gen').addEventListener('click', hexinGenFromAsm);
  $('hexin-import').addEventListener('click', () => $('hexin-file').click());
  $('hexin-file').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) hexinImportFile(e.target.files[0]);
    e.target.value = '';
  });
  $('hexin').addEventListener('input', () => { state.hexDirty = true; assembleFromHex(); });

  // 调试工具栏
  $('dbg-run').addEventListener('click', dbgRun);
  $('dbg-pause').addEventListener('click', () => {
    if (dbg.state === 'running') { setDbgStateChip('pausing'); ucHost.call({ type: 'pause' }); }
  });
  $('dbg-stepin').addEventListener('click', dbgStepIn);
  $('dbg-stepover').addEventListener('click', dbgStepOver);
  $('dbg-stop').addEventListener('click', dbgStop);

  // 断点：点击反汇编行切换（反汇编视图与机器码模式共用）
  $('disasm').addEventListener('click', (e) => {
    const row = e.target.closest('.insrow[data-addr]');
    if (!row) return;
    toggleBreakpoint(Number(row.dataset.addr), row);
  });
  $('disasm-hex').addEventListener('click', (e) => {
    const row = e.target.closest('.insrow[data-addr]');
    if (!row) return;
    toggleBreakpoint(Number(row.dataset.addr), row);
  });

  // 主题 / 语言
  document.querySelectorAll('#theme-seg button').forEach(b =>
    b.addEventListener('click', () => applyTheme(b.dataset.themeOpt)));
  document.querySelectorAll('#lang-seg button').forEach(b =>
    b.addEventListener('click', () => applyLang(b.dataset.langOpt)));

  $('initregs').addEventListener('input', scheduleDebug);
  $('initmem').addEventListener('input', scheduleDebug);
}

/* ---------------- 分享链接 ---------------- */

function shareLink() {
  const data = {
    a: state.archId, s: state.syntax, b: state.base,
    c: editor.value, r: $('initregs').value, m: $('initmem').value, n: state.maxCount,
  };
  const json = JSON.stringify(data);
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = location.origin + location.pathname + '#' + b64;
  history.replaceState(null, '', '#' + b64);
  copyText(url, I('btn.shareDone'), I('btn.shareFallback'));
}

function copyText(text, okMsg, fallbackMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(okMsg), () => toast(fallbackMsg));
    return;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(okMsg);
  } catch (e) {
    toast(fallbackMsg);
  }
}

function loadFromHash() {
  if (!location.hash || location.hash.length < 2) return false;
  try {
    let b64 = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (data.a && ARCHES[data.a]) { setArch(data.a, { keepSource: true, keepWorker: true }); }
    if (data.s) state.syntax = data.s;
    if (typeof data.b === 'number') state.base = data.b;
    if (typeof data.c === 'string') editor.value = data.c;
    if (typeof data.r === 'string') $('initregs').value = data.r;
    if (typeof data.m === 'string') $('initmem').value = data.m;
    if (typeof data.n === 'number') { state.maxCount = data.n; $('maxinsns').value = data.n; }
    state.loadedExample = null;
    return true;
  } catch (e) { return false; }
}

/* ---------------- 引擎状态 pill ---------------- */

function updatePills() {
  const p = state.enginePills;
  const a = arch();
  const pill = (ok, name) => ok
    ? '<span class="pill on">' + name + ' ✓</span>'
    : '<span class="pill">' + name + ' …</span>';
  $('status') && ($('status').innerHTML =
    pill(p.ks, 'Keystone') + pill(p.cs, 'Capstone') + pill(p.uc, I('engines.uc', { arch: a.uc.file.toUpperCase() })));
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- 启动 ---------------- */

async function boot() {
  I18N.init();
  applyLang(I18N.getLang());
  initTheme();

  editor = new AsmEditor($('editor-wrap'), () => assemble());
  populateArchSelect();
  refreshSyntaxSelect();
  refreshBaseInput();
  $('arch').value = state.archId;
  editor.setArch(arch());
  editor.value = arch().example;
  state.loadedExample = state.archId;
  ucHost = makeUcHost();
  ksHost = makeKsHost();
  wireEvents();

  const t0 = performance.now();
  CS = await MCapstone();
  state.enginePills.cs = true;
  updatePills();

  ucHost.ensure().then(() => { state.enginePills.uc = true; updatePills(); }).catch(() => {});
  ksHost.ensure().then(() => { state.enginePills.ks = true; updatePills(); }).catch(() => {});

  loadFromHash();
  refreshSyntaxSelect();
  refreshBaseInput();
  editor.setArch(arch());
  assemble();
  console.log('engines ready in', (performance.now() - t0).toFixed(0), 'ms');
}

document.addEventListener('DOMContentLoaded', boot);
