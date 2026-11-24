/* test/hexio.test.js — 机器码解析与反汇编→源码生成（含真实引擎往返） */
'use strict';

const H = require('./helper.js');
const { test, tests } = H.createSuite();
const { assert, assertEq } = H;
const HexIO = require('../js/hexio.js');
const Assembler = require('../js/assembler.js');
const { ARCHES } = require('../js/arches.js');

function hex(u8) { return Buffer.from(u8).toString('hex'); }

/* ---------- parseHexInput ---------- */

test('hex 解析：空格分隔', () => {
  const { bytes, errors } = HexIO.parseHexInput('48 c7 c0 01');
  assertEq(errors.length, 0, 'no errors');
  assertEq(hex(bytes), '48c7c001', 'bytes');
});

test('hex 解析：紧凑格式与 0x 前缀', () => {
  assertEq(hex(HexIO.parseHexInput('48c7c001').bytes), '48c7c001', 'compact');
  assertEq(hex(HexIO.parseHexInput('0x48, 0xc7, 0xc0, 0x01').bytes), '48c7c001', '0x prefix');
});

test('hex 解析：多行拼接', () => {
  const { bytes, errors } = HexIO.parseHexInput('48 c7 c0\n01 00 00');
  assertEq(errors.length, 0, 'no errors');
  assertEq(hex(bytes), '48c7c0010000', 'multi-line');
});

test('hex 解析：objdump 格式（地址前缀 + ASCII 尾注）', () => {
  const src = '1000:\t48 65 6c 6c 6f\t\tHELO\n\t2e 2e 2e\t\t...\n';
  const { bytes, errors } = HexIO.parseHexInput(src);
  assertEq(errors.length, 0, 'no errors');
  assertEq(hex(bytes), '48656c6c6f2e2e2e', 'objdump');
});

test('hex 解析：xxd 格式（分组 hex + ASCII 尾注）', () => {
  const src = '00000000: 4865 6c6c 6f20  Hello\n00000008: 5741 534d       WASM';
  const { bytes, errors } = HexIO.parseHexInput(src);
  assertEq(errors.length, 0, 'no errors');
  assertEq(hex(bytes), '48656c6c6f205741534d', 'xxd');
});

test('hex 解析：注释行与空行', () => {
  const { bytes, errors } = HexIO.parseHexInput('# 这是注释\n; 也是\n// 一样\n\n90 90');
  assertEq(errors.length, 0, 'no errors');
  assertEq(hex(bytes), '9090', 'only code bytes');
});

test('hex 解析：奇数长度与非 hex 内容报错', () => {
  const r1 = HexIO.parseHexInput('48 c7 c0 1');
  assertEq(r1.errors.length, 1, 'odd length');
  assert(r1.errors[0].message.includes('奇数'), 'odd msg');
  const r2 = HexIO.parseHexInput('48\nzz\n90');
  assertEq(r2.errors.length, 1, 'garbage line');
  assert(r2.errors[0].message.includes('非十六进制'), 'garbage msg');
  // 出错行被跳过，其余正常
  assertEq(hex(r2.bytes), '4890', 'error line skipped');
});

test('formatHexDump：每行 16 字节纯 hex', () => {
  const bytes = Uint8Array.from({ length: 34 }, (_, i) => i);
  const out = HexIO.formatHexDump(bytes, 16);
  const lines = out.split('\n');
  assertEq(lines.length, 3, '3 rows');
  assertEq(lines[0].split(' ').length, 16, '16 per row');
  assertEq(lines[2].split(' ').length, 2, 'tail row');
});

/* ---------- disasmToSource（mock 指令） ---------- */

test('源码生成：分支目标自动转标签', () => {
  const arch = ARCHES.x86_64;
  const insns = [
    { address: 0x10000, size: 2, mnemonic: 'xor', op_str: 'eax, eax' },
    { address: 0x10002, size: 2, mnemonic: 'jmp', op_str: '0x10008' },
    { address: 0x10004, size: 1, mnemonic: 'nop' },
    { address: 0x10005, size: 1, mnemonic: 'nop' },
    { address: 0x10006, size: 1, mnemonic: 'nop' },
    { address: 0x10008, size: 1, mnemonic: 'ret' },
  ];
  const { source, labels } = HexIO.disasmToSource(insns, arch);
  assert(labels[0x10008] === 'L_10008', 'label registered');
  assert(source.includes('L_10008:'), 'label line emitted');
  assert(source.includes('jmp L_10008'), 'branch target replaced');
  assert(!source.includes('0x10008'), 'raw address gone');
  // 顺序：标签行先于目标指令
  const li = source.split('\n');
  assert(li.indexOf('L_10008:') < li.indexOf('ret'), 'label before target');
});

