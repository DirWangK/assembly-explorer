/* session-payload.js — 组装 Unicorn 调试会话载荷（纯逻辑，main.js 与测试共用） */
'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./arches.js'));
  } else {
    root.SessionPayload = factory(root.ArchesModule);
  }
})(typeof self !== 'undefined' ? self : this, function (Arches) {

  function regList(arch) { return Arches.regList(arch); }

  function regionsFor(arch, base) {
    if (arch.layout.single) return arch.layout.regions;
    return [
      { addr: base, size: 0x10000 },
      { addr: arch.layout.stackBase, size: arch.layout.stackSize },
      { addr: arch.layout.scratchBase, size: arch.layout.scratchSize },
    ];
  }

  /* 初始寄存器文本：`rax = 0x10` / `$v0 = 5`（每行一个，# ; @ ! 开头为注释） */
  function parseInitRegs(arch, text) {
    const regs = [], unknown = [];
    const constByName = {};
    regList(arch).forEach(([n, c]) => constByName[n.toLowerCase()] = c);
    const aliases = Object.assign({},
      ...arch.spAliases.map(x => ({ [x]: arch.spReg[1] })),
      ...arch.pcAliases.map(x => ({ [x]: arch.pc[1] })));
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line || /^[;#@!]/.test(line)) continue;
      const m = line.match(/^([A-Za-z_.$%][\w.$%]*)\s*=\s*(0[xX][0-9a-fA-F]+|\d+)$/);
      if (!m) { unknown.push(raw); continue; }
      const name = m[1].replace(/^[$%]/, '').toLowerCase();
      const val = BigInt(m[2]);
      const cnst = constByName[name] || aliases[name];
      if (cnst) regs.push([cnst, val]);
      else unknown.push(raw);
    }
    return { regs, unknown };
  }

  /* 初始内存文本：`0x200000 = "hi"` 或 `0x200010 = 41 42`（每行一个） */
  function parseInitMem(text) {
    const out = [], unknown = [];
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line || /^[;#@!]/.test(line)) continue;
      const m = line.match(/^(0[xX][0-9a-fA-F]+|\d+)\s*=\s*(.+)$/);
      if (!m) { unknown.push(raw); continue; }
      const addr = Number(BigInt(m[1]));
      let bytes = null;
      const q = m[2].match(/^"((?:[^"\\]|\\.)*)"$/);
      if (q) {
        bytes = [];
        const body = q[1];
        for (let i = 0; i < body.length; i++) {
          const c = body[i];
          if (c !== '\\') { bytes.push(body.charCodeAt(i)); continue; }
          const n = body[i + 1];
          if (n === 'n') bytes.push(10);
          else if (n === 't') bytes.push(9);
          else if (n === '"') bytes.push(34);
          else if (n === '\\') bytes.push(92);
          else bytes.push(n.charCodeAt(0));
          i++;
        }
      } else {
        let hexs = m[2].replace(/\s+/g, '').replace(/^0x/, '');
        if (!/^[0-9a-fA-F]*$/.test(hexs) || hexs.length % 2) { unknown.push(raw); continue; }
        bytes = [];
        for (let i = 0; i < hexs.length; i += 2) bytes.push(parseInt(hexs.slice(i, i + 2), 16));
      }
      out.push({ addr, bytes });
    }
    return { mems: out, unknown };
  }

  /*
   * args: { arch, base, res(汇编结果), initRegs(text), initMem(text), maxCount }
   * 返回: { payload, warnings: { regs:[], mem:[] } }
   */
  function buildSessionPayload(args) {
    const { arch, base, res, initRegs, initMem, maxCount } = args;
    const u = parseInitRegs(arch, initRegs);
    const m = parseInitMem(initMem);

    const regs = [];
    if (arch.layout.spInit !== undefined) regs.push([arch.spReg[1], arch.layout.spInit]);
    for (const [c, v] of u.regs) regs.push([c, v]);

    const widths = {};
    for (const [, c] of regList(arch)) widths[c] = arch.width;
    if (arch.flags) widths[arch.flags[1]] = (arch.id === 'x86_64') ? 8 : 4;

    const untilAddr = Math.max(res.untilAddr, res.startAddr + 1);
    const payload = {
      archId: arch.id,
      base,
      regions: regionsFor(arch, base),
      memInit: m.mems,
      regs,
      regWidths: widths,
      watch: regList(arch),
      pcReg: arch.pc,
      thumb: !!arch.thumb,
      maxCount: maxCount || 200000,
      traceCap: 20000,
      memCap: 4000,
      syscall: arch.syscall,
      ucArchName: arch.uc.arch,
      ucModeNames: arch.uc.modes,
      image: res.image.map(s => ({ addr: s.addr, bytes: Array.from(s.bytes) })),
      startAddr: res.startAddr,
      untilAddr,
    };
    return { payload, warnings: { regs: u.unknown, mem: m.unknown } };
  }

  return { regionsFor, parseInitRegs, parseInitMem, buildSessionPayload };
});
