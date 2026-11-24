/* test/assembler.test.js — 汇编流水线核心（真实 Keystone WASM） */
'use strict';

const H = require('./helper.js');
const { test, tests } = H.createSuite();
const { assert, assertEq } = H;
const Assembler = require('../js/core/assembler.js');
const { ARCHES } = require('../js/core/arches.js');

function hex(u8) { return Buffer.from(u8).toString('hex'); }

async function ks() {
  const M = require('@alexaltea/keystone-js');
  return M();
}

test('x86-64 完整示例：伪指令数据 + 符号替换 + 段切分', async () => {
  const lib = await ks();
  const a = ARCHES.x86_64;
  const res = Assembler.assembleSource({ ksLib: lib, arch: a, syntax: 'intel', source: a.example, base: 0x10000 });
  assert(res.ok, 'assemble ok: ' + JSON.stringify(res.errors));
  assert(res.totalInsns >= 8, '>= 8 instructions, got ' + res.totalInsns);
  assertEq(res.symbols.MSG, 0x200000, 'MSG symbol');
  assertEq(res.symbols.MSG_LEN, 13, 'MSG_LEN = 13');
  assertEq(res.symbols.SYS_WRITE, 1, 'SYS_WRITE');
  assertEq(res.startAddr, 0x10000, 'startAddr = _start');
  const data = res.dataSegments[0];
  assertEq(data.addr, 0x200000, 'data addr');
  assertEq(data.bytes.length, 13, '13 bytes');
  assertEq(Buffer.from(data.bytes).toString('latin1'), 'Hello, WASM!\n', 'data content');
  const codeHex = hex(res.codeSegments[0].bytes);
  assert(codeHex.includes('0f05'), 'syscall encoded');
  assert(codeHex.includes('48c7c20d000000'), 'mov rdx, 13 (decimal!)');
});

test('指令计数与实际编码行一致（纯标签行不计）', async () => {
  const lib = await ks();
  const a = ARCHES.x86_64;
  const res = Assembler.assembleSource({
    ksLib: lib, arch: a, syntax: 'intel',
    source: '_start:\nentry:\nmov eax, 1\nret\n.org 0x200000\nmsg: .ascii "hi"',
    base: 0x10000,
  });
  assert(res.ok, 'assemble ok: ' + JSON.stringify(res.errors));
  assertEq(res.totalInsns, 2, '2 real instructions (labels excluded), got ' + res.totalInsns);
  const withBytes = res.lineInfo.filter(l => l.bytes && l.bytes.length).length;
  assertEq(withBytes, res.totalInsns, 'totalInsns == lines that produced bytes');
});

test('跨段符号替换正确编码（mov rsi, MSG ≡ mov rsi, 0x200000）', async () => {
  const lib = await ks();
  const a = ARCHES.x86_64;
  const withSym = Assembler.assembleSource({ ksLib: lib, arch: a, syntax: 'intel', source: 'mov rsi, MSG\n.org 0x200000\nMSG: .ascii "x"', base: 0x10000 });
  const withLit = Assembler.assembleSource({ ksLib: lib, arch: a, syntax: 'intel', source: 'mov rsi, 0x200000', base: 0x10000 });
  assert(withSym.ok, 'withSym ok');
  assertEq(hex(withSym.codeSegments[0].bytes), hex(withLit.codeSegments[0].bytes), 'identical encoding');
});

test('段内标签相对寻址（x86 向后跳转）', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel', source: 'x: nop\njmp x', base: 0x10000 });
  assert(res.ok, 'ok');
  assertEq(hex(res.codeSegments[0].bytes), '90ebfd', 'rel8 -3');
});

test('段内标签向前引用', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel', source: 'jmp e\nnop\nnop\ne: nop', base: 0x10000 });
  assert(res.ok, 'ok');
  assertEq(hex(res.codeSegments[0].bytes), 'eb02909090', 'fwd jmp');
});

test('错误行定位：非法助记符', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel', source: 'nop\nbogus xyz\nnop', base: 0x10000 });
  assert(!res.ok, 'not ok');
  assertEq(res.errors.length, 1, 'one error');
  assertEq(res.errors[0].line, 1, 'line index 1 (2nd line)');
  assert(!res.lineInfo[1].ok, 'line flagged');
});

