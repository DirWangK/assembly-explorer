/* prefs.js — 偏好与全局控制：主题、语言、架构/语法/基址、示例、分享链接
 * 依赖：js/ui/{dom,state,engines,input,log}.js */
'use strict';

(function () {
  const AE = window.AE;
  const { $, I, toast } = AE.dom;
  const state = AE.state;
  const LOG = AE.log;
  const Engines = AE.engines;
  const Input = AE.input;
  const arch = Engines.arch;

  /* ---------------- 主题 / 语言 ---------------- */

  function applyTheme(mode) {
    state.theme = mode;
    try { localStorage.setItem('asmexplorer.theme', mode); } catch (e) {}
    let effective = mode;
    if (mode === 'system') {
      effective = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', effective);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', effective === 'light' ? '#f2f4f7' : '#13161c');
    document.querySelectorAll('#theme-seg button').forEach(b => b.classList.toggle('on', b.dataset.themeOpt === mode));
  }

  function initTheme() {
    let saved = 'dark';
    try { saved = localStorage.getItem('asmexplorer.theme') || 'dark'; } catch (e) {}
    applyTheme(saved);
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (state.theme === 'system') applyTheme('system');
      });
    }
  }

  function applyLang(lang) {
    I18N.setLang(lang);
    document.querySelectorAll('#lang-seg button').forEach(b => b.classList.toggle('on', b.dataset.langOpt === lang));
    refreshSyntaxSelect();
    refreshBaseInput();
    if (AE.memfault) AE.memfault.refresh();
  }

  /* ---------------- 架构 / 语法 / 基址 ---------------- */

  function populateArchSelect() {
    const sel = $('arch');
    const groups = {};
    for (const a of Object.values(ARCHES)) (groups[a.group] = groups[a.group] || []).push(a);
    const groupLabels = { x86: 'x86', arm: 'ARM', mips: 'MIPS', ppc: 'PowerPC', sparc: 'SPARC' };
    for (const [g, list] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = groupLabels[g] || g;
      for (const a of list) {
        const o = document.createElement('option');
        o.value = a.id; o.textContent = a.label;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
  }

  function refreshSyntaxSelect() {
    const a = arch(), sel = $('syntax');
    sel.disabled = !a.syntaxes;
    sel.innerHTML = '';
    if (!a.syntaxes) {
      const o = document.createElement('option');
      o.textContent = 'Intel';
      sel.appendChild(o);
      return;
    }
    const labels = { intel: 'Intel', att: 'AT&T' };
    for (const k of Object.keys(a.syntaxes)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = labels[k] || k;
      sel.appendChild(o);
    }
    if (!a.syntaxes[state.syntax]) state.syntax = 'intel';
    sel.value = state.syntax;
  }

  function refreshBaseInput() {
    const a = arch();
    const inp = $('base');
    if (a.layout.single) { inp.value = '0x0'; inp.disabled = true; state.base = 0; }
    else {
      inp.disabled = false;
      inp.value = '0x' + state.base.toString(16);
    }
  }

  function setArch(id, opts) {
    const prev = arch();
    state.archId = id;
    if (prev && prev.layout.single && !arch().layout.single) state.base = 0x10000;
    /* 架构切换后，自定义内存映射与断点地址不再有意义 */
    if (AE.debug && AE.debug.clearMemoryExtras) AE.debug.clearMemoryExtras();
    if (AE.debug && AE.debug.clearBreakpoints) AE.debug.clearBreakpoints();
    refreshSyntaxSelect();
    refreshBaseInput();
    AE.editor.setArch(arch());
    $('arch').value = id;
    LOG.info('UI', '架构切换：' + prev.label + ' → ' + arch().label);
    if (AE.engines.uc && prev && prev.uc.file !== arch().uc.file) {
      state.enginePills.uc = false;
      AE.engines.uc.respawn();
      Engines.updatePills();
      AE.engines.uc.ensure().then(() => { state.enginePills.uc = true; Engines.updatePills(); }).catch(() => {});
    }
    if (!opts || !opts.keepSource) {
      if (state.loadedExample === prev.id || AE.editor.value.trim() === '') {
        AE.editor.value = arch().example;
        state.loadedExample = id;
        state.hexDirty = false;
      }
    }
    if (state.tab === 'hex') Input.runHexPipeline();
    else Input.assemble();
  }

  /* ---------------- 分享链接 ---------------- */

  function copyText(text, okMsg, fallbackMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast(okMsg), () => toast(fallbackMsg));
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast(okMsg);
    } catch (e) {
      toast(fallbackMsg);
    }
  }

  function shareLink() {
    const data = {
      a: state.archId, s: state.syntax, b: state.base,
      c: AE.editor.value, r: $('initregs').value, m: $('initmem').value, n: state.maxCount,
    };
    if (state.tab === 'hex' && state.hexDirty) {
      data.t = 'hex';
      data.h = $('hexin').value;
    }
    const json = JSON.stringify(data);
    const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = location.origin + location.pathname + '#' + b64;
    history.replaceState(null, '', '#' + b64);
    LOG.info('UI', '分享链接已生成（' + json.length + ' 字符状态）');
    /* 移动端优先调起系统分享面板（微信/QQ/邮件等），不支持时回退到复制链接 */
    const mobile = window.matchMedia && window.matchMedia('(max-width: 1100px)').matches;
    if (mobile && navigator.share) {
      navigator.share({ title: document.title, url }).catch((err) => {
        if (err && err.name === 'AbortError') return;
        copyText(url, I('btn.shareDone'), I('btn.shareFallback'));
      });
      return;
    }
    copyText(url, I('btn.shareDone'), I('btn.shareFallback'));
  }

  function loadFromHash() {
    if (!location.hash || location.hash.length < 2) return false;
    try {
      let b64 = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
      if (data.a && ARCHES[data.a]) { setArch(data.a, { keepSource: true, keepWorker: true }); }
      if (data.s) state.syntax = data.s;
      if (typeof data.b === 'number') state.base = data.b;
      if (typeof data.c === 'string') AE.editor.value = data.c;
      if (typeof data.r === 'string') $('initregs').value = data.r;
      if (typeof data.m === 'string') $('initmem').value = data.m;
      if (typeof data.n === 'number') { state.maxCount = data.n; $('maxinsns').value = data.n; }
      state.loadedExample = null;
      if (data.t === 'hex' && typeof data.h === 'string') {
        state.hexDirty = true;
        $('hexin').value = data.h;
        Input.switchTab('hex', true);
      }
      LOG.info('UI', '已从分享链接恢复状态');
      return true;
    } catch (e) {
      LOG.warn('UI', '分享链接解析失败：' + e.message);
      return false;
    }
  }

  AE.prefs = {
    applyTheme, initTheme, applyLang,
    populateArchSelect, refreshSyntaxSelect, refreshBaseInput, setArch,
    shareLink, copyText, loadFromHash,
  };
})();
