/* i18n.js — 轻量国际化（zh-CN / en），浏览器与 Node 测试共用 */
'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.I18N = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const dict = {
    zh: {
      'app.title': 'Assembly Explorer',
      'app.subtitle': '汇编 ⇄ 机器码 ⇄ 执行 · Keystone · Capstone · Unicorn 全 WASM',
      'ctl.arch': '架构',
      'ctl.syntax': '语法',
      'ctl.base': '基址',
      'ctl.theme': '主题',
      'theme.dark': '深色',
      'theme.light': '浅色',
      'theme.system': '跟随系统',
      'lang.zh': '中文',
      'lang.en': 'EN',
      'btn.share': '分享',
      'btn.shareDone': '链接已复制到剪贴板',
      'btn.shareFallback': '链接已写入地址栏',
      'btn.loadExample': '载入示例',
      'btn.run': '运行',
      'btn.pause': '暂停',
      'btn.stepOver': '步过',
      'btn.stepIn': '步入',
      'btn.stop': '停止',
      'btn.autoRun': '自动运行',
      'pane1.tag': '① Keystone · 汇编器',
      'pane1.title': '源码 / 机器码',
      'pane2.tag': '② Capstone · 反汇编',
      'pane2.title': '机器码 & 回环解码',
      'pane2.hexdump': '机器码（Keystone 编码输出）',
      'pane2.disasm': '反汇编（Capstone 解码验证）',
      'pane2.data': '数据段（伪指令定义）',
      'pane3.tag': '③ Unicorn · 调试器',
      'pane3.title': 'CPU 状态',
      'pane3.env': '运行环境',
      'pane3.envRegs': '初始寄存器（每行 名字=值，如 rax=0x7ff000）',
      'pane3.envMem': '写入内存（每行 地址=值，如 0x200000="hi" 或 0x200010=41 42）',
      'pane3.maxInsns': '指令上限',
      'pane3.bpHint': '点击反汇编行号可设置/取消断点',
      'sec.regs': '寄存器',
      'sec.regsHint': '（绿色 = 已变化）',
      'sec.console': '控制台',
      'sec.consoleHint': '（syscall / int 0x80 / svc 的 write 输出）',
      'sec.trace': '执行轨迹',
      'sec.traceHint': '（Unicorn 执行 × Capstone 注解）',
      'sec.memops': '内存访问',
      'reg.name': '寄存器',
      'reg.init': '初值',
      'reg.now': '当前值',
      'reg.changed': '已变化',
      'dbg.state.idle': '未开始',
      'dbg.state.ready': '就绪',
      'dbg.state.running': '运行中…',
      'dbg.state.paused': '已暂停',
      'dbg.state.ended': '已结束',
      'dbg.state.error': '错误',
      'dbg.bpHit': '命中断点',
      'reason.init': '等待启动',
      'reason.paused': '单步暂停',
      'reason.ended': '正常结束',
      'reason.exit': 'exit({code})',
      'reason.bp': '断点 {addr}',
      'reason.trace-limit': '轨迹上限',
      'reason.count-limit': '达到指令上限',
      'reason.invalid': '无效指令（跑出代码区？）',
      'reason.error': '引擎错误 {errno}',
      'reason.fatal': '内存访问越界（引擎已恢复）',
      'reason.syscallStop': 'syscall 停止',
      'status.assembling': '汇编中…',
      'status.insns': '{n} 条指令 · {b} 字节',
      'status.empty': '（空程序）',
      'status.errAt': '汇编失败：第 {lines} 行',
      'status.errHint': '提示：注释以 ; // # @ ! 开头（按架构）；支持 .org/.byte/.word/.ascii/.equ 等伪指令；不支持未定义标签',
      'status.deferredNote': '部分行依赖标签（见黄色标记），机器码按整体汇编生成',
      'status.lineMapUnavailable': ' · 行号映射不可用（含标签）',
      'status.unmapped': '（Capstone 无法解码）',
      'status.engineHang': '汇编引擎响应超时（已自动恢复）',
      'tab.source': '源码',
      'tab.hex': '机器码',
      'tab.sourceHint': '汇编源码输入（Keystone 汇编）',
      'tab.hexHint': '机器码输入：粘贴/导入后实时反汇编，可直接单步调试',
      'hexin.placeholder': '粘贴机器码：支持 48 c7 c0 01 / 48c7c001 / objdump / xxd 格式；每行可用 # ; // 注释；用 @code 0x10000 / @data 0x200000 标记代码与数据区',
      'hexin.help': '提示：@code 后为代码（被 Capstone 反汇编），@data 后为纯数据（只做 hex/ASCII 显示，不会被误解码）；省略地址则顺接上一块。',
      'btn.toAsm': '⤴ 转为源码',
      'btn.gen': '⟲ 与源码同步',
      'btn.import': '导入文件',
      'hexin.statusOk': '{n} 字节 · {m} 条指令 · {d} 字节数据',
      'hexin.modeNote': '当前由机器码驱动；左侧「源码」页已同步为反汇编结果，可直接单步调试',
      'hexin.syncedNote': '与「源码」页一致（点「机器码」可查看/编辑字节，编辑后自动重编）',
      'hexin.toAsmDone': '已切到源码页（{n} 条指令，分支目标已转为标签）',
      'hexin.importDone': '已导入 {n}',
      'hexin.needBytes': '请先输入有效的机器码',
      'hexin.reasmChanged': '由机器码生成的源码重新汇编后字节有变化：{a} → {b} 字节（引擎编码差异，详见日志）',
      'status.dataOnly': '纯数据：无可执行指令',
      'status.dataOnlyMeta': '{b} 字节数据 · 0 条指令',
      'emu.noCode': '纯数据程序：无可执行指令，调试器不启动',
      'status.fromHex': '由机器码导入',
      'log.title': '日志',
      'log.follow': '跟随',
      'log.level': '级别',
      'log.clear': '清空',
      'log.empty': '（暂无日志）',
      'emuwarn.badRegs': '无法识别的寄存器行: {list}',
      'emuwarn.badMem': '无法识别的内存行: {list}',
      'waitValid': '等待有效汇编结果…',
      'trace.more': '… 还有 {n} 条（仅显示前 {m} 条）',
      'memops.more': '… 还有 {n} 条',
      'memops.none': '（无内存访问）',
      'console.none': '（无 syscall 输出）',
      'trace.external': '（代码区外）',
      'row.write': '写',
      'row.read': '读',
      'foot.pipeline': '三引擎流水线：Keystone 把汇编编码为机器码 → Capstone 解码回汇编验证回环 → Unicorn 在模拟 CPU 中单步调试与执行。',
      'foot.tech': '纯前端 · WebAssembly（Emscripten 构建）· 引擎：@alexaltea/keystone-js、capstone-js、unicorn-js',
      'engines.uc': 'Unicorn·{arch}',
    },
    en: {
      'app.title': 'Assembly Explorer',
      'app.subtitle': 'Assembly ⇄ Machine Code ⇄ Execution · Keystone · Capstone · Unicorn (WASM)',
      'ctl.arch': 'Arch',
      'ctl.syntax': 'Syntax',
      'ctl.base': 'Base',
      'ctl.theme': 'Theme',
      'theme.dark': 'Dark',
      'theme.light': 'Light',
      'theme.system': 'System',
      'lang.zh': '中文',
      'lang.en': 'EN',
      'btn.share': 'Share',
      'btn.shareDone': 'Link copied to clipboard',
      'btn.shareFallback': 'Link written to address bar',
      'btn.loadExample': 'Example',
      'btn.run': 'Run',
      'btn.pause': 'Pause',
      'btn.stepOver': 'Step Over',
      'btn.stepIn': 'Step In',
      'btn.stop': 'Stop',
      'btn.autoRun': 'Auto run',
      'pane1.tag': '① Keystone · Assembler',
      'pane1.title': 'Source / Machine code',
      'pane2.tag': '② Capstone · Disassembler',
      'pane2.title': 'Machine Code & Round-trip',
      'pane2.hexdump': 'Machine code (Keystone encoding)',
      'pane2.disasm': 'Disassembly (Capstone round-trip)',
      'pane2.data': 'Data segments (directives)',
      'pane3.tag': '③ Unicorn · Debugger',
      'pane3.title': 'CPU State',
      'pane3.env': 'Runtime Environment',
      'pane3.envRegs': 'Initial registers (one per line: name=value, e.g. rax=0x7ff000)',
      'pane3.envMem': 'Memory writes (one per line: addr=value, e.g. 0x200000="hi" or 0x200010=41 42)',
      'pane3.maxInsns': 'Max instructions',
      'pane3.bpHint': 'Click a disassembly row to toggle a breakpoint',
      'sec.regs': 'Registers',
      'sec.regsHint': ' (green = changed)',
      'sec.console': 'Console',
      'sec.consoleHint': ' (write() output via syscall / int 0x80 / svc)',
      'sec.trace': 'Execution trace',
      'sec.traceHint': ' (Unicorn steps annotated by Capstone)',
      'sec.memops': 'Memory accesses',
      'reg.name': 'Register',
      'reg.init': 'Initial',
      'reg.now': 'Current',
      'reg.changed': 'changed',
      'dbg.state.idle': 'Idle',
      'dbg.state.ready': 'Ready',
      'dbg.state.running': 'Running…',
      'dbg.state.paused': 'Paused',
      'dbg.state.ended': 'Finished',
      'dbg.state.error': 'Error',
      'dbg.bpHit': 'Breakpoint hit',
      'reason.init': 'Waiting to start',
      'reason.paused': 'Stepped',
      'reason.ended': 'Completed',
      'reason.exit': 'exit({code})',
      'reason.bp': 'Breakpoint {addr}',
      'reason.trace-limit': 'Trace limit',
      'reason.count-limit': 'Instruction limit reached',
      'reason.invalid': 'Invalid instruction (ran off code?)',
      'reason.error': 'Engine error {errno}',
      'reason.fatal': 'Unmapped memory access (engine recovered)',
      'reason.syscallStop': 'Stopped by syscall',
      'status.assembling': 'Assembling…',
      'status.insns': '{n} instructions · {b} bytes',
      'status.empty': ' (empty program)',
      'status.errAt': 'Assembly failed at line {lines}',
      'status.errHint': 'Tips: comments start with ; // # @ ! (per arch); directives .org/.byte/.word/.ascii/.equ are supported; undefined labels are not',
      'status.deferredNote': 'Some lines depend on labels (amber marks); encoding uses whole-segment assembly',
      'status.lineMapUnavailable': ' · line mapping unavailable (labels)',
      'status.unmapped': ' (Capstone cannot decode)',
      'status.engineHang': 'Assembler engine timed out (recovered automatically)',
      'tab.source': 'Source',
      'tab.hex': 'Machine code',
      'tab.sourceHint': 'Assembly source input (Keystone)',
      'tab.hexHint': 'Machine-code input: paste/import for live disassembly and debugging',
      'hexin.placeholder': 'Paste machine code: plain hex `48 c7 c0 01`, objdump or xxd dumps; `#` `;` `//` start comments; use @code 0x10000 / @data 0x200000 to mark code and data regions',
      'hexin.help': 'Tip: bytes after @code are disassembled by Capstone; bytes after @data are pure data (shown as hex/ASCII only, never mis-decoded). Omit the address to continue from the previous block.',
      'btn.toAsm': '⤴ To source',
      'btn.gen': '⟲ Sync from source',
      'btn.import': 'Import file',
      'hexin.statusOk': '{n} bytes · {m} instructions · {d} data bytes',
      'hexin.modeNote': 'Driven by machine code; the Source tab mirrors the disassembly. You can single-step directly',
      'hexin.syncedNote': 'In sync with the Source tab (open this tab to view/edit bytes; editing re-assembles)',
      'hexin.toAsmDone': 'Switched to Source ({n} instructions; branch targets became labels)',
      'hexin.importDone': 'Imported {n}',
      'hexin.needBytes': 'Enter valid machine code first',
      'hexin.reasmChanged': 'Re-assembling the generated source changed the bytes: {a} → {b} bytes (engine encoding differences; see log)',
      'status.dataOnly': 'Data only — no executable instructions',
      'status.dataOnlyMeta': '{b} data bytes · 0 instructions',
      'emu.noCode': 'Data-only program: nothing to execute, debugger not started',
      'status.fromHex': 'imported from machine code',
      'log.title': 'Log',
      'log.follow': 'Follow',
      'log.level': 'Level',
      'log.clear': 'Clear',
      'log.empty': ' (no log yet)',
      'emuwarn.badRegs': 'Unknown register lines: {list}',
      'emuwarn.badMem': 'Unknown memory lines: {list}',
      'waitValid': 'Waiting for a valid assembly result…',
      'trace.more': '… {n} more (showing first {m})',
      'memops.more': '… {n} more',
      'memops.none': ' (no memory access)',
      'console.none': ' (no syscall output)',
      'trace.external': ' (outside code)',
      'row.write': 'W',
      'row.read': 'R',
      'foot.pipeline': 'Three-engine pipeline: Keystone encodes assembly into machine code → Capstone round-trips it back to text → Unicorn single-steps and executes it on an emulated CPU.',
      'foot.tech': 'Pure frontend · WebAssembly (Emscripten builds) · Engines: @alexaltea/keystone-js, capstone-js, unicorn-js',
      'engines.uc': 'Unicorn·{arch}',
    },
  };

  let current = 'zh';

  function detect() {
    try {
      const saved = localStorage.getItem('asmexplorer.lang');
      if (saved && dict[saved]) return saved;
    } catch (e) { /* 无 localStorage */ }
    let nav = 'zh';
    try { nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh'; } catch (e) {}
    return String(nav).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  function t(key, params) {
    let s = (dict[current] && dict[current][key]) || (dict.zh && dict.zh[key]) || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
    }
    return s;
  }

  function setLang(lang) {
    if (!dict[lang]) return;
    current = lang;
    try { localStorage.setItem('asmexplorer.lang', lang); } catch (e) {}
    if (typeof document !== 'undefined') applyDom();
  }

  function getLang() { return current; }
  function languages() { return Object.keys(dict); }

  function applyDom(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  }

  function init() { current = detect(); }

  return { t, setLang, getLang, languages, init, applyDom, dict };
});
