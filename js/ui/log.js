/* applog.js — 底部日志面板（调错用）：分级、模块标签、时间、跟随滚动、折叠、过滤 */
'use strict';

(function (root) {
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const MAX = 800;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }
  function stamp() {
    const d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + pad3(d.getMilliseconds());
  }

  class AppLog {
    constructor() {
      this.entries = [];       // {t, level, tone, mod, msg}
      this.minLevel = 'info';
      this.follow = true;
      this.node = null;        // {bar, body, count, follow, level}
      this.newAlerts = 0;
    }

    mount(node) {
      this.node = node;
      this.renderAll();
    }

    setLevel(level) {
      if (!(level in LEVELS)) return;
      this.minLevel = level;
      this.renderAll();
    }

    setFollow(on) {
      this.follow = !!on;
      if (this.follow) this.scrollToEnd();
    }

    clear() {
      this.entries = [];
      this.newAlerts = 0;
      if (this.node) {
        this.node.body.innerHTML = '';
        this.node.count.textContent = '';
      }
      this.updateBadge();
    }

    add(level, mod, msg, tone) {
      const lv = LEVELS[level] ? level : 'info';
      const entry = { t: stamp(), level: lv, tone: tone || lv, mod: mod || 'UI', msg: String(msg) };
      this.entries.push(entry);
      if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
      if (LEVELS[lv] >= LEVELS[this.minLevel]) this.appendRow(entry, false);
      if (LEVELS[lv] >= LEVELS.warn && this.isCollapsed()) { this.newAlerts++; this.updateBadge(); }
      // 同时保留到 devtools 控制台，便于外部调试
      const fn = lv === 'error' ? console.error : lv === 'warn' ? console.warn : console.log;
      fn('[%s] %s', entry.mod, entry.msg);
    }

    debug(mod, msg) { this.add('debug', mod, msg); }
    info(mod, msg) { this.add('info', mod, msg); }
    ok(mod, msg) { this.add('info', mod, msg, 'ok'); }
    warn(mod, msg) { this.add('warn', mod, msg); }
    error(mod, msg) { this.add('error', mod, msg); }

    isCollapsed() {
      return !!(this.node && this.node.bar.classList.contains('collapsed'));
    }

    toggle(force) {
      if (!this.node) return;
      const collapsed = force === undefined ? !this.isCollapsed() : !!force;
      this.node.bar.classList.toggle('collapsed', collapsed);
      const btn = this.node.bar.querySelector('#log-toggle');
      if (btn) {
        btn.setAttribute('aria-expanded', String(!collapsed));
        const ico = btn.querySelector('.log-ico');
        if (ico) ico.textContent = collapsed ? '▸' : '▾';
      }
      if (!collapsed) {
        this.newAlerts = 0;
        this.updateBadge();
        this.scrollToEnd();
      }
      try { localStorage.setItem('asmexplorer.logopen', collapsed ? '0' : '1'); } catch (e) {}
    }

    updateBadge() {
      if (!this.node) return;
      const errs = this.entries.filter(e => e.level === 'error').length;
      const warns = this.entries.filter(e => e.level === 'warn').length;
      this.node.count.innerHTML =
        '<span class="log-total">' + this.entries.length + '</span>' +
        (warns ? '<span class="log-warn-n">⚠ ' + warns + '</span>' : '') +
        (errs ? '<span class="log-err-n">✘ ' + errs + '</span>' : '');
      this.node.bar.classList.toggle('alert', this.newAlerts > 0);
    }

    rowHtml(e, i) {
      return '<div class="logrow lv-' + e.level + ' tone-' + e.tone + '">' +
        '<span class="logtime">' + e.t + '</span>' +
        '<span class="logmod mod-' + e.mod.toLowerCase().replace(/[^a-z0-9]/g, '') + '">' + esc(e.mod) + '</span>' +
        '<span class="logmsg">' + esc(e.msg) + '</span></div>';
    }

    appendRow(e) {
      if (!this.node) return;
      const empty = this.node.body.querySelector('.log-empty');
      if (empty) empty.remove();
      const div = document.createElement('div');
      div.innerHTML = this.rowHtml(e);
      this.node.body.appendChild(div.firstChild);
      while (this.node.body.childElementCount > MAX) this.node.body.removeChild(this.node.body.firstChild);
      if (this.follow) this.scrollToEnd();
      this.updateBadge();
    }

    renderAll() {
      if (!this.node) return;
      const min = LEVELS[this.minLevel];
      this.node.body.innerHTML = this.entries
        .filter(e => LEVELS[e.level] >= min)
        .map(e => this.rowHtml(e))
        .join('') || '<div class="log-empty">—</div>';
      this.scrollToEnd();
      this.updateBadge();
    }

    scrollToEnd() {
      if (!this.node) return;
      this.node.body.scrollTop = this.node.body.scrollHeight;
    }
  }

  root.AppLog = AppLog;
  /* 全局日志单例（各 UI 模块共用） */
  if (root.AE) root.AE.log = new AppLog();
})(typeof self !== 'undefined' ? self : this);
