/* hexio.js — 机器码文本 ⇄ 字节 ⇄ 汇编源码（纯逻辑，浏览器与 Node 测试共用）
 *
 * 1. parseHexInput(text) → { regions, bytes, errors }
 *    区域标记（可混排，实现"代码/数据"分区）：
 *      @code 0x10000   其后字节为代码，起始地址 0x10000
 *      @data 0x200000  其后字节为数据（不会被反汇编成垃圾指令）
 *      .org  0x200000  等价于 @code <addr>
 *    省略地址时顺接上一区域末尾。普通行支持：
 *      纯 hex（`48 c7 c0 01` / `48c7c001` / `0x48, 0xc7`）
 *      objdump（`1000: 48 65 6c 6c 6f   hello`）
 *      xxd（`00000000: 4865 6c6c 6f  hello`）
 *    行内 `#` `;` `//` 为注释；`|` 或两个以上空格之后视为 ASCII 尾注。
 *
 * 2. formatImage(image, perLine, base) → 带 `@data` 标记的 hex 文本
 *    3. formatHexDump(bytes, perLine) → 纯 hex 文本
 *    4. disasmToSource(insns, arch) → 单段反汇编源码（分支目标转标签）
 *    5. imageToSource(regions, arch) → 全镜像源码（.org + 标签 + 数据伪指令）
 */
