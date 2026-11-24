/* app.js — 装配与启动：事件绑定、引擎初始化、首屏流水线
 * 依赖：所有 ui 模块（见 index.html 脚本顺序） */
'use strict';

(function () {
  const AE = window.AE;
  const { $ } = AE.dom;
  const state = AE.state;
  const LOG = AE.log;
  const Engines = AE.engines;
  const Input = AE.input;
  const Debug = AE.debug;
  const Prefs = AE.prefs;

  function wireEvents() {
    $('arch').addEventListener('change', (e) => Prefs.setArch(e.target.value));
    $('syntax').addEventListener('change', (e) => { state.syntax = e.target.value; Input.assemble(); });
    $('base').addEventListener('change', () => {
      const v = parseInt($('base').value, 16);
      if (!isNaN(v) && v >= 0 && v <= 0xffffffff && !(v & 0xf)) { state.base = v; Input.assemble(); }
      else Prefs.refreshBaseInput();
    });
    $('maxinsns').addEventListener('change', () => {
      const v = parseInt($('maxinsns').value, 10);
      if (v > 0 && v <= 20000000) { state.maxCount = v; Debug.startDebugSession(); }
    });
    $('autoemu').addEventListener('change', (e) => {
      state.autoEmu = e.target.checked;
      if (state.autoEmu) Debug.startDebugSession();
    });
    $('example').addEventListener('click', () => {
      AE.editor.value = Engines.arch().example;
      state.loadedExample = state.archId;
      state.hexDirty = false;
      if (state.tab === 'hex') Input.switchTab('src');
      else Input.assemble();
    });
    $('share').addEventListener('click', Prefs.shareLink);

    // 第 1 栏：源码 ⇄ 机器码（与 Keystone 同一输入面）
    $('tab-src').addEventListener('click', () => Input.switchTab('src'));
    $('tab-hex').addEventListener('click', () => Input.switchTab('hex'));
    $('hexin-toasm').addEventListener('click', Input.hexToSource);
    $('hexin-gen').addEventListener('click', Input.hexSyncFromSource);
    $('hexin-import').addEventListener('click', () => $('hexin-file').click());
    $('hexin-file').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) Input.hexinImportFile(e.target.files[0]);
      e.target.value = '';
    });
    $('hexin').addEventListener('input', () => {
      state.hexDirty = true;
      Input.runHexPipeline();
    });

    // 底部日志面板
    $('log-toggle').addEventListener('click', () => LOG.toggle());
    $('log-clear').addEventListener('click', () => LOG.clear());
    $('log-follow').addEventListener('change', (e) => LOG.setFollow(e.target.checked));
    $('log-level').addEventListener('change', (e) => {
      LOG.setLevel(e.target.value);
      try { localStorage.setItem('asmexplorer.loglevel', e.target.value); } catch (err) {}
    });

    // 调试工具栏
    $('dbg-run').addEventListener('click', Debug.dbgRun);
    $('dbg-pause').addEventListener('click', () => {
      if (Debug.dbg.state === 'running') {
        Debug.setDbgStateChip('pausing');
        LOG.info('UC', '请求暂停 @ ' + AE.dom.fmtHex(Debug.dbg.pc, 4));
        Engines.uc.call({ type: 'pause' });
      }
    });
    $('dbg-stepin').addEventListener('click', Debug.dbgStepIn);
    $('dbg-stepover').addEventListener('click', Debug.dbgStepOver);
    $('dbg-stop').addEventListener('click', Debug.dbgStop);

    // 断点：点击反汇编行切换
    $('disasm').addEventListener('click', (e) => {
      const row = e.target.closest('.insrow[data-addr]');
      if (!row) return;
      Debug.toggleBreakpoint(Number(row.dataset.addr), row);
    });

    // 主题 / 语言
    document.querySelectorAll('#theme-seg button').forEach(b =>
      b.addEventListener('click', () => Prefs.applyTheme(b.dataset.themeOpt)));
    document.querySelectorAll('#lang-seg button').forEach(b =>
      b.addEventListener('click', () => Prefs.applyLang(b.dataset.langOpt)));

    $('initregs').addEventListener('input', Debug.scheduleDebug);
    $('initmem').addEventListener('input', Debug.scheduleDebug);
  }

  async function boot() {
    I18N.init();

    /* 日志面板：先挂载，后续引擎事件即可见 */
    LOG.mount({ bar: $('logbar'), body: $('logbody'), count: $('log-count') });
    let logLevel = 'info', logOpen = '1';
    try {
      logLevel = localStorage.getItem('asmexplorer.loglevel') || 'info';
      logOpen = localStorage.getItem('asmexplorer.logopen') || '1';
    } catch (e) {}
    LOG.setLevel(logLevel);
    $('log-level').value = logLevel;
    LOG.toggle(logOpen !== '1');
    LOG.info('UI', 'Assembly Explorer 启动（' + navigator.platform + '）');

    Prefs.applyLang(I18N.getLang());
    Prefs.initTheme();

    AE.editor = new AsmEditor($('editor-wrap'), () => Input.assemble());
    Prefs.populateArchSelect();
    Prefs.refreshSyntaxSelect();
    Prefs.refreshBaseInput();
    $('arch').value = state.archId;
    AE.editor.setArch(Engines.arch());
    AE.editor.value = Engines.arch().example;
    state.loadedExample = state.archId;

    Engines.ks = Engines.makeKsHost();
    Engines.uc = Engines.makeUcHost();
    wireEvents();
    Engines.updatePills(); // 初始进度：0/3

    const t0 = performance.now();
    try {
      await Engines.loadCapstone();
      state.enginePills.cs = true;
      Engines.updatePills();
      LOG.ok('CS', 'Capstone 就绪（' + Math.round(performance.now() - t0) + 'ms）');
    } catch (e) {
      LOG.error('CS', 'Capstone 加载失败：' + (e && e.message || e));
      Engines.bootFailed('Capstone');
    }

    Engines.uc.ensure()
      .then(() => { state.enginePills.uc = true; Engines.updatePills(); })
      .catch((e) => { Engines.bootFailed('Unicorn'); LOG.error('UC', 'Unicorn 加载失败：' + (e && e.message || e)); });
    Engines.ks.ensure()
      .then(() => { state.enginePills.ks = true; Engines.updatePills(); })
      .catch((e) => { Engines.bootFailed('Keystone'); LOG.error('KS', 'Keystone 加载失败：' + (e && e.message || e)); });

    Prefs.loadFromHash();
    Prefs.refreshSyntaxSelect();
    Prefs.refreshBaseInput();
    AE.editor.setArch(Engines.arch());
    if (state.tab !== 'hex') Input.assemble();
    console.log('engines ready in', (performance.now() - t0).toFixed(0), 'ms');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