test('源码生成：代码范围外的地址保留原样', () => {
  const insns = [
    { address: 0x10000, size: 2, mnemonic: 'call', op_str: '0x90000' },
    { address: 0x10002, size: 1, mnemonic: 'ret' },
  ];
  const { source } = HexIO.disasmToSource(insns, ARCHES.x86_64);
  assert(source.includes('call 0x90000'), 'external target kept raw');
  assert(!source.includes('L_'), 'no label');
});

/* ---------- 区域标记（代码 / 数据分区） ---------- */

test('区域解析：@code / @data 标记与地址', () => {
  const { regions, errors } = HexIO.parseHexInput('@code 0x10000\n90 90\n@data 0x200000\n48 69 0a');
  assertEq(errors.length, 0, 'no errors');
  assertEq(regions.length, 2, 'two regions');
  assertEq(regions[0].kind, 'code', 'first code');
  assertEq(regions[0].addr, 0x10000, 'code addr');
  assertEq(hex(regions[0].bytes), '9090', 'code bytes');
  assertEq(regions[1].kind, 'data', 'second data');
  assertEq(regions[1].addr, 0x200000, 'data addr');
  assertEq(hex(regions[1].bytes), '48690a', 'data bytes');
});

test('区域解析：.org 作为代码区标记；省略地址顺接', () => {
  const { regions, errors } = HexIO.parseHexInput('.org 0x1000\n90\n@data\n414243');
  assertEq(errors.length, 0, 'no errors');
  assertEq(regions.length, 2, 'two regions');
  assertEq(regions[0].addr, 0x1000, 'org addr');
  assertEq(regions[1].kind, 'data', 'data kind');
  assertEq(regions[1].addr, null, 'addr omitted → 顺接');
});

test('区域解析：非法标记地址报错但不影响其它行', () => {
  const { regions, errors } = HexIO.parseHexInput('@data zz\n90');
  assertEq(errors.length, 1, 'one error');
  assertEq(regions.length, 1, 'still one region');
  assertEq(hex(regions[0].bytes), '90', 'bytes kept');
});

test('formatImage：数据区带 @data 标记且可原样回解析', () => {
  const image = [
    { addr: 0x10000, bytes: Uint8Array.from([0x90, 0x90]), kind: 'code' },
    { addr: 0x200000, bytes: Uint8Array.from([0x48, 0x69]), kind: 'data' },
  ];
  const text = HexIO.formatImage(image, 16, 0x10000);
  assert(!text.includes('@code'), 'first code at base has no @code marker');
  assert(text.includes('@data 0x200000'), 'data marker emitted');
  const back = HexIO.parseHexInput(text);
  assertEq(back.errors.length, 0, 'reparse ok');
  assertEq(back.regions.length, 2, 'two regions back');
  assertEq(back.regions[0].kind, 'code', 'code kind back');
  assertEq(back.regions[1].kind, 'data', 'data kind back');
  assertEq(back.regions[1].addr, 0x200000, 'data addr back');
  assertEq(hex(back.regions[0].bytes), '9090', 'code bytes back');
  assertEq(hex(back.regions[1].bytes), '4869', 'data bytes back');
});

test('formatImage：地址不连续时补 @code 标记', () => {
  const image = [
    { addr: 0x10000, bytes: Uint8Array.from([0x90]), kind: 'code' },
    { addr: 0x30000, bytes: Uint8Array.from([0xc3]), kind: 'code' },
  ];
  const text = HexIO.formatImage(image, 16, 0x10000);
  assert(text.includes('@code 0x30000'), text);
});

test('数据伪指令：可打印用 .ascii，不可打印用 .byte', () => {
  const d1 = HexIO.bytesToDataDirectives(Uint8Array.from(Buffer.from('Hello!\n')), 16);
  assert(d1[0].startsWith('.ascii "Hello!\\n"'), 'ascii directive: ' + d1[0]);
  const d2 = HexIO.bytesToDataDirectives(Uint8Array.from([0x00, 0xff]), 16);
  assert(d2[0].startsWith('.byte 0x00, 0xff'), 'byte directive: ' + d2[0]);
});

