/* emu-core.js — Unicorn 调试会话核心（纯逻辑，Worker 与 Node 测试共用）
 *
 * 会话生命周期：
 *   createSession(uc, payload)  建 emu、映射内存、写入镜像与初始寄存器、挂 Hook
 *   session.step(n, until)      步入 n 条（until 可实现"步过到返回地址"）
 *   session.resume(opts)        分块连续运行（可在块间响应暂停请求、断点）
 *   session.pause()             请求暂停（下一个块边界生效）
 *   session.end()               关闭引擎
 *
 * Hook 语义：
 *   - HOOK_CODE：指令轨迹、执行计数、断点命中（命中时 emu_stop，PC 停在断点处）
 *   - HOOK_MEM_WRITE / HOOK_MEM_READ：内存访问日志（带上限）
 *   - syscall/int 0x80/svc：控制台输出与 exit（按架构 ABI）
 *
 * 错误分三层：
 *   - 未映射内存：HOOK_MEM_UNMAPPED 在故障指令处捕获并 emu_stop（不触发 wasm
 *     陷阱）。会话进入 'paused' + reason.type='mem-fault'，引擎保持可用；
 *     调用 mapMemory()/writeMemory() 补齐内存后可从当前 PC 继续执行。
 *   - wasm RuntimeError（钩子未覆盖的极端情况）：会话状态 'error'，引擎句柄
 *     作废；模块本身仍可用，下一次 createSession 建新句柄即可。
 *   - uc 错误码（无效指令等）：会话 'ended'，引擎仍可用，errno 可回读。
 */
