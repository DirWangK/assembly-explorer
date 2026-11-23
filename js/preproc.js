/* preproc.js — 汇编伪指令预处理（纯逻辑，浏览器与 Node 测试共用）
 *
 * 设计（两阶段）：
 *   1) parseSource：符号化解析。按 .org/指令/数据 把源码切成有序段列表：
 *      - 数据段：立即产生字节 + 段内偏移（标签记录为 {name, offset}）
 *      - 代码段：仅保留文本（行级 parts），段内标签交给 Keystone 相对解析
 *      - 符号：.equ 常量 + 数据标签（段内偏移形式）
 *      代码段大小在解析期未知 → 数据标签此时只有"偏移"，没有绝对地址。
 *   2) 布局（在 assembler.js 中做多轮定点迭代）：
 *      逐段顺序排布（.org 显式重定位），代码段汇编出大小后重排，
 *      数据标签绝对地址 = 段地址 + 段内偏移；收敛后完成替换与编码。
 *
 * 支持的伪指令（大小写不敏感）：
 *   .org ADDR            设置下一段的绝对地址（ADDR 仅可用常量与 .equ 符号）
 *   .align N             数据段内对齐（要求该段有显式 .org 基址）
 *   .byte b[,b...]       1 字节
 *   .short/.half/.2byte  2 字节；.word/.long/.4byte 4 字节；.quad/.8byte 8 字节
 *   .ascii "s"           字符串（不加 \0）；.asciz/.string 追加 \0
 *   .space N / .zero N   N 个零字节
 *   .equ NAME, EXPR      定义符号常量（也支持 NAME = EXPR、.set）
 *                        EXPR 中：整数/字符/'.'/'数据标签' 均为段内偏移语义，
 *                        适合计算长度（如 .equ LEN, . - MSG）
 *   .global/.text/.data/.section 等  接受但忽略
 *
 * 表达式：0x/0b/十进制整数、字符 'A'、+ - * / % 与括号、负号。
 */
'use strict';

const DOT = '.';
const IGNORED_DIRECTIVES = new Set([
  '.global', '.globl', '.text', '.data', '.section', '.bss', '.extern',
  '.type', '.size', '.file', '.ident', '.option', '.arch', '.local', '.weak',
]);

function isDirective(line) {
  return /^\s*\.[a-zA-Z]/.test(line);
}

/* ---------- 表达式求值（递归下降） ---------- */

function createExprEval(ctx) {
  // ctx: { getSymbol(name) -> number|undefined, location() -> number, allowLabels: bool }

  function charCode(inner) {
    if (inner === '') return 0;
    const s = inner
      .replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      .replace(/\\0/g, '\0').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    return s.charCodeAt(0) || 0;
  }

  function tokenize(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if ('()+-*/%'.includes(c)) { toks.push({ t: c }); i++; continue; }
      if (c === "'") {
        const m = /^'((?:\\.|[^'\\])?)'/.exec(s.slice(i));
        if (!m) throw new Error('字符字面量非法');
        toks.push({ t: 'num', v: charCode(m[1]) });
        i += m[0].length; continue;
      }
      if (c >= '0' && c <= '9') {
        const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)/.exec(s.slice(i));
        if (!m) throw new Error('数字格式非法');
        let v;
        if (/^0[xX]/.test(m[0])) v = parseInt(m[0].slice(2), 16);
        else if (/^0[bB]/.test(m[0])) v = parseInt(m[0].slice(2), 2);
        else v = parseInt(m[0], 10);
        toks.push({ t: 'num', v });
        i += m[0].length; continue;
      }
      if (/[A-Za-z_.$]/.test(c)) {
        const m = /^[A-Za-z_.$][\w.$]*/.exec(s.slice(i));
        toks.push({ t: 'sym', v: m[0] });
        i += m[0].length; continue;
      }
      throw new Error('表达式含非法字符 "' + c + '"');
    }
    return toks;
  }

  return function evaluate(exprText) {
    const toks = tokenize(exprText);
    let pos = 0;
    const peek = () => toks[pos];
    const next = () => toks[pos++];
    function expect(t) {
      const tk = next();
      if (!tk || tk.t !== t) throw new Error('表达式缺少 "' + t + '"');
    }
    function primary() {
      const tk = next();
      if (!tk) throw new Error('表达式意外结束');
      if (tk.t === 'num') return tk.v;
      if (tk.t === '-') return -primary();
      if (tk.t === '+') return primary();
      if (tk.t === '(') { const v = expr(); expect(')'); return v; }
      if (tk.t === 'sym') {
        if (tk.v === DOT) return ctx.location();
        const v = ctx.getSymbol(tk.v);
        if (v === undefined) throw new Error('未定义符号 ' + tk.v);
        return v;
      }
      throw new Error('表达式含意外记号 ' + tk.t);
    }
    function mul() {
      let v = primary();
      while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
        const op = next().t;
        const r = primary();
        if ((op === '/' || op === '%') && r === 0) throw new Error('除零');
        v = op === '*' ? v * r : op === '/' ? Math.trunc(v / r) : v % r;
      }
      return v;
    }
    function expr() {
      let v = mul();
      while (peek() && (peek().t === '+' || peek().t === '-')) {
        const op = next().t;
        const r = mul();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    const v = expr();
    if (pos !== toks.length) throw new Error('表达式含多余记号');
    return v;
  };
}