test('deferred：整体成功但单行不可汇编（标签引用行）', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel', source: 'nop\njnz target\ntarget: nop', base: 0x10000 });
  assert(res.ok, 'whole ok');
  assert(res.deferredAny, 'deferred flagged');
  assert(res.lineInfo.some(l => l.deferred), 'some line deferred');
});

test('AT&T 语法切换', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'att', source: 'movl $5, %eax', base: 0x10000 });
  assert(res.ok, 'ok');
  assertEq(hex(res.codeSegments[0].bytes), 'b805000000', 'att encoding');
});

test('MIPS 示例（$ 寄存器 + syscall 数据段）', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.mips32el, syntax: 'intel', source: ARCHES.mips32el.example, base: 0x10000 });
  assert(res.ok, 'ok: ' + JSON.stringify(res.errors));
  assertEq(res.symbols.MSG, 0x200000, 'MSG');
  assertEq(Buffer.from(res.dataSegments[0].bytes).toString('latin1'), 'Hello, MIPS!\n', 'mips data');
  const codeHex = hex(res.codeSegments[0].bytes);
  assert(codeHex.includes('2000053c'), 'lui encoding (LE)');
});

test('x86-16 实模式示例（.space 数据段）', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_16, syntax: 'intel', source: ARCHES.x86_16.example, base: 0 });
  assert(res.ok, 'ok');
  const buf = res.dataSegments[0];
  assertEq(buf.addr, 0x40, 'buf at 0x40');
  assertEq(buf.bytes.length, 16, '16 zeros');
  assertEq(res.symbols.buf, 0x40, 'buf label');
});

test('ARM 示例（.equ 符号 + 内存往返）', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.arm, syntax: 'intel', source: ARCHES.arm.example, base: 0x10000 });
  assert(res.ok, 'ok: ' + JSON.stringify(res.errors));
  assert(res.codeSegments[0].bytes.length >= 28, '>= 7 instructions');
  assertEq(res.symbols.RESULT, 0x200000, 'RESULT symbol');
});

test('空程序与纯注释', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel', source: '; only comment\n\n', base: 0x10000 });
  assert(res.ok, 'ok');
  assertEq(res.totalBytes, 0, 'zero bytes');
});

test('未知伪指令 → 错误', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel', source: '.include "x"', base: 0x10000 });
  assert(!res.ok, 'not ok');
  assert(res.errors[0].message.includes('不支持的伪指令'), 'directive error');
});

test('非法字符防护：奇异输入不进引擎、快速报错（防 keystone wasm 挂死）', async () => {
  const lib = await ks();
  const t0 = Date.now();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel', source: 'nop\n%%%\n^^^\n%%%^^', base: 0x10000 });
  assert(Date.now() - t0 < 3000, 'must not hang');
  assert(!res.ok, 'not ok');
  const bad = res.lineInfo.filter(l => !l.ok);
  assertEq(bad.length, 3, 'three unsafe lines flagged');
});

test('AT&T 操作数缺 $ → keystone 报错（mov rax, 60 in ATT）', async () => {
  const lib = await ks();
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'att', source: 'mov rax, 60', base: 0x10000 });
  assert(!res.ok, 'ATT without $ must fail');
});

test('布局收敛：代码段大小变化后数据标签地址正确', async () => {
  const lib = await ks();
  // 首轮 code size 0 → MSG=0x10000；实际代码 42 字节 → 收敛后 MSG=0x200000（显式 .org，不受影响）
  // 这里验证顺序布局：代码在前、数据紧跟（无 .org），数据地址 = base + 代码长度
  const res = Assembler.assembleSource({ ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel', source: 'nop\nMSG: .ascii "hi"', base: 0x10000 });
  assert(res.ok, 'ok');
  assertEq(res.codeSegments[0].addr, 0x10000, 'code at base');
  assertEq(res.dataSegments[0].addr, 0x10001, 'data right after code (1 byte nop)');
  assertEq(res.symbols.MSG, 0x10001, 'MSG absolute');
});

module.exports = { tests };