'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.EmuCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const PAGE = 0x1000;

  function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function hexAddr(n) { return '0x' + (n >>> 0).toString(16); }

  function createSession(uc, payload) {
    const mode = (payload.ucModeNames || []).reduce((acc, n) => acc | uc[n], 0);
    const emu = new uc.Unicorn(uc[payload.ucArchName], mode);

    const s = {
      state: 'paused',          // paused | running | ended | error | idle
      pc: (payload.startAddr | 0) >>> 0,
      reason: { type: 'init' },
      resumePc: -1,             // 恢复/单步起始地址（当前 PC 处的断点不重复命中）
      trace: [],                // [addr, size][]
      memops: [],               // ['W'|'R', addr, size, valueStr][]
      consoleBytes: [],
      instrs: 0,
      ms: 0,
      breakpoints: new Set(),
      pauseRequested: false,
      stopReason: null,         // hook 置位
      memFault: null,           // 未映射内存访问 {addr,size,access}
      errObj: null,
      _decoder: null,
    };

    /* ---------- 内存映射：按页补齐，已映射页自动跳过（幂等） ---------- */
    const covered = [];
    function coveredFully(a, b) {
      return covered.some(([x, y]) => a >= x && b <= y);
    }
    function mapSpan(a, b) {
      const start = Math.floor(a / PAGE) * PAGE;
      let end = Math.ceil(b / PAGE) * PAGE;
      if (end <= start) end = start + PAGE;
      function mapRun(s, e) {
        try {
          emu.mem_map(s, e - s, uc.PROT_ALL);
          covered.push([s, e]);
        } catch (err) {
          /* 引擎内部已映射（跨页重叠等）：逐页补齐并记录为可用 */
          for (let p = s; p < e; p += PAGE) {
            try { emu.mem_map(p, PAGE, uc.PROT_ALL); } catch (e2) { /* 已映射 */ }
            covered.push([p, p + PAGE]);
          }
        }
      }
      let runStart = null;
      for (let p = start; p < end; p += PAGE) {
        const hit = covered.some(([x, y]) => p >= x && p < y);
        if (hit) {
          if (runStart !== null) { mapRun(runStart, p); runStart = null; }
        } else if (runStart === null) {
          runStart = p;
        }
      }
      if (runStart !== null) mapRun(runStart, end);
      return { start, end };
    }
    for (const r of payload.regions || []) mapSpan(r.addr, r.addr + r.size);
    const images = (payload.image || []).filter(sg => sg.bytes && sg.bytes.length);
    for (const sg of images) {
      if (!coveredFully(sg.addr, sg.addr + sg.bytes.length)) mapSpan(sg.addr, sg.addr + sg.bytes.length);
    }

    /* ---------- 写入镜像与运行时内存（数据目标页按需补齐） ---------- */
    for (const sg of images) emu.mem_write(sg.addr, sg.bytes);
    for (const m of payload.memInit || []) {
      if (!coveredFully(m.addr, m.addr + m.bytes.length)) mapSpan(m.addr, m.addr + m.bytes.length);
      emu.mem_write(m.addr, m.bytes);
    }

    /* ---------- 初始寄存器 ---------- */
    for (const [cnst, val] of payload.regs || []) {
      const w = (payload.regWidths && payload.regWidths[cnst]) || 8;
      if (w >= 8) emu.reg_write_i64(uc[cnst], BigInt(val));
      else if (w === 2) emu.reg_write_i16(uc[cnst], Number(BigInt(val)) & 0xFFFF);
      else emu.reg_write_i32(uc[cnst], Number(BigInt(val) & 0xFFFFFFFFn));
    }

    /* ---------- 初始 PC ---------- */
    /* 引擎初始 PC 为 0，与"停在代码起点"的语义不一致（寄存器面板/断点会看到 0）。
     * 这里显式写入 startAddr；emu_start 仍以传入地址为准。 */
    try { regWrite(payload.pcReg[1], payload.startAddr); } catch (e) { /* 个别构建只读 PC */ }

    /* ---------- 工具 ---------- */
    function regRead(cnst) {
      const w = (payload.regWidths && payload.regWidths[cnst]) || 8;
      if (w >= 8) return emu.reg_read_i64(uc[cnst]);
      if (w === 2) return BigInt(emu.reg_read_i16(uc[cnst]) & 0xFFFF);
      return BigInt(emu.reg_read_i32(uc[cnst]) >>> 0);
    }
    function regWrite(cnst, val) {
      const w = (payload.regWidths && payload.regWidths[cnst]) || 8;
      if (w >= 8) emu.reg_write_i64(uc[cnst], BigInt(val));
      else if (w === 2) emu.reg_write_i16(uc[cnst], Number(BigInt(val)) & 0xFFFF);
      else emu.reg_write_i32(uc[cnst], Number(BigInt(val) & 0xFFFFFFFFn));
    }
    function readPc() {
      const [, cnst] = payload.pcReg;
      let v = Number(regRead(cnst));
      if (payload.thumb) v &= ~1;
      return v >>> 0;
    }
    function errnoText(code) {
      if (!code) return null;
      for (const k of Object.keys(uc)) {
        if (/^ERR_/.test(k) && k !== 'ERR_ENDING' && uc[k] === code) return k;
      }
      return 'ERR_' + code;
    }

    function doWrite(bufAddr, len) {
      len = Math.max(0, Math.min(len | 0, 8192));
      try {
        const bytes = emu.mem_read(bufAddr, len || 1).slice(0, len);
        for (const b of bytes) s.consoleBytes.push(b);
        return len;
      } catch (e) {
        s.consoleBytes.push(...('<<write: 地址 ' + hexAddr(bufAddr) + ' 不可读>>').split('').map(c => c.charCodeAt(0)));
        return 0;
      }
    }

    /* ---------- Hook：syscall / int / svc ---------- */
    function tryHook(label, fn) { try { fn(); return true; } catch (e) { return false; } }

    /* 未映射内存：在故障指令处安全暂停（emu_stop），不让 wasm 陷阱污染引擎。
     * type 为枚举值（非位掩码）：19/20/21 = 读/写/取指未映射。 */
    const MEM_WRITE_UNMAPPED = uc.MEM_WRITE_UNMAPPED !== undefined ? uc.MEM_WRITE_UNMAPPED : 20;
    const MEM_FETCH_UNMAPPED = uc.MEM_FETCH_UNMAPPED !== undefined ? uc.MEM_FETCH_UNMAPPED : 21;
    const MEM_WRITE_PROT = uc.MEM_WRITE_PROT !== undefined ? uc.MEM_WRITE_PROT : 22;
    const MEM_FETCH_PROT = uc.MEM_FETCH_PROT !== undefined ? uc.MEM_FETCH_PROT : 24;
    tryHook('HOOK_MEM_UNMAPPED', () =>
      emu.hook_add(uc.HOOK_MEM_UNMAPPED, (e, type, addr, size) => {
        if (!s.memFault) {
          const access = (type === MEM_FETCH_UNMAPPED || type === MEM_FETCH_PROT) ? 'x'
            : (type === MEM_WRITE_UNMAPPED || type === MEM_WRITE_PROT) ? 'w' : 'r';
          s.memFault = { addr: Number(addr), size: Math.max(1, Number(size) || 1), access };
        }
        e.emu_stop();
        return true;
      }, 1, 1, 0));

    tryHook('HOOK_CODE', () =>
      emu.hook_add(uc.HOOK_CODE, (e, addr, size) => {
        if (s.trace.length >= payload.traceCap) {
          if (!s.stopReason) s.stopReason = { type: 'trace-limit' };
          e.emu_stop(); return;
        }
        s.trace.push([Number(addr), size]);
        s.instrs++;
        if (s.breakpoints.size && s.breakpoints.has(Number(addr)) && Number(addr) !== s.resumePc) {
          s.stopReason = { type: 'bp', addr: Number(addr) };
          e.emu_stop(); return;
        }
        if (payload.maxCount && s.instrs >= payload.maxCount) {
          s.stopReason = { type: 'count-limit' };
          e.emu_stop();
        }
      }, 1, 1, 0));

    tryHook('HOOK_MEM_WRITE', () =>
      emu.hook_add(uc.HOOK_MEM_WRITE, (e, type, addr, size, value) => {
        if (s.memops.length >= payload.memCap) return;
        s.memops.push(['W', Number(addr), size, value.toString()]);
      }, 1, 1, 0));

    tryHook('HOOK_MEM_READ', () =>
      emu.hook_add(uc.HOOK_MEM_READ, (e, type, addr, size) => {
        if (s.memops.length >= payload.memCap) return;
        s.memops.push(['R', Number(addr), size, '']);
      }, 1, 1, 0));

    /* 架构 syscall ABI（控制台 + exit） */
    const abi = payload.syscall;
    if (abi === 'x86_64') {
      tryHook('SYSCALL', () =>
        emu.hook_add(uc.HOOK_INSN, (e) => {
          const rax = e.reg_read_i64(uc.X86_REG_RAX);
          if (rax === 1n) {
            const n = doWrite(Number(e.reg_read_i64(uc.X86_REG_RSI)), Number(e.reg_read_i64(uc.X86_REG_RDX)));
            e.reg_write_i64(uc.X86_REG_RAX, BigInt(n));
          } else if (rax === 60n) {
            s.stopReason = { type: 'exit', code: Number(e.reg_read_i64(uc.X86_REG_RDI)) };
            e.emu_stop();
          } else {
            s.consoleBytes.push(...('[syscall rax=' + rax + ']').split('').map(c => c.charCodeAt(0)));
          }
        }, 1, 1, 0, uc.X86_INS_SYSCALL));
    } else if (abi === 'x86_32') {
      tryHook('INT80', () =>
        emu.hook_add(uc.HOOK_INTR, (e, intno) => {
          if (Number(intno) !== 0x80) return;
          const eax = e.reg_read_i32(uc.X86_REG_EAX);
          if (eax === 4) {
            const n = doWrite(e.reg_read_i32(uc.X86_REG_ECX), e.reg_read_i32(uc.X86_REG_EDX));
            e.reg_write_i32(uc.X86_REG_EAX, n);
          } else if (eax === 1) {
            s.stopReason = { type: 'exit', code: e.reg_read_i32(uc.X86_REG_EBX) };
            e.emu_stop();
          } else {
            s.consoleBytes.push(...('[int 0x80 eax=' + eax + ']').split('').map(c => c.charCodeAt(0)));
          }
        }, 1, 1, 0));
    } else if (abi === 'arm') {
      tryHook('SVC', () =>
        emu.hook_add(uc.HOOK_INTR, (e, intno) => {
          if (Number(intno) !== 2) return;
          const r7 = e.reg_read_i32(uc.ARM_REG_R7);
          if (r7 === 4) {
            const n = doWrite(e.reg_read_i32(uc.ARM_REG_R1), e.reg_read_i32(uc.ARM_REG_R2));
            e.reg_write_i32(uc.ARM_REG_R0, n);
          } else if (r7 === 1) {
            s.stopReason = { type: 'exit', code: e.reg_read_i32(uc.ARM_REG_R0) };
            e.emu_stop();
          } else {
            s.consoleBytes.push(...('[svc r7=' + r7 + ']').split('').map(c => c.charCodeAt(0)));
          }
        }, 1, 1, 0));
    } else if (abi === 'arm64') {
      tryHook('SVC64', () =>
        emu.hook_add(uc.HOOK_INTR, (e, intno) => {
          if (Number(intno) !== 2) return;
          const x8 = e.reg_read_i64(uc.ARM64_REG_X8);
          if (x8 === 64n) {
            const n = doWrite(Number(e.reg_read_i64(uc.ARM64_REG_X1)), Number(e.reg_read_i64(uc.ARM64_REG_X2)));
            e.reg_write_i64(uc.ARM64_REG_X0, BigInt(n));
          } else if (x8 === 93n) {
            s.stopReason = { type: 'exit', code: Number(e.reg_read_i64(uc.ARM64_REG_X0)) };
            e.emu_stop();
          } else {
            s.consoleBytes.push(...('[svc x8=' + x8 + ']').split('').map(c => c.charCodeAt(0)));
          }
        }, 1, 1, 0));
    } else if (abi === 'mips') {
      tryHook('MIPSSYS', () =>
        emu.hook_add(uc.HOOK_INTR, (e) => {
          const v0 = e.reg_read_i32(uc.MIPS_REG_V0);
          if (v0 === 4 || v0 === 4004) {
            const n = doWrite(e.reg_read_i32(uc.MIPS_REG_A1), e.reg_read_i32(uc.MIPS_REG_A2));
            e.reg_write_i32(uc.MIPS_REG_V0, n);
            e.reg_write_i32(uc.MIPS_REG_A3, 0);
          } else if (v0 === 1 || v0 === 4001) {
            s.stopReason = { type: 'exit', code: e.reg_read_i32(uc.MIPS_REG_A0) };
            e.emu_stop();
          }
        }, 1, 1, 0));
    }

    /* ---------- 运行原语 ---------- */
    const CODE_START = payload.startAddr | 0;
    const CODE_END = payload.untilAddr | 0;
    function inCode(pc) { return pc >= CODE_START && pc < CODE_END; }
    /* 跳出原代码区（如 mapped-code 取指）后，原 until 位于当前 PC 之前，
     * Unicorn 会异常；改为给一个前向窗口，靠 count/stopReason 收敛。 */
    function untilFor(pc) {
      if (pc < CODE_END) return CODE_END;
      const t = pc + 0x100000;
      return t <= 0xFFFFFFFF ? t : 0xFFFFFFFF;
    }

    // 返回 {fatal:bool, err} 或 null；s.instrs 由 hook 递增，可计算块内执行数
    function runChunk(begin, until, count) {
      try {
        const t0 = Date.now();
        s.stopReason = null;
        s.memFault = null;
        emu.emu_start(payload.thumb ? ((begin | 1) >>> 0) : begin, until, 0, count);
        s.ms += Date.now() - t0;
        return null;
      } catch (err) {
        if (err instanceof WebAssembly.RuntimeError) return { fatal: true, err };
        return { fatal: false, err };
      }
    }

    /* 结束判定（与架构无关）：
     *  - hook 置位的 stopReason（bp/exit/上限）优先；
     *  - emu_start 以 OK 返回且块内执行数 < count → 到达 until（正常结束）；
     *    （不同架构的 PC 读数语义不同：MIPS 停在当前指令、x86 停在下一条，
     *     因此不能依赖 PC >= until 判断）
     *  - count 用尽且未到 until → 分块继续（paused）。 */
    function finishRun(runErr, executed, countWanted, untilOverride, begin) {
      if (runErr && runErr.fatal) {
        s.state = 'error';
        s.reason = { type: 'fatal', message: String(runErr.err && runErr.err.message || runErr.err) };
        try { emu.close(); } catch (e) { /* 引擎句柄已污染 */ }
        return false;
      }
      /* 未映射内存：引擎安全暂停，等待宿主补齐内存后原地继续 */
      if (s.memFault) {
        const f = s.memFault;
        s.memFault = null;
        s.pc = readPc();
        s.state = 'paused';
        s.reason = { type: 'mem-fault', addr: f.addr, size: f.size, access: f.access };
        return true;
      }
      s.pc = readPc();
      if (s.stopReason) {
        const r = s.stopReason;
        s.stopReason = null;
        if (r.type === 'exit' || r.type === 'trace-limit' || r.type === 'count-limit') {
          s.state = 'ended';
          s.reason = r;
        } else {
          s.state = 'paused';
          s.reason = r;
        }
        return true;
      }
      if (runErr) {
        const errno = emu.errno();
        s.state = 'ended';
        s.reason = { type: 'error', errno, errnoText: errnoText(errno) };
        return false;
      }
      /* 步过（untilOverride）：到达返回地址即暂停，而非结束 */
      if (untilOverride !== null && untilOverride !== undefined && s.pc >= untilOverride) {
        s.state = 'paused';
        s.reason = { type: 'paused' };
        return true;
      }
      if (executed < countWanted || (inCode(begin) && s.pc >= CODE_END)) {
        s.state = 'ended';
        s.reason = { type: 'ended' };
        return false;
      }
      s.state = 'paused';
      s.reason = { type: 'paused' };
      return true;
    }

    /* ---------- 公开 API ---------- */
    s.step = function (n, until) {
      if (s.state !== 'paused') return { state: s.state, reason: s.reason };
      const begin = s.pc;
      s.resumePc = begin;
      const count = n || 1;
      const override = (until !== undefined && until !== (payload.untilAddr | 0)) ? until : null;
      const before = s.instrs;
      const runErr = runChunk(begin, until || untilFor(begin), count);
      finishRun(runErr, s.instrs - before, count, override, begin);
      return s.snapshotMeta();
    };

    s.resume = async function (opts) {
      const chunk = (opts && opts.chunk) || 500;
      const maxChunks = Math.max(1, Math.ceil((payload.maxCount || 100000) / chunk) + 1);
      if (opts && opts.breakpoints) s.breakpoints = new Set(opts.breakpoints.map(Number));
      s.pauseRequested = false;
      if (s.state === 'paused') s.reason = { type: 'paused' };
      if (s.state !== 'paused') return s.snapshotMeta();
      s.state = 'running';
      s.resumePc = s.pc;
      let chunks = 0;
      while (s.state === 'running') {
        const begin = s.pc;
        const before = s.instrs;
        const runErr = runChunk(begin, untilFor(begin), chunk);
        const executed = s.instrs - before;
        if (runErr || s.stopReason) {
          finishRun(runErr, executed, chunk, null, begin);
          break;
        }
        if (s.pauseRequested) {
          s.pc = readPc();
          s.state = 'paused';
          s.reason = { type: 'paused' };
          break;
        }
        if (executed < chunk || (inCode(begin) && s.pc >= CODE_END)) {
          s.pc = readPc();
          s.state = 'ended';
          s.reason = { type: 'ended' };
          break;
        }
        s.pc = readPc(); // 块间推进 PC（下一块从这里继续）
        chunks++;
        if (chunks > maxChunks) {
          s.state = 'ended';
          s.reason = { type: 'count-limit' };
          break;
        }
        await yieldToEventLoop(); // 让 pause 消息进入
      }
      return s.snapshotMeta();
    };

    s.pause = function () { s.pauseRequested = true; };

    s.setBreakpoints = function (list) { s.breakpoints = new Set((list || []).map(Number)); };

    /* 内存补齐（弹窗/手动映射共用）：已映射页自动跳过，返回实际页对齐范围 */
    s.mapMemory = function (addr, size) {
      const a = Math.max(0, Math.floor(Number(addr) || 0));
      const n = Math.max(1, Math.floor(Number(size) || PAGE));
      return mapSpan(a, a + n);
    };

    s.writeMemory = function (addr, bytes) {
      try {
        const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
        if (!u8.length) return 0;
        emu.mem_write(Math.max(0, Math.floor(Number(addr) || 0)), u8);
        return u8.length;
      } catch (e) {
        return 0;
      }
    };

    s.readMemory = function (addr, size) {
      try {
        const n = Math.max(1, Math.floor(Number(size) || 1));
        return Array.from(emu.mem_read(Math.max(0, Math.floor(Number(addr) || 0)), n));
      } catch (e) {
        return null;
      }
    };

    /* 已映射区域（合并相邻页，供 UI 展示） */
    s.regions = function () {
      const sorted = covered.slice().sort((x, y) => x[0] - y[0]);
      const out = [];
      for (const [a, b] of sorted) {
        const last = out[out.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
      }
      return out;
    };

    s.end = function () {
      if (s.state !== 'error') { try { emu.close(); } catch (e) { /* 已污染 */ } }
      s.state = 'idle';
    };

    s.snapshotMeta = function () {
      const regs = {};
      for (const [name, cnst] of payload.watch || []) {
        try { regs[name] = regRead(cnst).toString(); }
        catch (e) { regs[name] = '0'; }
      }
      return {
        state: s.state,
        pc: s.pc,
        reason: s.reason,
        regs,
        instrs: s.instrs,
        ms: s.ms,
      };
    };

    s.report = function (repIdx) {
      const out = {
        trace: s.trace.slice(repIdx.trace),
        memops: s.memops.slice(repIdx.mem),
        console: null,
      };
      const pending = s.consoleBytes.slice(repIdx.consoleBytes);
      if (pending.length) {
        if (!s._decoder) s._decoder = new TextDecoder('utf-8');
        try { out.console = s._decoder.decode(new Uint8Array(pending), { stream: true }); }
        catch (e) { out.console = ''; }
      } else out.console = '';
      repIdx.trace = s.trace.length;
      repIdx.mem = s.memops.length;
      repIdx.consoleBytes = s.consoleBytes.length;
      return out;
    };

    /* pc 从 readPc 起不可靠（引擎初始 PC=0），保留 startAddr；
     * 只有 emu_start 之后才用 readPc 回读。 */
    return s;
  }

  return { createSession, PAGE };
});