/* ---------- 字符串字面量（支持 \n \t \r \0 \\ \" \xHH） ---------- */

function parseQuoted(s) {
  const m = /^"((?:[^"\\]|\\.)*)"\s*$/.exec(s);
  if (!m) return null;
  const body = m[1];
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c !== '\\') { out += c; i++; continue; }
    const n = body[i + 1];
    if (n === undefined) throw new Error('字符串转义不完整');
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '0') out += '\0';
    else if (n === '\\') out += '\\';
    else if (n === '"') out += '"';
    else if (n === 'x') {
      const hex = /^\\x([0-9a-fA-F]{1,2})/.exec(body.slice(i));
      if (!hex) throw new Error('\\x 转义非法');
      out += String.fromCharCode(parseInt(hex[1], 16));
      i += hex[0].length;
      continue;
    } else out += n;
    i += 2;
  }
  /* 非 ASCII 字符按 UTF-8 编码（与真实汇编器/调试器内存语义一致） */
  return Array.from(new TextEncoder().encode(out));
}

function splitTop(s, sep) {
  return s.split(sep).map(x => x.trim()).filter(x => x !== '');
}

/* 整数 → 小端字节数组 */
function intToBytes(n, size) {
  const out = [];
  let v = BigInt(Math.trunc(n));
  if (v < 0n) v += 1n << BigInt(size * 8);
  for (let i = 0; i < size; i++) { out.push(Number(v & 0xFFn)); v >>= 8n; }
  return out;
}

