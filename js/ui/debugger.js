/* debugger.js — 第 3 栏：Unicorn 会话生命周期 / 寄存器 / 轨迹 / 断点 / 单步控制
 * 依赖：js/core/session-payload.js、js/ui/{dom,state,engines,output,log}.js */
'use strict';

(function () {
  const AE = window.AE;
  const { $, I, escHtml, fmtHex, debounce } = AE.dom;
  const state = AE.state;
  const dbg = AE.dbg;
  const LOG = AE.log;
  const { arch, regList, getCs } = AE.engines;
  const { hasCodeSegs, sumBytes } = AE.output;

  /* ---------------- 会话载荷 ---------------- */

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
    /* 弹窗/手动添加的内存映射与数据：每次建会话都带上，保证重新汇编后仍生效 */
    for (const m of dbg.extraMaps) payload.regions.push({ addr: m.addr, size: m.size });
    for (const w of dbg.extraWrites) payload.memInit.push({ addr: w.addr, bytes: Array.from(w.bytes) });
    return payload;
  }

  /* 程序指纹：架构/基址/上限/初始寄存器与内存/镜像字节 → 判断是否需要重建会话 */
  function programKey(res) {
    if (!res || !res.ok) return null;
    let h = 2166136261;
    for (const seg of res.image || []) {
      h = Math.imul(h ^ (seg.addr >>> 0), 16777619);
      h = Math.imul(h ^ (seg.bytes.length >>> 0), 16777619);
      for (let i = 0; i < seg.bytes.length; i++) h = Math.imul(h ^ seg.bytes[i], 16777619);
    }
    return [
      state.archId, state.base, state.maxCount,
      $('initregs').value, $('initmem').value,
      res.startAddr, res.untilAddr, h >>> 0,
    ].join('|');
  }

  function startDebugSession() {
    return runSession(true);
  }

  /* 让进行中的运行先收敛（pause + 等待），避免 Worker 中会话被并发关闭 */
  async function haltRun() {
    if (!dbg.runPromise) return;
    const prev = dbg.runPromise;
    ++dbg.seq;
    AE.engines.uc.call({ type: 'pause' });
    try { await prev; } catch (e) { /* 旧运行错误可忽略 */ }
    dbg.runPromise = null;
  }

  /* 创建会话并渲染初始状态；autoResume=true 时连续运行到结束/断点 */
  async function runSession(autoResume) {
    const res = state.last;
    if (!res || !res.ok || !res.image.some(s => s.bytes.length)) {
      await haltRun();
      endSession(true);
      dbg.programKey = null;
      $('emu-meta').textContent = I('waitValid');
      return;
    }
    if (!hasCodeSegs(res)) {
      /* 纯数据程序：没有可执行指令，不启动调试器 */
      await haltRun();
      endSession(true);
      $('emu-meta').textContent = I('emu.noCode');
      LOG.info('UC', '纯数据程序（' + sumBytes(res.dataSegments) + ' 字节数据），跳过执行');
      return;
    }
    await haltRun();
    endSession(false);
    const seq = ++dbg.seq;
    dbg.busy = true;
    dbg.programKey = programKey(res);
    setDbgStateChip('running');
    LOG.debug('UC', '创建会话：start=' + fmtHex(res.startAddr, 4) + ' until=' + fmtHex(res.untilAddr, 4));
    const r = await AE.engines.uc.call({ type: 'session', payload: buildPayload(res) });
    if (seq !== dbg.seq) return;
    dbg.busy = false;
    if (r.type === 'error') {
      dbg.state = 'error';
      dbg.errorMsg = r.message;
      dbg.reason = { type: 'fatal', message: r.message };
      LOG.error('UC', '会话创建失败：' + r.message);
      renderDbgState();
      return;
    }
    // 会话就绪：初始化视图
    dbg.repIdx = { trace: 0, mem: 0, consoleBytes: 0 };
    dbg.traceRows = []; dbg.memopsRows = []; dbg.consoleText = '';
    buildInitRegs();
    applySessionState(r);
    if (!autoResume) return; // 停在起点（paused），可立即步入/步过
    // 自动连续运行
    const rp = AE.engines.uc.call({ type: 'resume', chunk: 2000, breakpoints: [...dbg.breakpoints] });
    dbg.runPromise = rp;
    const r2 = await rp;
    dbg.runPromise = null;
    if (seq !== dbg.seq) return;
    applySessionState(r2);
  }

  function buildInitRegs() {
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
    if (r.regions) dbg.regions = r.regions;
    if (r.state === 'paused') {
      LOG.debug('UC', '暂停 @ ' + fmtHex(r.pc, 4) + ' · ' + reasonText(r.reason));
    } else if (r.state === 'ended' || r.state === 'error') {
      LOG.info('UC', '执行结束：' + reasonText(r.reason) + '（' + r.instrs + ' 条 / ' + r.ms + 'ms）');
    }
    if (r.reason && r.reason.type === 'mem-fault') {
      LOG.warn('UC', '内存未映射：' + reasonText(r.reason) + ' · 引擎已在故障指令处暂停');
    }
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
    /* 未映射内存：弹出引导（映射页 / 导入数据后原地继续） */
    if (r.state === 'paused' && r.reason && r.reason.type === 'mem-fault' && AE.memfault) {
      AE.memfault.onFault(r.reason, r.pc);
    } else if (r.state === 'error' && r.reason && r.reason.type === 'fatal' && AE.memfault &&
               /memory|bounds|mapping/i.test(String(r.reason.message || ''))) {
      AE.memfault.onFatal(r.reason);
    }
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

  /* ---------------- 右侧面板渲染 ---------------- */

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
      case 'mem-fault': return I('reason.memFault', { addr: fmtHex(reason.addr, 4) });
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
    // 按钮可用性：running 时禁止启动/单步；单步在 idle/ended/error 会自动从起点载入
    const busy = dbg.state === 'running' || dbg.state === 'pausing';
    $('dbg-run').disabled = busy;
    $('dbg-pause').disabled = dbg.state !== 'running';
    $('dbg-stepin').disabled = busy;
    $('dbg-stepover').disabled = busy;
    $('dbg-stop').disabled = dbg.state === 'idle';
  }

  function setDbgStateChip(mode) {
    dbg.state = mode;
    renderDbgState();
  }

  function toggleBreakpoint(addr, row) {
    if (dbg.breakpoints.has(addr)) {
      dbg.breakpoints.delete(addr);
      LOG.info('UC', '移除断点 @ ' + fmtHex(addr, 4));
    } else {
      dbg.breakpoints.add(addr);
      LOG.info('UC', '设置断点 @ ' + fmtHex(addr, 4));
    }
    row.classList.toggle('has-bp', dbg.breakpoints.has(addr));
  }

  function clearBreakpoints() {
    dbg.breakpoints.clear();
    document.querySelectorAll('#disasm .insrow.has-bp').forEach(el => el.classList.remove('has-bp'));
  }

  function markPc() {
    const sel = '#disasm .insrow.at-pc';
    document.querySelectorAll(sel).forEach(el => el.classList.remove('at-pc'));
    if (dbg.state === 'idle') return;
    const a = arch();
    const pcShown = (dbg.pc & (a.thumb ? ~1 : 0xFFFFFFFF)) >>> 0;
    document.querySelectorAll('#disasm .insrow[data-addr="' + pcShown + '"]')
      .forEach(el => el.classList.add('at-pc'));
  }

  function endSession(clear) {
    dbg.seq++;
    dbg.runPromise = null;
    if (AE.engines.uc) AE.engines.uc.call({ type: 'end' }).catch(() => {});
    if (clear) {
      dbg.state = 'idle'; dbg.reason = { type: 'init' }; dbg.pc = 0; dbg.errorMsg = '';
      dbg.traceRows = []; dbg.memopsRows = []; dbg.consoleText = '';
      dbg.instrs = 0; dbg.ms = 0; dbg.regions = []; dbg.programKey = null;
      dbg.initRegs = {};
      $('regs').innerHTML = '';
      $('emu-meta').textContent = '';
      renderTrace(); renderMemops(); renderConsole(); renderDbgState(); markPc();
    }
  }

  /* 程序发生变化：自动运行则重跑，否则载入一个停在入口的会话（可直接单步） */
  const scheduleDebug = debounce(async () => {
    const res = state.last;
    if (!res || !res.ok || !res.image.some(s => s.bytes && s.bytes.length)) {
      await haltRun();
      endSession(true);
      $('emu-meta').textContent = I('waitValid');
      return;
    }
    const key = programKey(res);
    const live = dbg.state === 'paused' || dbg.state === 'running' || dbg.state === 'pausing';
    if (live && key === dbg.programKey) return; // 程序与参数未变化，保留当前会话
    if (state.autoEmu) startDebugSession();
    else runSession(false);
  }, 450);

  /* ---------------- 内存补齐（未映射故障弹窗 / 手动映射） ---------------- */

  const MAX_EXTRA_WRITE_BYTES = 512 * 1024;

  function rememberMemory(maps, writes) {
    for (const m of maps || []) {
      if (!dbg.extraMaps.some(x => x.addr === m.addr && x.size === m.size)) {
        dbg.extraMaps.push({ addr: m.addr, size: m.size });
      }
    }
    let total = dbg.extraWrites.reduce((n, w) => n + w.bytes.length, 0);
    for (const w of writes || []) {
      if (!w.bytes || !w.bytes.length) continue;
      const i = dbg.extraWrites.findIndex(x => x.addr === w.addr && x.bytes.length === w.bytes.length);
      if (i >= 0) dbg.extraWrites.splice(i, 1);
      if (total + w.bytes.length > MAX_EXTRA_WRITE_BYTES) {
        LOG.warn('UC', '自定义内存数据超过 ' + (MAX_EXTRA_WRITE_BYTES / 1024) + 'KB，已忽略新增写入');
        continue;
      }
      dbg.extraWrites.push({ addr: w.addr, bytes: Array.from(w.bytes) });
      total += w.bytes.length;
    }
  }

  function clearMemoryExtras() {
    dbg.extraMaps = [];
    dbg.extraWrites = [];
    dbg.regions = [];
    LOG.info('UC', '已清除自定义内存映射（后续会话生效）');
  }

  /* 优先在当前暂停会话内原地补齐（引擎不重建）；无会话时带自定义映射重建 */
  async function applyMemory(opts) {
    const maps = (opts && opts.maps) || [];
    const writes = (opts && opts.writes) || [];
    const cont = !!(opts && opts.continue);
    rememberMemory(maps, writes);

    if (dbg.state === 'paused' && AE.engines.uc) {
      const r = await AE.engines.uc.call({ type: 'mem', maps, writes });
      if (r.type === 'mem-result' && r.ok) {
        if (r.regions) dbg.regions = r.regions;
        LOG.ok('UC', '内存已补齐：映射 ' + maps.length + ' 段 / 写入 ' + (r.wrote || 0) + ' 字节');
        if (cont) await dbgRun();
        return { ok: true, wrote: r.wrote || 0 };
      }
      LOG.warn('UC', '内存补齐失败（' + (r.error || r.message || '会话不可用') + '），改为重建会话');
    }

    /* 会话不存在/已结束：带自定义映射重建，从起点重新运行 */
    await runSession(false);
    if (cont && dbg.state === 'paused') await dbgRun();
    return { ok: true, rebuilt: true };
  }

  function memoryExtras() {
    return { maps: dbg.extraMaps.slice(), writes: dbg.extraWrites.slice() };
  }

  /* ---------------- 调试控制 ---------------- */

  /* 单步前确保有一个暂停会话：idle/ended/error 时自动从入口载入 */
  async function ensurePaused() {
    if (dbg.state === 'paused') return true;
    if (dbg.state === 'running' || dbg.state === 'pausing') return false;
    await runSession(false);
    return dbg.state === 'paused';
  }

  async function dbgRun() {
    if (dbg.state === 'running' || dbg.state === 'pausing') return;
    if (dbg.state === 'paused') {
      const seq = ++dbg.seq;
      setDbgStateChip('running');
      const rp = AE.engines.uc.call({ type: 'resume', chunk: 2000, breakpoints: [...dbg.breakpoints] });
      dbg.runPromise = rp;
      const r = await rp;
      dbg.runPromise = null;
      if (seq !== dbg.seq) return;
      applySessionState(r);
    } else {
      startDebugSession();
    }
  }

  async function dbgStepIn() {
    if (dbg.state === 'running' || dbg.state === 'pausing') return;
    if (!(await ensurePaused())) return;
    const seq = ++dbg.seq;
    const r = await AE.engines.uc.call({ type: 'step', n: 1 });
    if (seq !== dbg.seq) return;
    applySessionState(r);
  }

  async function dbgStepOver() {
    if (dbg.state === 'running' || dbg.state === 'pausing') return;
    if (!(await ensurePaused())) return;
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
      r = await AE.engines.uc.call({ type: 'step', n: state.maxCount, until });
    } else {
      r = await AE.engines.uc.call({ type: 'step', n: 1 });
    }
    if (seq !== dbg.seq) return;
    applySessionState(r);
  }

  async function dbgStop() {
    if (dbg.state === 'idle') return;
    ++dbg.seq;
    await haltRun();
    endSession(true);
    LOG.info('UC', '调试会话已停止');
  }

  AE.debug = {
    dbg,
    runSession, startDebugSession, scheduleDebug, endSession,
    renderDbgState, setDbgStateChip, applySessionState, markPc, toggleBreakpoint,
    clearBreakpoints,
    dbgRun, dbgStepIn, dbgStepOver, dbgStop,
    applyMemory, clearMemoryExtras, memoryExtras,
  };
})();
