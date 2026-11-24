/* memfault.js — 未映射内存引导弹窗
 * 触发：运行中命中未映射内存（自动）/ 调试栏「内存」按钮（手动）
 * 能力：映射内存页、导入文件、粘贴 HEX/文本，映射后原地继续（引擎不重建）
 * 依赖：js/ui/{dom,state,engines,debugger,log}.js */
'use strict';

(function () {
  const AE = window.AE;
  const { $, I, escHtml, fmtHex, toast } = AE.dom;
  const LOG = AE.log;
  const dbg = AE.dbg;

  const PAGE = 0x1000;
  const MAX_MAP = 16 * 1024 * 1024;      // 单次自定义映射上限（16 MiB）
  const MAX_FILE = AE.MAX_IMPORT_BYTES;  // 导入文件上限（256 KiB）
  const HEX_RE = /^[0-9a-fA-F]+$/;

  const mem = {
    open: false,
    mode: 'manual',      // fault | fatal | manual
    fault: null,         // {addr,size,access}
    dataKind: 'none',    // none | text | file
    fileBytes: null,
    fileName: '',
    applying: false,
  };

  /* ---------------- 解析 / 格式化 ---------------- */

  function parseAddr(text) {
    const t = String(text || '').trim();
    if (!t) return NaN;
    if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return NaN;
  }

  function fmtBytes(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n % (1024 * 1024) ? 1 : 0) + ' MiB';
    if (n >= 1024) return (n / 1024).toFixed(n % 1024 ? 1 : 0) + ' KiB';
    return n + ' B';
  }

  function parseTextBytes(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const compact = raw.replace(/0[xX]/g, '').replace(/[\s,;:_-]/g, '');
    if (compact.length >= 2 && compact.length % 2 === 0 && HEX_RE.test(compact)) {
      const out = new Uint8Array(compact.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    return new TextEncoder().encode(raw);
  }

  function accessLabel(access) {
    return I(access === 'w' ? 'mem.faultWrite' : access === 'x' ? 'mem.faultFetch' : 'mem.faultRead');
  }

  /* ---------------- 表单状态 ---------------- */

  function selectedSize() {
    const v = $('mem-size').value;
    if (v === 'custom') {
      const kb = parseInt($('mem-custom').value, 10);
      return Math.min(Math.max(kb || 4, 1), MAX_MAP / 1024) * 1024;
    }
    return parseInt(v, 10) || PAGE;
  }

  function effectiveData() {
    if (mem.dataKind === 'text') return parseTextBytes($('mem-data-text').value);
    if (mem.dataKind === 'file') return mem.fileBytes;
    return null;
  }

  /* 返回页对齐后的映射范围（数据长度不足时自动扩展） */
  function plan() {
    const addr = parseAddr($('mem-addr').value);
    if (isNaN(addr) || addr < 0 || addr > 0xFFFFFFFF) return { error: I('mem.badAddr') };
    const data = effectiveData();
    const need = Math.max(selectedSize(), data ? data.length : 0, (mem.fault && mem.fault.size) || 1);
    const start = Math.floor(addr / PAGE) * PAGE;
    const end = Math.ceil((addr + need) / PAGE) * PAGE;
    if (end - start > MAX_MAP) return { error: I('mem.tooBig', { n: MAX_MAP / 1024 / 1024 }) };
    return { addr, start, end, size: end - start, data };
  }

  function updateRange() {
    const p = plan();
    const el = $('mem-range');
    if (p.error) {
      el.textContent = p.error;
      el.classList.add('bad');
      $('mem-continue').disabled = true;
      $('mem-apply').disabled = true;
      return false;
    }
    el.classList.remove('bad');
    $('mem-continue').disabled = mem.applying;
    $('mem-apply').disabled = mem.applying;
    let text = I('mem.range', { from: fmtHex(p.start, 4), to: fmtHex(p.end, 4), size: fmtBytes(p.size) });
    if (p.data && p.data.length) {
      text += ' · ' + I('mem.rangeData', { n: p.data.length, addr: fmtHex(p.addr, 4) });
    }
    el.textContent = text;
    return true;
  }

  function setDataKind(kind) {
    mem.dataKind = kind;
    document.querySelectorAll('#mem-data-seg button').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
    $('mem-data-text').classList.toggle('hidden', kind !== 'text');
    $('mem-file-row').classList.toggle('hidden', kind !== 'file');
    updateRange();
  }

  function renderRegions() {
    const el = $('mem-regions');
    const list = (dbg.regions && dbg.regions.length ? dbg.regions : dbg.extraMaps.map(m => [m.addr, m.addr + m.size]));
    if (!list.length) {
      el.innerHTML = '<span class="dim">' + I('mem.noRegions') + '</span>';
    } else {
      const rows = list.slice(0, 12).map(([a, b]) =>
        '<div>' + fmtHex(a, 4) + ' – ' + fmtHex(b, 4) + ' <span class="dim">(' + fmtBytes(b - a) + ')</span></div>');
      if (list.length > 12) rows.push('<div class="dim">… ' + (list.length - 12) + '</div>');
      el.innerHTML = rows.join('');
    }
    $('mem-clear').classList.toggle('hidden', !dbg.extraMaps.length);
  }

  function renderTexts() {
    const titleKey = mem.mode === 'manual' ? 'mem.titleManual' : (mem.mode === 'fatal' ? 'mem.titleFatal' : 'mem.title');
    $('mem-title').textContent = I(titleKey);
    let sub = '';
    if (mem.mode === 'fault' && mem.fault) {
      sub = I('mem.faultDesc', {
        addr: fmtHex(mem.fault.addr, 4),
        access: accessLabel(mem.fault.access),
        size: mem.fault.size,
      });
    } else if (mem.mode === 'fatal') {
      sub = I('mem.faultDescFatal');
    } else {
      sub = I('mem.manualDesc');
    }
    $('mem-sub').textContent = sub;

    const badges = $('mem-badges');
    if (mem.fault) {
      badges.innerHTML =
        '<span class="mem-badge ' + mem.fault.access + '">' + escHtml(accessLabel(mem.fault.access)) + '</span>' +
        '<span class="mem-badge addr">' + fmtHex(mem.fault.addr, 4) + '</span>' +
        '<span class="mem-badge">' + mem.fault.size + ' B</span>';
    } else {
      badges.innerHTML = '';
    }

    $('mem-hint').textContent = I('mem.hintText') +
      (mem.fault && mem.fault.access === 'x' ? ' ' + I('mem.fetchWarn') : '');
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  function resetForm(faultInfo) {
    mem.fault = faultInfo || null;
    const addr = faultInfo
      ? Math.floor(faultInfo.addr / PAGE) * PAGE
      : (dbg.extraMaps.length ? (dbg.extraMaps[dbg.extraMaps.length - 1].addr + dbg.extraMaps[dbg.extraMaps.length - 1].size) : 0x500000);
    $('mem-addr').value = '0x' + addr.toString(16);
    $('mem-size').value = '4096';
    $('mem-custom').value = '4';
    $('mem-custom-wrap').classList.add('hidden');
    $('mem-data-text').value = '';
    $('mem-file-name').textContent = I('mem.fileNone');
    mem.fileBytes = null;
    mem.fileName = '';
    mem.applying = false;
    setDataKind('none');
    renderTexts();
    renderRegions();
    $('mem-err').textContent = '';
    updateRange();
  }

  function showModal(mode, faultInfo) {
    mem.mode = mode;
    mem.open = true;
    $('mem-backdrop').classList.remove('hidden');
    resetForm(faultInfo);
    setTimeout(() => {
      const el = $('mem-addr');
      if (el) { el.focus(); el.select(); }
    }, 0);
  }

  function close() {
    if (mem.applying) return;
    mem.open = false;
    $('mem-backdrop').classList.add('hidden');
  }

  function onFault(faultInfo, pc) {
    if (mem.open) return; // 已打开时不重复弹窗
    LOG.debug('UC', '引导内存映射：故障地址 ' + fmtHex(faultInfo.addr, 4));
    showModal('fault', faultInfo);
  }

  function onFatal(reason) {
    if (mem.open) return;
    LOG.warn('UC', '引擎已重建，等待手动映射：' + (reason && reason.message || ''));
    showModal('fatal', null);
  }

  function openManual() {
    if (mem.open) return;
    showModal('manual', null);
  }

  /* ---------------- 应用 ---------------- */

  async function apply(cont) {
    if (mem.applying) return;
    if (!updateRange()) return;
    const p = plan();
    if (p.error) { $('mem-err').textContent = p.error; return; }

    mem.applying = true;
    $('mem-apply').disabled = true;
    $('mem-continue').disabled = true;
    $('mem-err').textContent = '';

    const maps = [{ addr: p.start, size: p.size }];
    const writes = p.data && p.data.length ? [{ addr: p.addr, bytes: Array.from(p.data) }] : [];

    LOG.info('UC', '映射内存 ' + fmtHex(p.start, 4) + ' – ' + fmtHex(p.end, 4) + '（' + fmtBytes(p.size) + '）' +
      (writes.length ? '，写入 ' + p.data.length + ' 字节 @ ' + fmtHex(p.addr, 4) : ''));

    try {
      const r = await AE.debug.applyMemory({ maps, writes, continue: cont });
      if (!r || !r.ok) {
        $('mem-err').textContent = I('mem.applyFailed');
        mem.applying = false;
        updateRange();
        return;
      }
      toast(I('mem.mapped', { range: fmtHex(p.start, 4) + ' – ' + fmtHex(p.end, 4) }));
      mem.applying = false;
      /* 继续执行后又命中另一处未映射地址：保持弹窗并切换为新的故障 */
      if (cont && dbg.state === 'paused' && dbg.reason && dbg.reason.type === 'mem-fault') {
        mem.mode = 'fault';
        resetForm(dbg.reason);
        return;
      }
      mem.open = false;
      $('mem-backdrop').classList.add('hidden');
    } catch (e) {
      mem.applying = false;
      $('mem-err').textContent = String(e && e.message || e);
      updateRange();
      LOG.error('UC', '内存映射失败：' + (e && e.message || e));
    }
  }

  function readFile(file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      let u8 = new Uint8Array(fr.result);
      if (u8.length > MAX_FILE) {
        u8 = u8.slice(0, MAX_FILE);
        LOG.warn('UC', '文件超过 ' + (MAX_FILE / 1024) + 'KB，仅取前 ' + (MAX_FILE / 1024) + 'KB');
      }
      mem.fileBytes = u8;
      mem.fileName = file.name;
      $('mem-file-name').textContent = file.name + ' · ' + fmtBytes(u8.length);
      updateRange();
    };
    fr.onerror = () => { $('mem-err').textContent = I('mem.fileRead'); };
    fr.readAsArrayBuffer(file);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    $('mem-x').addEventListener('click', close);
    $('mem-cancel').addEventListener('click', close);
    $('mem-backdrop').addEventListener('mousedown', (e) => {
      if (e.target === $('mem-backdrop')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (mem.open && e.key === 'Escape') close();
    });
    $('mem-apply').addEventListener('click', () => apply(false));
    $('mem-continue').addEventListener('click', () => apply(true));
    $('mem-clear').addEventListener('click', () => {
      AE.debug.clearMemoryExtras();
      renderRegions();
      toast(I('mem.cleared'));
    });
    $('mem-size').addEventListener('change', () => {
      $('mem-custom-wrap').classList.toggle('hidden', $('mem-size').value !== 'custom');
      updateRange();
    });
    $('mem-custom').addEventListener('input', updateRange);
    $('mem-addr').addEventListener('input', updateRange);
    $('mem-data-text').addEventListener('input', updateRange);
    document.querySelectorAll('#mem-data-seg button').forEach(b =>
      b.addEventListener('click', () => setDataKind(b.dataset.kind)));
    $('mem-file-btn').addEventListener('click', () => $('mem-file').click());
    $('mem-file').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) readFile(e.target.files[0]);
      e.target.value = '';
    });
    $('dbg-mem').addEventListener('click', openManual);
    $('mem-addr').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(true); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  AE.memfault = {
    openManual, onFault, onFatal, close,
    refresh: () => { if (mem.open) { renderTexts(); renderRegions(); updateRange(); } },
    isOpen: () => mem.open,
  };
})();
