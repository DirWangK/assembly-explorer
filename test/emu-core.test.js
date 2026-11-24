/* test/emu-core.test.js — Unicorn 调试核心（真实引擎，全架构 golden 值 + 调试行为） */
'use strict';

const H = require('./helper.js');
const { test, tests } = H.createSuite();
const { assert, assertEq } = H;
const EmuCore = require('../js/core/emu-core.js');
const Assembler = require('../js/core/assembler.js');
const SessionPayload = require('../js/core/session-payload.js');
const { ARCHES } = require('../js/core/arches.js');

const MKeystone = require('@alexaltea/keystone-js');
const MCapstone = require('@alexaltea/capstone-js');
const ucLoaders = {
  x86: require('@alexaltea/unicorn-js/x86'),
  arm: require('@alexaltea/unicorn-js/arm'),
  aarch64: require('@alexaltea/unicorn-js/aarch64'),
  mips: require('@alexaltea/unicorn-js/mips'),
  ppc: require('@alexaltea/unicorn-js/ppc'),
  sparc: require('@alexaltea/unicorn-js/sparc'),
};

let ksLib = null;
const ucCache = {};

async function getUc(file) {
  if (!ucCache[file]) ucCache[file] = await ucLoaders[file]();
  return ucCache[file];
}

/* 建会话（基于示例源码），返回 session 与 res */
async function makeSession(archId, opts) {
  if (!ksLib) ksLib = await MKeystone();
  const a = ARCHES[archId];
  const base = a.layout.single ? 0 : (opts && opts.base) || 0x10000;
  const source = (opts && opts.source) || a.example;
  const res = Assembler.assembleSource({ ksLib, arch: a, syntax: opts && opts.syntax || 'intel', source, base });
  assert(res.ok, archId + ' 示例应汇编成功: ' + JSON.stringify(res.errors));
  const { payload } = SessionPayload.buildSessionPayload({
    arch: a, base, res,
    initRegs: (opts && opts.initRegs) || '',
    initMem: (opts && opts.initMem) || '',
    maxCount: (opts && opts.maxCount) || 200000,
  });
  const uc = await getUc(a.uc.file);
  const session = EmuCore.createSession(uc, payload);
  session._archId = archId;
  session._uc = uc;
  session._watch = payload.watch;
  session._widths = payload.regWidths;
  return { session, res, payload, uc };
}

function regFromMeta(meta, watchList, name) {
  return BigInt(meta.regs[name] || '0');
}

/* ---------- 全架构 golden 值 ---------- */

const GOLDEN = [
  { id: 'x86_64', expect: { RAX: 60n }, reasonType: 'exit', exitCode: 0, console: 'Hello, WASM!\n' },
  { id: 'x86_32', expect: { EAX: 1n }, reasonType: 'exit', exitCode: 0, console: 'Hello, WASM!\n' },
  { id: 'x86_16', expect: { AX: 0x1236n }, reasonType: 'ended' },
  { id: 'arm', expect: { R0: 55n, R3: 55n }, reasonType: 'ended' },
  { id: 'thumb', expect: { R0: 36n }, reasonType: 'ended' },
  { id: 'arm64', expect: { X2: 700n, X4: 700n }, reasonType: 'ended' },
  { id: 'mips32el', expect: { }, reasonType: 'exit', exitCode: 0, console: 'Hello, MIPS!\n' },
  { id: 'mips32be', expect: { }, reasonType: 'exit', exitCode: 0, console: 'Hello, MIPS!\n' },
  { id: 'mips64el', expect: { A0: 12n, A1: 96n }, reasonType: 'ended' },
  { id: 'ppc32be', expect: { R5: 12n, R6: 35n }, reasonType: 'ended' },
  { id: 'sparc32be', expect: { O2: 12n }, reasonType: 'ended' },
];

