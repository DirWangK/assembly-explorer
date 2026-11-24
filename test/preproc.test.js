/* test/preproc.test.js — 伪指令预处理器与表达式求值 */
'use strict';

const H = require('./helper.js');
const { test, tests } = H.createSuite();
const { assert, assertEq } = H;
const P = require('../js/core/preproc.js');

function parse(src, base) {
  return P.parseSource(src.split('\n'), { base: base || 0x10000 });
}

test('表达式：十六进制/二进制/十进制/字符', () => {
  const r = parse('.equ A, 0x10\n.equ B, 0b1010\n.equ C, 42\n.equ D, \'A\'\n.equ E, \'\\n\'');
  assertEq(r.equ.A, 16, 'hex');
  assertEq(r.equ.B, 10, 'binary');
  assertEq(r.equ.C, 42, 'decimal');
  assertEq(r.equ.D, 65, 'char');
  assertEq(r.equ.E, 10, 'char escape');
});

test('表达式：四则运算、括号、负号、优先级', () => {
  const r = parse('.equ A, 2+3*4\n.equ B, (2+3)*4\n.equ C, -5\n.equ D, 7/2\n.equ E, 17%5');
  assertEq(r.equ.A, 14, 'priority');
  assertEq(r.equ.B, 20, 'paren');
  assertEq(r.equ.C, -5, 'negative');
  assertEq(r.equ.D, 3, 'div trunc');
  assertEq(r.equ.E, 2, 'mod');
});

test('表达式：除零与未定义符号报错', () => {
  const r = parse('.equ A, 1/0\n.equ B, UNK + 1');
  assertEq(r.errors.length, 2, 'two errors');
  assert(r.errors[0].message.includes('除零'), 'div0 msg');
  assert(r.errors[1].message.includes('未定义符号 UNK'), 'undef msg');
});

test('.equ 引用前序 .equ 常量', () => {
  const r = parse('.equ N, 7\n.equ M, N * 2 + 1');
  assertEq(r.equ.M, 15, 'M');
});

test('.org 记录 orgBase；数据按 .org 起始', () => {
  const r = parse('.org 0x2000\n.byte 1, 2');
  assertEq(r.segments.length, 1, 'one data segment');
  assertEq(r.segments[0].orgBase, 0x2000, 'orgBase');
  assertDeepEqLocal(Array.from(r.segments[0].bytes), [1, 2]);
});
function assertDeepEqLocal(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'deepEq') + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b));
}

test('.byte/.short/.word/.long/.quad 小端字节序（连续数据段合并）', () => {
  const r = parse('.byte 0x12, -1\n.short 0x1234\n.word 0x12345678\n.quad 1');
  assertEq(r.segments.length, 1, 'merged data segment');
  const all = Array.from(r.segments[0].bytes);
  assertDeepEqLocal(all, [0x12, 0xff, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 1, 0, 0, 0, 0, 0, 0, 0], 'LE bytes');
});

test('.ascii 与 .asciz/.string（含转义）', () => {
  const r = parse('.ascii "AB\\n"\n.asciz "CD"');
  assertEq(r.segments.length, 1, 'merged');
  assertDeepEqLocal(Array.from(r.segments[0].bytes), [65, 66, 10, 67, 68, 0], 'ascii+asciz');
});

test('.space 零填充；.align 在有 .org 基址时对齐', () => {
  const r = parse('.org 0x100\n.byte 1\n.align 4\n.byte 2');
  assertDeepEqLocal(Array.from(r.segments[0].bytes), [1, 0, 0, 0, 2], 'pad to 4');
});

test('.align 无显式 .org 基址时报错', () => {
  const r = parse('.byte 1\n.align 4');
  assertEq(r.errors.length, 1, 'align without org');
  assert(r.errors[0].message.includes('.align'), 'message');
});

test('数据标签：段内偏移记录 + . 长度表达式', () => {
  const r = parse('.org 0x200000\nMSG: .ascii "hi"\n.equ LEN, . - MSG');
  const dl = r.dataLabels.find(d => d.name === 'MSG');
  assert(dl, 'MSG bound');
  assertEq(dl.offset, 0, 'MSG offset 0');
  assertEq(dl.seg.bytes.length, 2, 'segment bytes');
  assertEq(r.equ.LEN, 2, 'LEN = dot - MSG (offset semantics)');
});

