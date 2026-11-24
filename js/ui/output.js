/* output.js — 第 2 栏渲染：机器码 dump / Capstone 反汇编（断点与 PC 标记）/ 数据段 dump
 * 依赖：js/core/hexio.js 无、js/ui/{dom,state,engines}.js */
'use strict';

(function () {
  const AE = window.AE;
  const { $, I, escHtml, fmtHex } = AE.dom;
  const state = AE.state;
  const dbg = AE.dbg;
  const { arch, getCs } = AE.engines;

  function hasCodeSegs(res) {
    return !!(res && res.codeSegments && res.codeSegments.some(s => s.bytes && s.bytes.length));
  }

  function sumBytes(segs) {
    let n = 0;
    for (const s of segs || []) n += s.bytes.length;
    return n;
  }

  function renderOutput() {
    const res = state.last;
    const hexEl = $('hexdump'), disEl = $('disasm'), dataEl = $('datadump'), metaEl = $('out-meta');
    if (!res || !res.ok) {
      hexEl.innerHTML = '<div class="empty">' + I('waitValid') + '</div>';
      disEl.innerHTML = '<div class="empty">—</div>';
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
    const hasCode = res.segments.some(s => s.kind === 'code' && s.bytes.length);
    disEl.innerHTML = disRows.join('') ||
      '<div class="empty">' + (hasCode ? '—' : I('status.dataOnly')) + '</div>';
    metaEl.textContent = (res.fromHex ? I('status.fromHex') + ' · ' : '') +
      (hasCode ? (res.totalInsns + ' insn · ' + res.totalBytes + ' B')
               : I('status.dataOnlyMeta', { b: res.totalBytes })) +
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

  AE.output = { renderOutput, hasCodeSegs, sumBytes };
})();