/* 跨段符号整词替换：只替换 symMap 中的名字 */
function substituteSymbols(text, symMap) {
  const names = Object.keys(symMap);
  if (!names.length) return text;
  const sorted = names.sort((a, b) => b.length - a.length);
  const re = new RegExp('(?<![\\w.$])(' + sorted.map(escapeRe).join('|') + ')(?![\\w.$])', 'g');
  return text.replace(re, (m) => {
    const v = symMap[m];
    return v >= 0 ? '0x' + v.toString(16) : '(' + v + ')';
  });
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ---------- 主解析器（符号化） ---------- */
/*
 * 返回:
 * {
 *   segments: [
 *     { kind:'code', orgBase|null, parts:[{lineNo,text}], text, labels:[names], addr:null, bytes:null }
 *     { kind:'data', orgBase|null, bytes:Uint8Array, labels:[{name, offset}], startLine, endLine }
 *   ],
 *   equ:      { NAME: value },
 *   errors:   [{line, message}],
 *   lineInfo: [{kind, segIndex, offset}]
 * }
 */
function parseSource(lines, opts) {
  const equ = Object.create(null);
  const dataLabels = [];   // {name, segIdx, offset}
  const usedNames = new Set();
  const errors = [];
  const segments = [];
  const lineInfo = [];

  let pendingOrg = null;   // 下一段的显式基址（null = 顺序排布）
  let pendingLabels = [];  // [{name, lineNo}]
  let openSeg = null;
  let openKind = null;
  let dataOffset = 0;      // 当前数据段内偏移

  function isTaken(name) { return usedNames.has(name); }

  function flush() {
    if (!openSeg) { openKind = null; return; }
    if (openSeg.kind === 'code') {
      openSeg.text = openSeg.parts.map(p => p.text).join('\n');
    } else {
      openSeg.bytes = Uint8Array.from(openSeg.bytes);
    }
    segments.push(openSeg);
    openSeg = null;
    openKind = null;
  }

  function open(kind, lineNo) {
    if (openKind !== kind) {
      flush();
      openKind = kind;
      if (kind === 'code') {
        openSeg = { kind, orgBase: pendingOrg, parts: [], labels: [], startLine: lineNo, endLine: lineNo };
        bindCodeLabels(openSeg);
        pendingOrg = null;
      } else {
        openSeg = { kind, orgBase: pendingOrg, bytes: [], labels: [], startLine: lineNo, endLine: lineNo, dataLineNos: [] };
        bindDataLabels();
        pendingOrg = null;
      }
    } else {
      /* 同类段继续：数据段中途的标签绑定到当前偏移；代码段中途标签并入段文本 */
      if (kind === 'data') bindDataLabels();
      else bindCodeLabels(openSeg);
    }
    return openSeg;
  }

  /* 代码标签：记录名字并注入 "label:" 文本——Keystone 需在段文本内看到标签才能解析引用 */
  function bindCodeLabels(seg) {
    if (!pendingLabels.length) return;
    const names = [];
    let firstLine = Infinity;
    for (const p of pendingLabels) {
      if (isTaken(p.name)) { errors.push({ line: p.lineNo, message: '符号重复定义: ' + p.name }); continue; }
      usedNames.add(p.name);
      seg.labels.push(p.name);
      names.push(p.name);
      firstLine = Math.min(firstLine, p.lineNo);
    }
    if (names.length) seg.parts.push({ lineNo: firstLine, text: names.map(n => n + ':').join(' ') });
    pendingLabels = [];
  }

  function bindDataLabels() {
    for (const p of pendingLabels) {
      if (isTaken(p.name)) { errors.push({ line: p.lineNo, message: '符号重复定义: ' + p.name }); continue; }
      usedNames.add(p.name);
      openSeg.labels.push({ name: p.name, offset: dataOffset });
      dataLabels.push({ name: p.name, offset: dataOffset, seg: openSeg });
    }
    pendingLabels = [];
  }

  const evalConst = createExprEval({
    getSymbol: (n) => (n in equ ? equ[n] : undefined),
    location: () => { throw new Error('`.` 仅在数据上下文可用'); },
  });
  const evalData = createExprEval({
    getSymbol: (n) => {
      if (n in equ) return equ[n];
      const dl = dataLabels.find(d => d.name === n && d.seg === openSeg);
      if (dl) return dl.offset;
      const anyDl = dataLabels.find(d => d.name === n);
      if (anyDl) return anyDl.offset; // 跨数据段标签：按其段内偏移（用于长度估算）
      return undefined;
    },
    location: () => dataOffset,
  });

  function emitBytes(arr, lineNo) {
    const seg = open('data', lineNo);
    seg.endLine = Math.max(seg.endLine, lineNo);
    if (!seg.dataLineNos.includes(lineNo)) seg.dataLineNos.push(lineNo);
    for (const b of arr) seg.bytes.push(((b % 256) + 256) % 256);
    dataOffset += arr.length;
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    const info = { kind: 'blank', segIndex: -1, offset: -1 };
    if (!line) { lineInfo.push(info); continue; }

    /* 行首标签 */
    let rest = line;
    const labels = [];
    let lm;
    while ((lm = /^([A-Za-z_.$][\w.$]*)\s*:\s*/.exec(rest))) {
      labels.push(lm[1]);
      rest = rest.slice(lm[0].length);
    }
    if (labels.length) pendingLabels.push(...labels.map(n => ({ name: n, lineNo: li })));
    if (rest === '' && labels.length) {
      info.kind = 'label';
      lineInfo.push(info);
      continue;
    }
    if (rest === '') { lineInfo.push(info); continue; }

    /* 伪指令 */
    if (isDirective(rest)) {
      const m = /^(\.[A-Za-z][\w.]*)\s*(.*)$/.exec(rest);
      const dir = m[1].toLowerCase();
      const argStr = m[2].trim();
      info.kind = 'directive';
      try {
        if (dir === '.org') {
          flush();
          const addr = evalConst(argStr);
          if (addr < 0 || addr > 0xFFFFFFFF) throw new Error('地址超出 32 位范围');
          pendingOrg = addr;
        } else if (dir === '.align') {
          const n = evalConst(argStr);
          if (n <= 0 || n > 65536 || (n & (n - 1)) !== 0) throw new Error('对齐值必须是 2 的幂');
          const seg = open('data', li);
          if (seg.orgBase === null || seg.orgBase === undefined) {
            throw new Error('.align 需要确定的段基址：请先用 .org 指定本段起始地址');
          }
          const abs = seg.orgBase + dataOffset;
          const pad = (n - (abs % n)) % n;
          if (pad > 0) emitBytes(new Array(pad).fill(0), li);
        } else if (dir === '.byte') {
          const vals = splitTop(argStr, ',');
          if (!vals.length) throw new Error('.byte 需要操作数');
          const arr = [];
          for (const v of vals) {
            const n = evalConst(v);
            if (n < -128 || n > 255) throw new Error('数值超出 1 字节范围: ' + v);
            arr.push(n);
          }
          emitBytes(arr, li);
        } else if (dir === '.short' || dir === '.half' || dir === '.2byte' || dir === '.word' || dir === '.long' || dir === '.4byte' || dir === '.quad' || dir === '.8byte') {
          const size = { '.short': 2, '.half': 2, '.2byte': 2, '.word': 4, '.long': 4, '.4byte': 4, '.quad': 8, '.8byte': 8 }[dir];
          const vals = splitTop(argStr, ',');
          if (!vals.length) throw new Error(dir + ' 需要操作数');
          const arr = [];
          for (const v of vals) {
            const n = evalConst(v);
            const lo = -(2 ** (size * 8 - 1)), hi = 2 ** (size * 8) - 1;
            if (n < lo || n > hi) throw new Error('数值超出 ' + size + ' 字节范围: ' + v);
            arr.push(...intToBytes(n, size));
          }
          emitBytes(arr, li);
        } else if (dir === '.ascii' || dir === '.asciz' || dir === '.string') {
          if (!argStr) throw new Error(dir + ' 需要字符串操作数');
          const bytes = parseQuoted(argStr);
          if (bytes === null) throw new Error('字符串必须用双引号包裹');
          emitBytes(bytes, li);
          if (dir !== '.ascii') emitBytes([0], li);
        } else if (dir === '.space' || dir === '.zero') {
          const n = evalConst(argStr);
          if (n < 0 || n > (1 << 20)) throw new Error('.space 大小非法');
          emitBytes(new Array(n).fill(0), li);
        } else if (dir === '.equ' || dir === '.set') {
          const mm = /^([A-Za-z_.$][\w.$]*)\s*,\s*(.+)$/.exec(argStr);
          if (!mm) throw new Error(dir + ' 需要 "名字, 表达式"');
          if (isTaken(mm[1])) throw new Error('符号重复定义: ' + mm[1]);
          equ[mm[1]] = evalData(mm[2]);
          usedNames.add(mm[1]);
        } else if (IGNORED_DIRECTIVES.has(dir)) {
          /* 兼容常见头部，接受但忽略 */
        } else {
          throw new Error('不支持的伪指令 ' + dir + '（支持: .org/.align/.byte/.word/.long/.quad/.ascii/.asciz/.string/.space/.zero/.equ）');
        }
      } catch (e) {
        errors.push({ line: li, message: (e && e.message) || String(e) });
      }
      lineInfo.push(info);
      continue;
    }

    /* `NAME = EXPR` */
    const eq = /^([A-Za-z_.$][\w.$]*)\s*=\s*(.+)$/.exec(rest);
    if (eq) {
      try {
        if (isTaken(eq[1])) throw new Error('符号重复定义: ' + eq[1]);
        equ[eq[1]] = evalData(eq[2]);
        usedNames.add(eq[1]);
        info.kind = 'directive';
      } catch (e) {
        errors.push({ line: li, message: (e && e.message) || String(e) });
      }
      lineInfo.push(info);
      continue;
    }

    /* 指令行 */
    info.kind = 'code';
    const seg = open('code', li);
    seg.endLine = li;
    seg.parts.push({ lineNo: li, text: rest });
    lineInfo.push(info);
  }
  /* 文件以标签结尾：并入最后一个段（代码段追加标签文本；数据段绑定到末尾偏移） */
  if (pendingLabels.length) {
    if (openSeg && openSeg.kind === 'code') {
      bindCodeLabels(openSeg);
    } else if (openSeg && openSeg.kind === 'data') {
      bindDataLabels();
    } else {
      for (const p of pendingLabels) {
        errors.push({ line: p.lineNo, message: '标签 ' + p.name + ' 未落在任何段中' });
      }
    }
    pendingLabels = [];
  }
  flush();

  return { segments, equ, dataLabels, errors, lineInfo };
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseSource, substituteSymbols, parseQuoted, intToBytes,
    isDirective, splitTop, createExprEval, IGNORED_DIRECTIVES,
  };
}
if (typeof self !== 'undefined') {
  self.Preproc = { parseSource, substituteSymbols, parseQuoted, intToBytes, isDirective, splitTop, createExprEval, IGNORED_DIRECTIVES };
}
