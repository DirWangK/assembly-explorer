/* assembler.js — 汇编流水线核心（纯逻辑，浏览器与 Node 测试共用）
 *
 * 两阶段流水线：
 *   1. stripComments + preproc.parseSource：符号化解析（数据字节/代码文本/符号）
 *   2. 多轮布局定点迭代（真实汇编器的多遍做法）：
 *        - 按段顺序排布地址（.org 重定位；代码段大小初值 0）
 *        - 数据标签绝对地址 = 段地址 + 段内偏移
 *        - 用当前符号值替换代码段文本 → Keystone 编码 → 得到代码段大小
 *        - 大小变化则重排，直至收敛（≤6 轮）
 *   3. 收敛后：逐行汇编出"行 → 字节"映射（编辑器侧栏）、错误行诊断
 *
 * 行字符白名单：拦截会让 keystone wasm 挂死/崩溃的奇异输入。
 */
'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    const Preproc = require('./preproc.js');
    const Arches = require('./arches.js');
    module.exports = factory(Preproc, Arches);
  } else {
    root.Assembler = factory(root.Preproc, root.ArchesModule);
  }
})(typeof self !== 'undefined' ? self : this, function (Preproc, Arches) {

  function stripComments(src, arch) { return Arches.stripComments(src, arch); }
  function regList(arch) { return Arches.regList(arch); }

  function ksSyntaxOption(ksLib, arch, syntax) {
    const syn = arch.syntaxes && arch.syntaxes[syntax];
    if (syn && syn.length) return ksLib[syn[0]];
    return null;
  }

  function makeKs(ksLib, arch, syntax) {
    if (!ksLib) return null;
    const inst = new ksLib.Keystone(ksLib[arch.ks.arch],
      arch.ks.modes.reduce((acc, n) => acc | ksLib[n], 0));
    const opt = ksSyntaxOption(ksLib, arch, syntax);
    if (opt !== null) inst.option(ksLib.OPT_SYNTAX, opt);
    return inst;
  }

  const SAFE_CHARS = /^[A-Za-z0-9_$%:,.(){}\[\]<>!+\-*/&|^~='" \t#@?\n\r]*$/;
  /* 指令形状校验：第一记号必须是 标识符/标签/伪指令；
   * 且不允许连续运算符 / 3 连括号 —— 这些输入会让 keystone wasm 挂死。 */
  const SHAPE_RE = /^(?:[A-Za-z_.$][\w.$]*\s*:|[A-Za-z_.][\w.$]*)/;
  const OP_RUN_RE = /[+\-*/%^&|~]{2,}/;
  const BRACKET_RUN_RE = /[(){}\[\]]{3,}/;
  function lineSafe(text) {
    if (!SAFE_CHARS.test(text)) return false;
    const t = text.trim();
    if (!t) return true;
    if (!SHAPE_RE.test(t)) return false;
    if (OP_RUN_RE.test(t)) return false;
    if (BRACKET_RUN_RE.test(t)) return false;
    return true;
  }

  function assembleSource(params) {
    const { ksLib, arch, syntax, source, base } = params;
    const ks = makeKs(ksLib, arch, syntax);
    const cleaned = stripComments(source, arch);
    const lines = cleaned.split('\n');

    const pre = Preproc.parseSource(lines, { base });
    const lineInfo = lines.map((_, i) => {
      const info = pre.lineInfo[i] || { kind: 'blank', segIndex: -1, offset: -1 };
      return Object.assign({ ok: true, bytes: null, error: null, deferred: false }, info);
    });
    for (const err of pre.errors) {
      if (lineInfo[err.line]) { lineInfo[err.line].ok = false; lineInfo[err.line].error = err.message; }
    }

    /* ---------- 多轮布局定点迭代 ---------- */
    const segs = pre.segments;
    const sizes = segs.map(s => (s.kind === 'data' ? s.bytes.length : 0));
    const codeResults = new Map(); // seg -> {ok, bytes, count}
    let startAddr = base;
    let untilAddr = base;
    let converged = false;

    for (let iter = 0; iter < 6 && !converged; iter++) {
      /* 布局 */
      let cur = base;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (seg.orgBase !== null && seg.orgBase !== undefined) cur = seg.orgBase;
        seg.addr = cur;
        cur += sizes[i];
      }
      /* 数据标签绝对地址 */
      const symMap = Object.create(null);
      for (const [k, v] of Object.entries(pre.equ)) symMap[k] = v;
      for (const dl of pre.dataLabels) symMap[dl.name] = dl.seg.addr + dl.offset;

      /* 代码段编码 */
      let changed = false;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (seg.kind !== 'code') continue;
        if (!seg.text.trim()) { codeResults.set(seg, { ok: true, bytes: new Uint8Array(0), count: 0 }); sizes[i] = 0; continue; }
        if (!lineSafe(seg.text)) { codeResults.set(seg, { ok: false, unsafe: true }); continue; }
        let r = null;
        try { r = ks.asm(Preproc.substituteSymbols(seg.text, symMap)); } catch (e) { r = { failed: true }; }
        const ok = r && !r.failed;
        codeResults.set(seg, ok
          ? { ok: true, bytes: Uint8Array.from(r.mc || []), count: r.count || 0 }
          : { ok: false });
        const newSize = ok ? (r.mc ? r.mc.length : 0) : sizes[i];
        if (newSize !== sizes[i]) { changed = true; sizes[i] = newSize; }
      }
      /* 数据段地址在下一轮保持一致（size 恒定）；代码大小稳定即收敛 */
      if (!changed) converged = true;
    }
    if (!converged) {
      /* 不收敛：以最后一轮为准并报告 */
      //（实际场景几乎不会发生）
    }

    /* 最终布局下的符号值（用于逐行诊断与外部符号表） */
    const finalSymMap = Object.create(null);
    for (const [k, v] of Object.entries(pre.equ)) finalSymMap[k] = v;
    for (const dl of pre.dataLabels) finalSymMap[dl.name] = dl.seg.addr + dl.offset;

    /* startAddr / untilAddr */
    const codeSegs = segs.filter(s => s.kind === 'code');
    let hasStart = false;
    for (const seg of codeSegs) {
      if (seg.labels.includes('_start')) { startAddr = seg.addr; hasStart = true; break; }
    }
    if (!hasStart && codeSegs.length) startAddr = codeSegs[0].addr;
    untilAddr = base;
    for (const seg of codeSegs) {
      const len = seg.bytes ? seg.bytes.length : sizes[segs.indexOf(seg)] || 0;
      untilAddr = Math.max(untilAddr, seg.addr + len);
    }
    if (!codeSegs.length) untilAddr = base;

    /* ---------- 逐行信息（编辑器侧栏 + 错误诊断） ---------- */
    let totalBytes = 0, totalInsns = 0;
    const deferredLines = [];
    segs.forEach((seg, segIdx) => {
      if (seg.kind === 'data') {
        for (const ln of seg.dataLineNos || []) {
          if (lineInfo[ln]) lineInfo[ln].segIndex = segIdx;
        }
        totalBytes += seg.bytes.length;
        return;
      }
      const result = codeResults.get(seg);
      if (lineInfo) {
        for (const p of seg.parts) {
          if (lineInfo[p.lineNo]) lineInfo[p.lineNo].segIndex = segIdx;
        }
      }
      if (!result || !result.ok) {
        seg.error = true;
        seg.errorLine = Infinity;
        let off = 0;
        for (const p of seg.parts) {
          const li = lineInfo[p.lineNo];
          if (!li) continue;
          li.segIndex = segIdx;
          if (!lineSafe(p.text)) {
            li.ok = false; li.error = '行内含非法字符';
            seg.errorLine = Math.min(seg.errorLine, p.lineNo);
            continue;
          }
          // 单行诊断（应用替换）：定位真正无法汇编的行
          let r = null;
          try { r = ks.asm(Preproc.substituteSymbols(p.text, finalSymMap)); } catch (e) { r = { failed: true }; }
          if (r && !r.failed) {
            li.ok = true;
            li.bytes = r.mc ? Uint8Array.from(r.mc) : [];
            li.offset = off;
            off += r.mc ? r.mc.length : 0;
          } else {
            li.ok = false; li.error = '无法汇编该行';
            seg.errorLine = Math.min(seg.errorLine, p.lineNo);
          }
        }
        return;
      }
      seg.bytes = result.bytes;
      totalBytes += seg.bytes.length;
      /* 成功：逐行汇编生成侧栏字节；指令数按"真正产出字节的行"统计
       * （Keystone 的 count 会把纯标签行也算进去，与反汇编行数不一致） */
      let off = 0;
      let deferred = false;
      let insnsInSeg = 0;
      for (const p of seg.parts) {
        const L = p.text.trim();
        const li = lineInfo[p.lineNo];
        if (!L || !li) continue;
        let r = null;
        try { r = ks.asm(Preproc.substituteSymbols(L, finalSymMap)); } catch (e) { r = { failed: true }; }
        if (r && !r.failed && r.mc && r.mc.length) {
          li.bytes = Uint8Array.from(r.mc);
          li.offset = off;
          off += r.mc.length;
          insnsInSeg++;
        } else if (r && !r.failed) {
          li.bytes = [];
          li.offset = off;
        } else {
          li.deferred = true;
          deferred = true;
          deferredLines.push(p.lineNo);
        }
      }
      totalInsns += insnsInSeg;
      void deferred;
    });
    const deferredAny = deferredLines.length > 0;

    const hardErrors = pre.errors.slice();
    segs.forEach((seg) => {
      if (seg.kind === 'code' && seg.error) {
        const line = Number.isFinite(seg.errorLine) ? seg.errorLine
          : (seg.startLine !== undefined ? seg.startLine : (seg.parts[0] && seg.parts[0].lineNo) || 0);
        hardErrors.push({ line, message: '汇编失败' });
      }
    });
    const ok = hardErrors.length === 0;

    return {
      ok,
      errors: hardErrors,
      segments: segs,
      image: segs.map(s => ({ addr: s.addr, bytes: s.bytes || new Uint8Array(0), kind: s.kind })),
      codeSegments: segs.filter(s => s.kind === 'code'),
      dataSegments: segs.filter(s => s.kind === 'data'),
      symbols: Object.assign(Object.create(null), finalSymMap),
      equ: pre.equ,
      startAddr,
      untilAddr,
      lineInfo,
      deferredAny,
      totalInsns,
      totalBytes,
      cleaned,
    };
  }

  return { assembleSource, stripComments, regList, ksSyntaxOption, makeKs };
});