test('源码生成：无法解码的尾部字节按数据保留', () => {
  const regions = [{
    kind: 'code', addr: 0x10000, bytes: Uint8Array.from([0x90, 0xff, 0xff]),
    insns: [{ address: 0x10000, size: 1, mnemonic: 'nop', op_str: '' }],
  }];
  const { source } = HexIO.imageToSource(regions, ARCHES.x86_64);
  assert(source.includes('.byte 0xff, 0xff'), source);
});

/* ---------- 真实引擎往返：asm → bytes → hex → disasm → source → asm ---------- */

function roundTrip(lib, csLib, archId, syntax, source) {
  const a = ARCHES[archId];
  const res = Assembler.assembleSource({ ksLib: lib, arch: a, syntax, source, base: 0x10000 });
  assert(res.ok, archId + ' 首次汇编成功: ' + JSON.stringify(res.errors));
  const cs = new csLib.Capstone(csLib[a.cs.arch], a.cs.modes.reduce((acc, n) => acc | csLib[n], 0));
  const seg = res.codeSegments[0];
  const insns = cs.disasm(seg.bytes, seg.addr).map(i => ({
    address: Number(i.address), size: Number(i.size), mnemonic: i.mnemonic, op_str: i.op_str,
  }));
  const gen = HexIO.disasmToSource(insns, a);
  const res2 = Assembler.assembleSource({ ksLib: lib, arch: a, syntax, source: gen.source, base: 0x10000 });
  assert(res2.ok, archId + ' 回程汇编成功: ' + JSON.stringify(res2.errors) + ' / ' + gen.source);
  assertEq(hex(res2.codeSegments[0].bytes), hex(seg.bytes), archId + ' 往返字节一致');
  return gen;
}

test('真实往返 x86-64：循环 + 分支标签', async () => {
  const [lib, csLib] = await Promise.all([require('@alexaltea/keystone-js')(), require('@alexaltea/capstone-js')()]);
  roundTrip(lib, csLib, 'x86_64', 'intel', 'loop:\ndec eax\njnz loop\nret');
});

test('真实往返 x86-64：call/ret 与跳转表', async () => {
  const [lib, csLib] = await Promise.all([require('@alexaltea/keystone-js')(), require('@alexaltea/capstone-js')()]);
  roundTrip(lib, csLib, 'x86_64', 'intel', 'call f\nnop\nret\nf:\nmov rbx, 7\nret');
});

test('真实往返 x86-64：条件跳转链', async () => {
  const [lib, csLib] = await Promise.all([require('@alexaltea/keystone-js')(), require('@alexaltea/capstone-js')()]);
  roundTrip(lib, csLib, 'x86_64', 'intel', 'test eax, eax\nje a\njne b\na:\nnop\nb:\nnop');
});

test('真实往返 ARM：条件分支 + 标签', async () => {
  const [lib, csLib] = await Promise.all([require('@alexaltea/keystone-js')(), require('@alexaltea/capstone-js')()]);
  roundTrip(lib, csLib, 'arm', 'intel', 'mov r0, #0\nloop:\nadd r0, r0, #1\ncmp r0, #10\nbne loop\nbx lr');
});

test('真实往返 AArch64：cbz 分支', async () => {
  const [lib, csLib] = await Promise.all([require('@alexaltea/keystone-js')(), require('@alexaltea/capstone-js')()]);
  roundTrip(lib, csLib, 'arm64', 'intel', 'mov x0, #3\nloop:\nsub x0, x0, #1\ncbnz x0, loop\nret');
});

test('真实往返 MIPS32EL：纯算术（无分支）', async () => {
  const [lib, csLib] = await Promise.all([require('@alexaltea/keystone-js')(), require('@alexaltea/capstone-js')()]);
  // 注：Keystone MIPS 对分支/跳转会自动补延迟槽 nop，带分支的往返不幂等（已知引擎怪癖），
  // 因此 MIPS 往返使用无分支序列。
  roundTrip(lib, csLib, 'mips32el', 'intel', 'addiu $v0, $zero, 5\naddiu $v1, $zero, 7\naddu $a0, $v0, $v1\nsll $a1, $a0, 2');
});

/* ---------- 真实引擎：整镜像往返（代码 + 数据分区） ---------- */

