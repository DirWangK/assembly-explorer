/* mobile.js — 移动端布局与交互：单栏分页、设置抽屉、软键盘可视高度
 * 依赖：js/ui/{dom,state}.js（脚本顺序在 app.js 之前） */
'use strict';

(function () {
  const AE = window.AE;
  const { $ } = AE.dom;
  const TABS = ['src', 'out', 'dbg', 'log'];
  const MQ = window.matchMedia ? window.matchMedia('(max-width: 1100px)') : null;
  let current = 'src';
  let vvPending = false;

  function isMobile() { return !MQ || MQ.matches; }

  function closeTools() {
    if (!document.body.classList.contains('m-tools-open')) return;
    document.body.classList.remove('m-tools-open');
    const btn = $('m-tools');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function toggleTools() {
    const open = document.body.classList.toggle('m-tools-open');
    const btn = $('m-tools');
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }

  /* 切页时收起软键盘：输入控件仍在焦点会占掉一半可视区 */
  function blurField() {
    const el = document.activeElement;
    if (!el || el === document.body) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el.blur();
  }

  /* 再次点击当前 tab：列表回到顶部（日志页跟随到底部） */
  function scrollPaneTop(name) {
    if (name === 'log') {
      if (AE.log && AE.log.follow) { AE.log.scrollToEnd(); return; }
      const body = $('logbody');
      if (body) body.scrollTop = 0;
      return;
    }
    const pane = document.querySelector('.pane[data-pane="' + name + '"] .pane-body');
    if (pane) pane.scrollTop = 0;
  }

  function setTab(name) {
    if (TABS.indexOf(name) < 0) name = 'src';
    const prev = current;
    const switching = prev !== name;
    if (switching) blurField();
    current = name;
    document.body.setAttribute('data-mtab', name);
    document.querySelectorAll('#mtabs .mtab').forEach((b) => {
      const on = b.getAttribute('data-mtab') === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    /* 移动端日志总是整页展开，清掉桌面端遗留的折叠状态 */
    if (name === 'log' && AE.log && AE.log.isCollapsed && AE.log.isCollapsed()) AE.log.toggle(false);
    /* 编辑器在隐藏时尺寸为 0：切回后同步高亮层与行号的滚动位置 */
    if (name === 'src' && AE.editor) {
      requestAnimationFrame(() => { if (AE.editor.refresh) AE.editor.refresh(); });
    }
    /* 日志页从隐藏恢复显示后，重新贴到底部 */
    if (name === 'log' && switching && AE.log && AE.log.follow) {
      requestAnimationFrame(() => AE.log.scrollToEnd());
    }
    if (!switching) scrollPaneTop(name);
    closeTools();
  }

  /* 软键盘 / 地址栏收起时同步应用高度（iOS 不会自动缩放布局视口） */
  function syncViewport() {
    const vv = window.visualViewport;
    const h = vv && vv.scale <= 1.01 ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
  }

  function queueViewport() {
    if (vvPending) return;
    vvPending = true;
    requestAnimationFrame(() => { vvPending = false; syncViewport(); });
  }

  function refreshEditor() {
    if (AE.editor && AE.editor.refresh) AE.editor.refresh();
  }

  function bind() {
    const tabs = $('mtabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.mtab[data-mtab]');
        if (btn) setTab(btn.getAttribute('data-mtab'));
      });
      /* 外接键盘 / 读屏器：方向键在 tab 间移动并激活 */
      tabs.addEventListener('keydown', (e) => {
        let idx = TABS.indexOf(current);
        if (e.key === 'ArrowRight') idx = (idx + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') idx = (idx - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') idx = 0;
        else if (e.key === 'End') idx = TABS.length - 1;
        else return;
        e.preventDefault();
        setTab(TABS[idx]);
        const btn = tabs.querySelector('.mtab[data-mtab="' + TABS[idx] + '"]');
        if (btn) btn.focus();
      });
    }

    const toolBtn = $('m-tools');
    if (toolBtn) toolBtn.addEventListener('click', toggleTools);
    const closeBtn = $('m-tools-close');
    if (closeBtn) closeBtn.addEventListener('click', closeTools);
    const scrim = $('m-scrim');
    if (scrim) scrim.addEventListener('click', closeTools);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTools();
    });

    window.addEventListener('resize', queueViewport);
    window.addEventListener('orientationchange', () => {
      setTimeout(() => { syncViewport(); refreshEditor(); }, 120);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', queueViewport);
    }

    const onSwitch = () => {
      closeTools();
      syncViewport();
      refreshEditor();
    };
    if (MQ) {
      if (MQ.addEventListener) MQ.addEventListener('change', onSwitch);
      else if (MQ.addListener) MQ.addListener(onSwitch);
    }
  }

  setTab('src');
  syncViewport();
  bind();

  AE.mobile = { setTab, isMobile, closeTools, currentTab: () => current };
})();
