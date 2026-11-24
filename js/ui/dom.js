/* dom.js — 基础层：选择器、i18n 快捷方式、HTML 转义、十六进制格式化、防抖、toast
 * 依赖：js/ui/i18n.js（调用时） */
'use strict';

(function () {
  const AE = window.AE = window.AE || {};

  const $ = (id) => document.getElementById(id);
  const I = (key, params) => I18N.t(key, params);

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtHex(v, widthBytes) {
    const b = BigInt(v);
    const w = widthBytes * 2;
    return b < 0n
      ? '-0x' + (-b).toString(16).toUpperCase().padStart(w, '0')
      : '0x' + b.toString(16).toUpperCase().padStart(w, '0');
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  AE.dom = { $, I, escHtml, fmtHex, debounce, toast };
})();