test('代码段标签记录为名字（供 Keystone 段内解析与 _start 检测）', () => {
  const r = parse('_start:\n  nop\nloop:\n  nop\n  jmp loop');
  const code = r.segments.filter(s => s.kind === 'code');
  assertEq(code.length, 1, 'one contiguous code segment');
  assert(code[0].labels.includes('_start'), '_start bound');
  assert(code[0].labels.includes('loop'), 'loop bound');
});

test('行内"标签 + 指令/伪指令"混合', () => {
  const r = parse('A: nop\nB: .byte 9');
  assertEq(r.segments.length, 2, 'code + data segments');
  assert(r.segments[0].labels.includes('A'), 'A in code seg');
  const dl = r.dataLabels.find(d => d.name === 'B');
  assert(dl && dl.offset === 0, 'B at data offset 0');
  assertEq(r.segments[1].bytes[0], 9, 'data byte');
});

test('重复符号报错；未知伪指令报错', () => {
  const r = parse('.equ X, 1\n.equ X, 2\n.xyz 9');
  assertEq(r.errors.length, 2, 'two errors');
  assert(r.errors[0].message.includes('重复定义'), 'dup');
  assert(r.errors[1].message.includes('不支持的伪指令'), 'unknown directive');
});

test('忽略常见头部伪指令（.text/.global/.type 等）', () => {
  const r = parse('.text\n.global _start\n.type _start, @function\nnop');
  assertEq(r.errors.length, 0, 'no errors');
  assertEq(r.segments.filter(s => s.kind === 'code').length, 1, 'one code segment');
});

test('NAME = EXPR 定义符号；重复报错', () => {
  const r = parse('SIZE = 16\n.equ DOUBLED, SIZE * 2');
  assertEq(r.equ.SIZE, 16, 'SIZE');
  assertEq(r.equ.DOUBLED, 32, 'DOUBLED');
  const r2 = parse('X = 1\nX = 2');
  assertEq(r2.errors.length, 1, 'dup NAME =');
});

test('substituteSymbols：整词替换、长名优先、负值括号', () => {
  const out = P.substituteSymbols('mov rsi, MSG', { MSG: 0x200000 });
  assertEq(out, 'mov rsi, 0x200000', 'MSG replaced');
  const out2 = P.substituteSymbols('add x0, X1, NEG', { NEG: -4, X1: 2 });
  assert(out2.includes('( -4)') || out2.includes('(-4)'), 'negative paren');
  assert(out2.includes('0x2'), 'X1 hex');
});

test('substituteSymbols 不替换子串', () => {
  const out = P.substituteSymbols('mov rax, MSGLEN', { MSG: 1, MSGLEN: 2 });
  assertEq(out, 'mov rax, 0x2', 'only exact word');
});

test('指令段与数据段按顺序切分', () => {
  const r = parse('nop\n.ascii "A"\nnop');
  const kinds = r.segments.map(s => s.kind);
  assertDeepEqLocal(kinds, ['code', 'data', 'code'], 'three segments');
  assertEq(r.segments[1].bytes[0], 65, 'data byte');
});

test('空行与纯标签行不产生字节', () => {
  const r = parse('\n\nLBL:\n\n  nop');
  assertEq(r.segments.filter(s => s.kind === 'code').length, 1, 'one code segment');
  assert(r.segments[0].labels.includes('LBL'), 'LBL bound to code seg');
});

test('文件以标签结尾：标签并入最后代码段文本', () => {
  const r = parse('bneg done\nnop\ndone:');
  const code = r.segments.filter(s => s.kind === 'code');
  assertEq(code.length, 1, 'one code segment');
  assert(code[0].labels.includes('done'), 'done bound');
  assert(code[0].text.includes('done:'), 'label text appended for keystone');
});

test('parseQuoted 转义矩阵', () => {
  assertEq(JSON.stringify(P.parseQuoted('"a\\nb\\t\\"c\\\\d\\x41"')), JSON.stringify([97, 10, 98, 9, 34, 99, 92, 100, 65]), 'escape matrix');
  assertEq(P.parseQuoted('nope'), null, 'unquoted rejected');
});

test('.space 大小限制与 .org 范围检查', () => {
  const r1 = parse('.space 999999999');
  assertEq(r1.errors.length, 1, 'space too big');
  const r2 = parse('.org 0x1FFFFFFFFF');
  assertEq(r2.errors.length, 1, 'org overflow');
});

module.exports = { tests };