'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.HexIO = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const MARKER_RE = /^@\s*(code|data)\b\s*(.*)$/i;
  const ORG_RE = /^\.org\b\s*(.*)$/i;

  function parseAddr(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    const m = /^(0[xX][0-9a-fA-F]+|\d+)$/.exec(t);
    if (!m) return null;
    return /^0[xX]/.test(m[1]) ? parseInt(m[1].slice(2), 16) : parseInt(m[1], 10);
  }

  /* ---------- 1. hex 文本 → 区域 ---------- */

  function parseHexInput(text) {
    const errors = [];
    const regions = [];
    let cur = null;
    let wantKind = 'code';
    let wantAddr = null;

    function openRegion(line) {
      cur = { kind: wantKind, addr: wantAddr, line, bytes: [] };
      regions.push(cur);
      wantKind = 'code';
      wantAddr = null;
    }

    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (!line.trim()) continue;

      const trimmed = line.trim();
      const marker = MARKER_RE.exec(trimmed);
      if (marker) {
        const addr = parseAddr(marker[2]);
        if (marker[2].trim() && addr === null) {
          errors.push({ line: i, message: '标记地址非法: ' + marker[2].trim() });
        }
        wantKind = marker[1].toLowerCase();
        wantAddr = addr;
        cur = null;
        continue;
      }
      const org = ORG_RE.exec(trimmed);
      if (org) {
        const addr = parseAddr(org[1]);
        if (addr === null) {
          errors.push({ line: i, message: '.org 需要十六进制/十进制地址' });
        } else {
          wantKind = 'code';
          wantAddr = addr;
          cur = null;
        }
        continue;
      }

      /* 注释 */
      const ci = line.search(/(^|\s)(#|;|\/\/)/);
      if (ci !== -1) line = line.slice(0, ci);
      /* objdump/xxd 地址前缀（1-16 位 hex + 冒号） */
      line = line.replace(/^\s*[0-9A-Fa-f]{1,16}:\s*/, '');
      /* ASCII 尾注：`|` 之后或两个以上空格之后全部截断 */
      const cut = line.search(/\||\s{2,}/);
      if (cut !== -1) line = line.slice(0, cut);
      const tok = line.trim();
      if (!tok) continue;

      const clean = tok.replace(/0[xX]/g, '').replace(/[,]/g, '').replace(/\s+/g, '');
      if (!/^[0-9A-Fa-f]*$/.test(clean)) {
        errors.push({ line: i, message: '含非十六进制内容: ' + tok.slice(0, 24) });
        continue;
      }
      if (clean.length % 2) {
        errors.push({ line: i, message: '十六进制位数为奇数' });
        continue;
      }
      if (!clean.length) continue;

      if (!cur) openRegion(i);
      for (let j = 0; j < clean.length; j += 2) {
        cur.bytes.push(parseInt(clean.slice(j, j + 2), 16));
      }
    }

    const out = regions
      .filter(r => r.bytes.length)
      .map(r => ({ kind: r.kind, addr: r.addr, line: r.line, bytes: Uint8Array.from(r.bytes) }));

    let total = 0;
    for (const r of out) total += r.bytes.length;
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const r of out) { bytes.set(r.bytes, off); off += r.bytes.length; }

    return { regions: out, bytes, errors };
  }

  /* ---------- 2/3. 字节 → hex 文本 ---------- */

  function formatHexDump(bytes, perLine) {
    const n = perLine || 16;
    const rows = [];
    for (let i = 0; i < bytes.length; i += n) {
      const chunk = [];
      for (let j = i; j < Math.min(i + n, bytes.length); j++) {
        chunk.push(bytes[j].toString(16).padStart(2, '0'));
      }
      rows.push(chunk.join(' '));
    }
    return rows.join('\n');
  }

  /* image: [{addr, bytes, kind}]；base 为预期的首段地址（相等时不加 @code 标记） */
  function formatImage(image, perLine, base) {
    const n = perLine || 16;
    const lines = [];
    let cursor = (base === undefined || base === null) ? null : base;
    for (const seg of image || []) {
      const bytes = seg.bytes;
      if (!bytes || !bytes.length) continue;
      const isData = seg.kind === 'data';
      if (isData || cursor === null || seg.addr !== cursor) {
        lines.push('@' + (isData ? 'data' : 'code') + ' 0x' + seg.addr.toString(16));
      }
      for (let i = 0; i < bytes.length; i += n) {
        const chunk = [];
        for (let j = i; j < Math.min(i + n, bytes.length); j++) {
          chunk.push(bytes[j].toString(16).padStart(2, '0'));
        }
        lines.push(chunk.join(' '));
      }
      cursor = seg.addr + bytes.length;
    }
    return lines.join('\n');
  }

  /* ---------- 4. 单段反汇编 → 源码（分支目标转标签） ---------- */

  function pickTarget(opStr, base, end) {
    const re = /0[xX]([0-9a-fA-F]+)/g;
    let m, last = null;
    while ((m = re.exec(opStr)) !== null) {
      const v = parseInt(m[1], 16);
      if (v >= base && v < end) last = v;
    }
    return last;
  }

  function disasmToSource(insns, arch) {
    const flow = new Set([...(arch.callLike || []), ...(arch.branchLike || [])]);
    const segBase = insns.length ? insns[0].address : 0;
    const last = insns.length ? insns[insns.length - 1] : null;
    const segEnd = last ? last.address + (last.size || 1) : 0;

    const targets = new Map();
    for (const ins of insns) {
      if (!flow.has(ins.mnemonic)) continue;
      const t = pickTarget(ins.op_str || '', segBase, segEnd);
      if (t !== null && t !== Number(ins.address)) targets.set(t, 'L_' + t.toString(16));
    }

    const lines = [];
    for (const ins of insns) {
      if (targets.has(Number(ins.address))) lines.push(targets.get(Number(ins.address)) + ':');
      let op = ins.op_str || '';
      op = op.replace(/(0[xX][0-9a-fA-F]+)/g, (m0) => {
        const v = parseInt(m0.slice(2), 16);
        return targets.has(v) ? targets.get(v) : m0;
      });
      lines.push(ins.mnemonic + (op ? ' ' + op : ''));
    }
    const labels = {};
    for (const [addr, name] of targets) labels[addr] = name;
    return { source: lines.join('\n'), labels };
  }

  /* ---------- 5. 全镜像 → 源码（含数据段） ---------- */

  function asciiPreview(bytes) {
    return '|' + Array.from(bytes)
      .map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.')
      .join('') + '|';
  }

  function escAsmString(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }

  function bytesToDataDirectives(bytes, perLine) {
    const n = perLine || 16;
    const allPrintable = Array.from(bytes)
      .every(b => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09);
    if (allPrintable && bytes.length >= 4) {
      const s = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
      return ['.ascii "' + escAsmString(s) + '"  ; ' + asciiPreview(bytes)];
    }
    const rows = [];
    for (let i = 0; i < bytes.length; i += n) {
      const slice = bytes.slice(i, Math.min(i + n, bytes.length));
      const vals = Array.from(slice).map(b => '0x' + b.toString(16).padStart(2, '0'));
      rows.push('.byte ' + vals.join(', ') + '  ; ' + asciiPreview(slice));
    }
    return rows;
  }

  /*
   * regions: [
   *   { kind:'code', addr, bytes, insns?:[{address,size,mnemonic,op_str}] },
   *   { kind:'data', addr, bytes },
   * ]
   * 返回 { source, labels }
   */
  function imageToSource(regions, arch) {
    const lines = [];
    const labels = {};
    let cursor = null;
    for (const region of regions || []) {
      const bytes = region.bytes;
      if (!bytes || !bytes.length) continue;
      const addr = region.addr;
      if (cursor === null || addr !== cursor) lines.push('.org 0x' + addr.toString(16));

      if (region.kind === 'data') {
        lines.push('; data @ 0x' + addr.toString(16) + ' · ' + bytes.length + ' B');
        lines.push(...bytesToDataDirectives(bytes, 16));
      } else {
        const insns = region.insns || [];
        lines.push('; code @ 0x' + addr.toString(16) + ' · ' + bytes.length + ' B');
        const gen = disasmToSource(insns, arch);
        Object.assign(labels, gen.labels);
        if (gen.source) lines.push(gen.source);
        /* Capstone 无法解码的尾部字节按数据保留，保证往返不丢字节 */
        let covered = 0;
        for (const ins of insns) covered += (ins.size || 0);
        if (covered < bytes.length) {
          const tail = bytes.slice(covered);
          lines.push('; ' + tail.length + ' 字节无法解码，按数据保留');
          lines.push(...bytesToDataDirectives(tail, 16));
        }
      }
      cursor = addr + bytes.length;
    }
    return { source: lines.join('\n'), labels };
  }

  return {
    parseHexInput, formatHexDump, formatImage,
    disasmToSource, imageToSource,
    bytesToDataDirectives, pickTarget, parseAddr,
  };
});
