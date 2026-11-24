/* input.js — 第 1 栏输入与流水线入口：源码 ⇄ 机器码双页、Keystone 汇编、区域解析
 * 依赖：js/core/hexio.js、js/ui/{dom,state,engines,output,debugger,log}.js */
'use strict';

(function () {
  const AE = window.AE;
  const { $, I, escHtml, toast, debounce } = AE.dom;
  const state = AE.state;
  const LOG = AE.log;
  const { arch, getCs } = AE.engines;
  const { renderOutput, hasCodeSegs, sumBytes } = AE.output;
  const Debug = AE.debug;

  let assembleSeq = 0;

  /* ---------------- 阶段 1：Keystone 汇编（Worker 执行） ---------------- */

  async function assemble() {
    if (state.tab === 'hex') { runHexPipeline(); return; }
    if (!AE.engines.isReady()) {
      $('src-status').innerHTML = '<span class="hint">' + I('boot.waitEngines') + '</span>';
      return;
    }
    const a = arch();
    const seq = ++assembleSeq;
    const t0 = performance.now();
    const r = await AE.engines.ks.call({
      type: 'assemble',
      params: { archId: state.archId, syntax: state.syntax, source: AE.editor.value, base: a.layout.single ? 0 : state.base },
    });
    if (seq !== assembleSeq) return; // 已有更新的输入
    const res = r.res;
    state.last = res;
    const ms = Math.round(performance.now() - t0);

    AE.editor.setLineStates(res.lineInfo.map(li => {
      if (!li.ok) return { cls: 'err', title: li.error || '' };
      if (li.deferred) return { cls: 'warn', title: I('status.deferredNote') };
      return null;
    }));

    const badLines = res.lineInfo.map((l, i) => l.ok ? -1 : i).filter(i => i >= 0);
    if (res.ok) {
      if (hasCodeSegs(res)) {
        $('src-status').innerHTML =
          '<span class="ok-pill">✔ ' + I('status.insns', { n: res.totalInsns, b: res.totalBytes }) + '</span>' +
          (res.deferredAny ? '<span class="warn-note">' + I('status.deferredNote') + '</span>' : '');
      } else {
        $('src-status').innerHTML =
          '<span class="ok-pill">✔ ' + I('status.dataOnlyMeta', { b: sumBytes(res.dataSegments) }) + '</span>' +
          '<span class="hint">' + I('status.dataOnly') + '</span>';
      }
      LOG.debug('KS', '汇编成功：' + res.totalInsns + ' 条指令 / ' + res.totalBytes + ' 字节，' + ms + 'ms');
    } else {
      $('src-status').innerHTML =
        '<span class="err-pill">✘ ' + I('status.errAt', { lines: badLines.map(i => i + 1).join(', ') }) + '</span>' +
        '<span class="hint">' + I('status.errHint') + '</span>';
      const first = res.errors && res.errors[0];
      LOG.warn('KS', '汇编失败：第 ' + badLines.map(i => i + 1).join(',') + ' 行' + (first ? ' — ' + first.message : ''));
    }

    /* 联动：源码页是权威输入，机器码页保持镜像同步（用户手动改过机器码则不覆盖） */
    if (res.ok && !state.hexDirty) syncHexText();
    renderOutput();
    Debug.scheduleDebug();
  }

  /* ---------------- 阶段 1b：机器码输入驱动（区域解析 + Capstone 反汇编） ---------------- */

  function syncHexText() {
    const res = state.last;
    if (!res || !res.ok || !res.image.length) { $('hexin').value = ''; return; }
    const a = arch();
    $('hexin').value = HexIO.formatImage(res.image, 16, a.layout.single ? 0 : state.base);
  }

  /* hex 文本 → 区域（code 带 Capstone 反汇编结果；data 只保留字节） */
  function hexModel() {
    const a = arch();
    const base = a.layout.single ? 0 : state.base;
    const parsed = HexIO.parseHexInput($('hexin').value);
    const cs = getCs();
    let cursor = base;
    const regions = [];
    for (const r of parsed.regions) {
      const addr = (r.addr === null || r.addr === undefined) ? cursor : r.addr;
      const region = { kind: r.kind, addr, bytes: r.bytes, line: r.line, insns: null };
      if (r.kind === 'code') {
        region.insns = [];
        for (const ins of cs.disasm(r.bytes, addr)) {
          region.insns.push({
            address: Number(ins.address), size: Number(ins.size),
            mnemonic: ins.mnemonic, op_str: ins.op_str,
          });
        }
      }
      regions.push(region);
      cursor = addr + r.bytes.length;
    }
    return { parsed, regions, base };
  }

  /* 区域 → 与 assembleSource 同构的结果对象（驱动第 2/3 栏） */
  function hexResult(regions, parsed) {
    const segs = regions.map(r => ({
      kind: r.kind, addr: r.addr, bytes: r.bytes, parts: [], labels: [], insns: r.insns,
    }));
    const codeSegs = segs.filter(s => s.kind === 'code');
    const dataSegs = segs.filter(s => s.kind === 'data');
    const totalBytes = segs.reduce((n, s) => n + s.bytes.length, 0);
    let totalInsns = 0;
    for (const s of codeSegs) totalInsns += (s.insns || []).length;
    const startAddr = codeSegs.length ? codeSegs[0].addr : (segs.length ? segs[0].addr : state.base);
    let untilAddr = startAddr;
    for (const s of codeSegs) untilAddr = Math.max(untilAddr, s.addr + s.bytes.length);
    return {
      ok: parsed.errors.length === 0 && totalBytes > 0,
      errors: parsed.errors.map(e => ({ line: e.line, message: e.message })),
      segments: segs,
      image: segs.map(s => ({ addr: s.addr, bytes: s.bytes, kind: s.kind })),
      codeSegments: codeSegs,
      dataSegments: dataSegs,
      symbols: {}, equ: {},
      startAddr, untilAddr,
      lineInfo: [], deferredAny: false,
      totalInsns, totalBytes,
      cleaned: '',
      fromHex: true,
    };
  }

  const runHexPipeline = debounce(function () {
    if (state.tab !== 'hex') return;
    if (!AE.engines.csReady()) {
      $('hexin-status').innerHTML = '<span class="hint">' + I('boot.waitEngines') + '</span>';
      return;
    }
    const { parsed, regions } = hexModel();
    const res = hexResult(regions, parsed);

    if (!res.ok) {
      /* 无效输入：清空旧解码并复位调试器，避免误导 */
      state.last = null;
      state.hexBytes = null;
      if (parsed.errors.length) {
        $('hexin-status').innerHTML = '<span class="err-pill">✘ ' +
          escHtml(parsed.errors.map(e => '第 ' + (e.line + 1) + ' 行：' + e.message).join(' / ')) + '</span>';
        LOG.warn('HEX', '机器码解析失败：' + parsed.errors.map(e => 'L' + (e.line + 1) + ' ' + e.message).join(' | '));
      } else {
        $('hexin-status').innerHTML = '<span class="hint">' + I('waitValid') + '</span>';
      }
      $('src-status').innerHTML = '<span class="hint">' + I('hexin.modeNote') + '</span>';
      AE.editor.setLineStates([]);
      Debug.endSession(true);
      renderOutput();
      return;
    }

    state.last = res;
    state.hexBytes = res.totalBytes;

    /* 联动：机器码页是权威输入，源码页实时镜像为反汇编结果 */
    const gen = HexIO.imageToSource(regions, arch());
    if (AE.editor.value !== gen.source) {
      AE.editor.value = gen.source;
      AE.editor.setLineStates([]);
      state.loadedExample = null;
    }

    const dataBytes = sumBytes(res.dataSegments);
    $('hexin-status').innerHTML =
      '<span class="ok-pill">✔ ' + I('hexin.statusOk', { n: res.totalBytes, m: res.totalInsns, d: dataBytes }) + '</span>' +
      (res.totalInsns === 0 ? '<span class="hint">' + I('status.dataOnly') + '</span>' : '');
    $('src-status').innerHTML = '<span class="hint">' + I('hexin.modeNote') + '</span>';
    LOG.debug('HEX', '解析 ' + res.totalBytes + ' 字节 / ' + res.totalInsns + ' 条指令 / ' + dataBytes + ' 字节数据');

    renderOutput();
    Debug.scheduleDebug();
  }, 250);

  /* ---------------- 第 1 栏：源码 ⇄ 机器码 切换 ---------------- */

  function renderHexStatus() {
    const res = state.last;
    const el = $('hexin-status');
    if (!res || !res.ok) { el.innerHTML = '<span class="hint">' + I('waitValid') + '</span>'; return; }
    /* 以真实反汇编行数统计（标签行不计、数据区不计），与第 2 栏一致 */
    const cs = getCs();
    let insns = 0, dataBytes = 0, allBytes = 0;
    for (const seg of res.segments) {
      allBytes += seg.bytes.length;
      if (seg.kind === 'data') { dataBytes += seg.bytes.length; continue; }
      for (const _ of cs.disasm(seg.bytes, seg.addr)) insns++;
    }
    el.innerHTML = '<span class="ok-pill">✔ ' + I('hexin.statusOk', {
      n: allBytes, m: insns, d: dataBytes,
    }) + '</span>';
  }

  function switchTab(tab, force) {
    if (!force && state.tab === tab) return;
    state.tab = tab;
    $('tab-src').classList.toggle('on', tab === 'src');
    $('tab-hex').classList.toggle('on', tab === 'hex');
    $('src-view').classList.toggle('hidden', tab !== 'src');
    $('hex-view').classList.toggle('hidden', tab !== 'hex');
    LOG.debug('UI', '输入页 → ' + tab);

    if (tab === 'hex') {
      if (!state.hexDirty) {
        /* 与源码一致：填充镜像文本，不重跑流水线（保留用户源码里的注释/标签） */
        syncHexText();
        renderHexStatus();
        $('hexin-status').innerHTML += '<span class="hint">' + I('hexin.syncedNote') + '</span>';
      } else {
        runHexPipeline();
      }
    } else {
      if (state.hexDirty) {
        const before = state.hexBytes;
        state.hexDirty = false;
        const p = assemble();
        Promise.resolve(p).then(() => {
          if (before !== null && state.last && state.last.ok) {
            const after = state.last.totalBytes;
            if (after !== before) LOG.warn('KS', I('hexin.reasmChanged', { a: before, b: after }));
            else LOG.ok('KS', '机器码镜像重新汇编：字节一致（' + after + ' 字节）');
          }
        });
      } else {
        assemble();
      }
    }
  }

  /* 转为源码：源码页已是实时镜像，这里只切页并提示 */
  function hexToSource() {
    if (!state.hexDirty) { toast(I('hexin.syncedNote')); return; }
    const n = state.last ? state.last.totalInsns : 0;
    switchTab('src');
    toast(I('hexin.toAsmDone', { n }));
  }

  /* 与源码同步：丢弃机器码的手工编辑，重新从汇编产物生成镜像 */
  function hexSyncFromSource() {
    state.hexDirty = false;
    state.hexBytes = null;
    syncHexText();
    renderHexStatus();
    $('hexin-status').innerHTML += '<span class="hint">' + I('hexin.syncedNote') + '</span>';
    LOG.info('HEX', '已从汇编产物重新同步机器码');
  }

  /* 文件导入：.s/.asm/.txt → 源码页；其余（.bin/.hex/.dump 等）→ 机器码页 */
  function hexinImportFile(file) {
    if (!file) return;
    const isSource = /\.(s|asm|txt|S|ASM)$/i.test(file.name);
    if (isSource) {
      const fr = new FileReader();
      fr.onload = () => {
        AE.editor.value = String(fr.result);
        state.hexDirty = false;
        state.loadedExample = null;
        switchTab('src', true);
        toast(I('hexin.importDone', { n: file.name }));
        LOG.info('UI', '导入源码文件 ' + file.name);
      };
      fr.readAsText(file);
    } else {
      const fr = new FileReader();
      fr.onload = () => {
        let u8 = new Uint8Array(fr.result);
        if (u8.length > AE.MAX_IMPORT_BYTES) {
          LOG.warn('HEX', '文件 ' + file.name + ' 超过 ' + (AE.MAX_IMPORT_BYTES / 1024) + 'KB，仅导入前 ' + (AE.MAX_IMPORT_BYTES / 1024) + 'KB');
          u8 = u8.slice(0, AE.MAX_IMPORT_BYTES);
        }
        $('hexin').value = HexIO.formatHexDump(u8, 16);
        state.hexDirty = true;
        switchTab('hex', true);
        runHexPipeline();
        toast(I('hexin.importDone', { n: file.name }));
        LOG.info('HEX', '导入机器码文件 ' + file.name + '（' + u8.length + ' 字节）');
      };
      fr.readAsArrayBuffer(file);
    }
  }

  AE.input = {
    assemble, runHexPipeline, switchTab, hexToSource, hexSyncFromSource,
    hexinImportFile, syncHexText, hexModel, hexResult,
  };
})();