for (const g of GOLDEN) {
  test('golden：' + g.id + ' 示例执行结果', async () => {
    const { session } = await makeSession(g.id);
    assertEq(session.state, 'paused', 'init state paused');
    const meta = await session.resume({ chunk: 2000, breakpoints: [] });
    assertEq(meta.state, 'ended', 'ended');
    assertEq(meta.reason.type, g.reasonType, 'reason type');
    if ('exitCode' in g) assertEq(meta.reason.code, g.exitCode, 'exit code');
    for (const [reg, val] of Object.entries(g.expect)) {
      assertEq(BigInt(meta.regs[reg]), val, g.id + ' ' + reg);
    }
    if (g.console) {
      const rep = session.report({ trace: 0, mem: 0, consoleBytes: 0 });
      assertEq(rep.console, g.console, g.id + ' console');
    }
    assert(meta.instrs > 0, 'instructions executed');
    session.end();
  });
}

/* ---------- 调试器行为 ---------- */

test('会话初始化：PC 寄存器指向代码起点（停止态寄存器显示一致）', async () => {
  const { session, res } = await makeSession('x86_64');
  const meta = session.snapshotMeta();
  assertEq(meta.state, 'paused', 'init paused');
  assertEq(meta.pc, res.startAddr, 'meta.pc = startAddr');
  assertEq(BigInt(meta.regs.RIP), BigInt(res.startAddr), 'RIP register = startAddr');
  session.end();
});

test('步入：单步推进 PC 与轨迹计数', async () => {
  const { session, res } = await makeSession('x86_64');
  const startPc = session.pc;
  assertEq(startPc, 0x10000, 'pc at _start');
  const m1 = session.step(1);
  assertEq(m1.state, 'paused', 'paused after step');
  assertEq(m1.instrs, 1, '1 instruction');
  assert(m1.pc > startPc, 'pc advanced');
  assertEq(session.trace.length, 1, 'trace has 1 entry');
  const m2 = session.step(3);
  assertEq(m2.instrs, 4, '4 total');
  assertEq(session.trace.length, 4, 'trace 4');
  session.end();
  void res;
});

test('步过：call 目标被执行，PC 停在返回地址', async () => {
  const src = [
    '_start:',
    '    call fn',
    '    mov rax, 1',
    '    ret',
    'fn:',
    '    mov rbx, 7',
    '    ret',
  ].join('\n');
  const { session } = await makeSession('x86_64', { source: src });
  // 第一条即 call（5 字节 e8 rel32）
  const callAddr = session.pc;
  const until = callAddr + 5;
  const meta = session.step(200000, until); // 步过 = 运行到返回地址
  assertEq(meta.state, 'paused', 'paused at return addr');
  assertEq(meta.pc, until, 'pc = call + 5');
  assertEq(BigInt(meta.regs.RBX), 7n, 'callee executed (RBX=7)');
  session.end();
});

test('断点：命中后暂停在断点处', async () => {
  const { session, res } = await makeSession('x86_64');
  // 在第二个 syscall（exit）处设断点：找 trace 不可用，直接用 untilAddr 附近的最后一条
  // 简单可靠：在 0x10000 + 0x1c（第二条 syscall）附近不好算 —— 改为在"mov rax, SYS_EXIT"后的 syscall 处
  // 用反汇编找：所有指令地址中，最后一条
  const seg = res.codeSegments[0];
  const lastInsnAddr = seg.addr + seg.bytes.length - 2; // syscall 2 字节
  session.setBreakpoints([lastInsnAddr]);
  const meta = await session.resume({ chunk: 2000 });
  assertEq(meta.state, 'paused', 'paused at bp');
  assertEq(meta.reason.type, 'bp', 'bp reason');
  assertEq(meta.pc, lastInsnAddr, 'pc at breakpoint');
  // 继续运行 → exit syscall 停机
  const m2 = await session.resume({ chunk: 2000 });
  assertEq(m2.state, 'ended', 'ended after bp');
  assertEq(m2.reason.type, 'exit', 'exit reason');
  session.end();
});