/* 用真实镜像构造区域（代码带反汇编），生成源码后重新汇编，逐字节比对 */
function fullRoundTrip(lib, csLib, archId, syntax, source) {
  const a = ARCHES[archId];
  const r1 = Assembler.assembleSource({ ksLib: lib, arch: a, syntax, source, base: 0x10000 });
  assert(r1.ok, archId + ' 首次汇编成功: ' + JSON.stringify(r1.errors));
  const cs = new csLib.Capstone(csLib[a.cs.arch], a.cs.modes.reduce((acc, n) => acc | csLib[n], 0));
  const regions = [];
  for (const seg of r1.image) {
    if (!seg.bytes.length) continue;
    const region = { kind: seg.kind, addr: seg.addr, bytes: seg.bytes, insns: null };
    if (seg.kind === 'code') {
      region.insns = cs.disasm(seg.bytes, seg.addr).map(i => ({
        address: Number(i.address), size: Number(i.size), mnemonic: i.mnemonic, op_str: i.op_str,
      }));
    }
    regions.push(region);
  }
  const gen = HexIO.imageToSource(regions, a);
  const r2 = Assembler.assembleSource({ ksLib: lib, arch: a, syntax, source: gen.source, base: 0x10000 });
  assert(r2.ok, archId + ' 整镜像回程汇编成功: ' + JSON.stringify(r2.errors) + '\n' + gen.source);

  assertEq(r2.codeSegments.length, r1.codeSegments.length, '代码段数量一致');
  for (let i = 0; i < r1.codeSegments.length; i++) {
    assertEq(hex(r2.codeSegments[i].bytes), hex(r1.codeSegments[i].bytes), '代码段 ' + i + ' 字节一致');
  }
  assertEq(r2.dataSegments.length, r1.dataSegments.length, '数据段数量一致');
  for (let i = 0; i < r1.dataSegments.length; i++) {
    assertEq(hex(r2.dataSegments[i].bytes), hex(r1.dataSegments[i].bytes), '数据段 ' + i + ' 字节一致');
    assertEq(r2.dataSegments[i].addr, r1.dataSegments[i].addr, '数据段 ' + i + ' 地址一致');
  }
  return { r1, r2, gen };
}

test('真实整镜像往返 x86-64：代码 + 字符串数据段（数据不被当指令）', async () => {
  const [lib, csLib] = await Promise.all([require('@alexaltea/keystone-js')(), require('@alexaltea/capstone-js')()]);
  const out = fullRoundTrip(lib, csLib, 'x86_64', 'intel', [
    'mov eax, 1',
    'mov edi, 1',
    'mov esi, 0x200000',
    'mov edx, MSG_LEN',
    'syscall',
    '.org 0x200000',
    'msg: .ascii "Hello, WASM!\\n"',
    '.equ MSG_LEN, . - msg',
  ].join('\n'));
  /* 生成源码里数据被写成 .ascii，且数据区不会出现在代码段里 */
  assert(out.gen.source.includes('.ascii "Hello, WASM!\\n"'), out.gen.source);
  assertEq(out.r2.totalInsns, out.r1.totalInsns, '指令数一致');
  assertEq(hex(out.r1.dataSegments[0].bytes), hex(Buffer.from('Hello, WASM!\n')), '数据内容');
});

test('真实整镜像往返 x86-64：二进制数据段用 .byte', async () => {
  const [lib, csLib] = await Promise.all([require('@alexaltea/keystone-js')(), require('@alexaltea/capstone-js')()]);
  const out = fullRoundTrip(lib, csLib, 'x86_64', 'intel', [
    'xor eax, eax',
    'ret',
    '.org 0x200000',
    '.byte 0x00, 0xff, 0x7f, 0x80',
  ].join('\n'));
  assert(out.gen.source.includes('.byte 0x00, 0xff, 0x7f, 0x80'), out.gen.source);
});

test('纯数据程序：0 条指令，数据段地址与字节正确', async () => {
  const lib = await require('@alexaltea/keystone-js')();
  const res = Assembler.assembleSource({
    ksLib: lib, arch: ARCHES.x86_64, syntax: 'intel',
    source: '.org 0x200000\n.ascii "hi"\n.byte 1, 2', base: 0x10000,
  });
  assert(res.ok, '纯数据汇编成功: ' + JSON.stringify(res.errors));
  assertEq(res.totalInsns, 0, '无指令');
  assertEq(res.codeSegments.length, 0, '无代码段');
  assertEq(res.dataSegments.length, 1, '一个数据段');
  assertEq(res.dataSegments[0].addr, 0x200000, '数据段地址');
  assertEq(hex(res.dataSegments[0].bytes), '68690102', '数据字节');
});

module.exports = { tests };
