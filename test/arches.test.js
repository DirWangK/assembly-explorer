/* test/arches.test.js — 架构定义表完整性与注释剥离规则 */
'use strict';

const H = require('./helper.js');
const { test, tests } = H.createSuite();
const { assert, assertEq } = H;
const { ARCHES, regList, stripComments, REGEX, ARCH_GROUP_BY_ID } = require('../js/core/arches.js');

test('全部架构定义完整性（寄存器唯一、示例与字段齐全）', () => {
  for (const a of Object.values(ARCHES)) {
    assert(a.example && a.example.length > 10, a.id + ' example missing');
    assert(Array.isArray(a.callLike) && a.callLike.length, a.id + ' callLike missing');
    assert(a.pc && a.pc[1], a.id + ' pc missing');
    assert(a.layout, a.id + ' layout missing');
    assert(['x86', 'arm', 'mips', 'ppc', 'sparc'].includes(a.group), a.id + ' group');
    const regs = regList(a);
    const names = regs.map(r => r[0]);
    assertEq(new Set(names).size, names.length, a.id + ' duplicate reg display names');
    for (const [, c] of regs) assert(/^([A-Z0-9]+)_REG_/.test(c), a.id + ' bad const ' + c);
  }
});

test('寄存器别名可命中（sp/pc）', () => {
  const a = ARCHES.x86_64;
  assert(a.spAliases.includes('rsp'), 'x86_64 rsp alias');
  assert(a.pcAliases.includes('rip'), 'x86_64 rip alias');
});

test('stripComments：x86 分号注释', () => {
  const out = stripComments('mov rax, 1 ; comment\nnop', ARCHES.x86_64);
  assertEq(out, 'mov rax, 1 \nnop');
});

test('stripComments：ARM 的 @ 注释且保留 # 立即数', () => {
  const out = stripComments('mov r0, #1 @ cmt', ARCHES.arm);
  assertEq(out, 'mov r0, #1 ', '@ stripped, # kept');
});

test('stripComments：MIPS 的 # 注释', () => {
  const out = stripComments('addiu $v0, $zero, 1 # cmt', ARCHES.mips32el);
  assertEq(out, 'addiu $v0, $zero, 1 ', '# stripped');
});

test('stripComments：SPARC 的 ! 注释', () => {
  const out = stripComments('nop ! cmt', ARCHES.sparc32be);
  assertEq(out, 'nop ');
});

test('stripComments：// 注释全架构通用', () => {
  for (const a of Object.values(ARCHES)) {
    const out = stripComments('nop // cmt', a);
    assertEq(out, 'nop ', a.id + ' // comment');
  }
});

test('注释字符不出现在指令内部时不影响', () => {
  const out = stripComments('mov rax, 0x3c', ARCHES.x86_64);
  assertEq(out, 'mov rax, 0x3c');
});

test('ARCH_GROUP_BY_ID 映射完整', () => {
  assertEq(Object.keys(ARCH_GROUP_BY_ID).length, Object.keys(ARCHES).length, 'same count');
});

test('REGEX 覆盖每组架构', () => {
  for (const g of ['x86', 'arm', 'mips', 'ppc', 'sparc']) assert(REGEX[g], 'regex for ' + g);
});
module.exports = { tests };
