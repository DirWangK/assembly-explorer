/* hexio.js — 机器码输入/输出（纯逻辑，浏览器与 Node 测试共用）
 *
 * 1. parseHexInput(text)：把用户粘贴的机器码文本解析为字节。
 *    支持格式：纯 hex（`48 c7 c0 01` / `48c7c001` / `0x48, 0xc7`）、
 *    objdump（`1000: 48 65 6c 6c 6f   hello`）、xxd（`00000000: 4865 6c6c 6f  hello`）。
 *    行内 `#` `;` `//` 视为注释；`|` 与两个以上空格之后的内容视为 ASCII 尾注截断。
 *
 * 2. formatHexDump(bytes, perLine)：字节 → 纯 hex 文本（无地址前缀，可直接回贴）。
 *
 * 3. disasmToSource(insns, arch)：Capstone 反汇编结果 → 可重新汇编的汇编源码。
 *    分支/调用指令的目标地址自动转成标签（`L_<hex>`），保证跳转往返后编码一致。
 */
'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.HexIO = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /* ---------- 1. hex 文本 → 字节 ---------- */

  function parseHexInput(text) {
    const bytes = [];
    const errors = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (!line.trim()) continue;
      /* 注释 */
      line = line.replace(/(^|\s)(#|;|\/\/).*/, '');
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
      for (let j = 0; j < clean.length; j += 2) bytes.push(parseInt(clean.slice(j, j + 2), 16));
    }
    return { bytes: Uint8Array.from(bytes), errors };
  }

  /* ---------- 2. 字节 → hex 文本 ---------- */

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

  /* ---------- 3. 反汇编 → 汇编源码 ---------- */

  /* 挑选分支目标：op_str 中最后一个落在代码范围内的 0x 地址 */
  function pickTarget(opStr, base, end) {
    const re = /0[xX]([0-9a-fA-F]+)/g;
    let m, last = null;
    while ((m = re.exec(opStr)) !== null) {
      const v = parseInt(m[1], 16);
      if (v >= base && v < end) last = v;
    }
    return last;
  }

  /*
   * insns: [{address:Number, size:Number, mnemonic, op_str}]（Capstone 结果，地址已转 Number）
   * arch:  ARCHES[id]（使用 callLike/branchLike）
   * 返回:  { source, labels: {addr: name} }
   */
  function disasmToSource(insns, arch) {
    const flow = new Set([...(arch.callLike || []), ...(arch.branchLike || [])]);
    const segBase = insns.length ? insns[0].address : 0;
    const segEnd = insns.length ? insns[insns.length - 1].address + (insns[insns.length - 1].size || 1) : 0;

    /* 收集分支目标 → 标签名 */
    const targets = new Map();
    for (const ins of insns) {
      if (!flow.has(ins.mnemonic)) continue;
      const t = pickTarget(ins.op_str || '', segBase, segEnd);
      if (t !== null && t !== Number(ins.address)) targets.set(t, 'L_' + t.toString(16));
    }

    /* 生成源码行 */
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

  return { parseHexInput, formatHexDump, disasmToSource, pickTarget };
});