test('暂停：无限循环中请求暂停，块边界生效', async () => {
  const { session } = await makeSession('x86_64', { source: '_start:\n    jmp _start', maxCount: 10000000 });
  const p = session.resume({ chunk: 100 });
  setTimeout(() => session.pause(), 10);
  const meta = await p;
  assertEq(meta.state, 'paused', 'paused');
  assertEq(meta.reason.type, 'paused', 'pause reason');
  assert(meta.instrs > 0, 'some instructions executed');
  session.end();
});

test('致命错误：未映射内存 → 会话终止，新会话可继续', async () => {
  const { session } = await makeSession('x86_64', { source: '_start:\n    mov rax, [0x500000]' });
  const meta = await session.resume({ chunk: 100 });
  // 该 wasm 构建对未映射访问的行为：要么 wasm 陷阱（error/fatal），要么返回错误码（ended/error）
  assert(['error', 'ended'].includes(meta.state), 'session terminated, got ' + meta.state);
  assert(['fatal', 'error'].includes(meta.reason.type), 'fatal/error reason, got ' + JSON.stringify(meta.reason));
  session.end();
  // 模块可复用：新会话正常
  const { session: s2 } = await makeSession('x86_64', { source: '_start:\n    mov eax, 42' });
  const m2 = s2.step(1);
  assertEq(BigInt(m2.regs.RAX), 42n, 'new session works');
  s2.end();
});

test('Thumb 调试：步进在 Thumb 模式下保持（R0 逐步累加）', async () => {
  const { session } = await makeSession('thumb');
  const m1 = session.step(1); // movs r0,#6
  assertEq(BigInt(m1.regs.R0), 6n, 'R0 = 6');
  const m2 = session.step(1); // adds r0,#3
  assertEq(BigInt(m2.regs.R0), 9n, 'R0 = 9');
  const m3 = session.step(1); // lsls r0,#2
  assertEq(BigInt(m3.regs.R0), 36n, 'R0 = 36');
  assertEq(m3.state, 'ended', 'ended at code end');
  session.end();
});

test('控制台字节流跨块解码（长字符串 write）', async () => {
  const { session } = await makeSession('x86_64', {
    source: '_start:\n    mov rsi, MSG\n    mov rdx, MSG_LEN\n    mov rax, 1\n    syscall\n    mov rax, 60\n    xor rdi, rdi\n    syscall\n.org 0x200000\nMSG: .ascii "你好，Unicorn 调试器！"\n.equ MSG_LEN, . - MSG',
  });
  const meta = await session.resume({ chunk: 2 });
  assertEq(meta.reason.type, 'exit', 'exited');
  const rep = session.report({ trace: 0, mem: 0, consoleBytes: 0 });
  assertEq(rep.console, '你好，Unicorn 调试器！', 'utf8 decoded');
  session.end();
});

test('内存写入日志（str 指令产生 W 记录）', async () => {
  const { session } = await makeSession('arm');
  const meta = await session.resume({ chunk: 2000 });
  assertEq(meta.state, 'ended', 'ended');
  const rep = session.report({ trace: 0, mem: 0, consoleBytes: 0 });
  const writes = rep.memops.filter(m => m[0] === 'W');
  assert(writes.length >= 1, 'at least one write');
  assertEq(writes[0][1], 0x200000, 'write at RESULT');
  session.end();
});

test('maxCount 指令上限触发 count-limit', async () => {
  const { session } = await makeSession('x86_64', { source: '_start:\n    jmp _start', maxCount: 500 });
  const meta = await session.resume({ chunk: 100 });
  assertEq(meta.state, 'ended', 'ended by cap');
  assertEq(meta.reason.type, 'count-limit', 'count-limit reason');
  session.end();
});

test('一次性 run 流程等价：init+resume+end（x86-64 golden 再验证）', async () => {
  const { session } = await makeSession('x86_64');
  const meta = await session.resume({ chunk: 2000, breakpoints: [] });
  assertEq(meta.reason.type, 'exit');
  assertEq(BigInt(meta.regs.RAX), 60n, 'RAX = 60 (SYS_exit)');
  session.end();
});
module.exports = { tests };
