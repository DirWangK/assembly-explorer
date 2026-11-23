/* editor.js — 轻量汇编编辑器：行号栏 + 语法高亮覆盖层 + 错误行标记 */
'use strict';

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 找到该行最早的注释起点（与 arches.js stripComments 规则一致） */
function findCommentIndex(line, arch) {
  const chars = (arch.comments || [';']).filter(c => c !== '*/');
  let idx = -1;
  for (const c of chars) {
    const i = line.indexOf(c);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  return idx;
}

function span(cls, text) { return '<span class="tk-' + cls + '">' + text + '</span>'; }

/* 单行高亮：label / directive / mnemonic / register / number / comment */
function highlightLine(line, arch) {
  const group = ARCH_GROUP_BY_ID[arch.id];
  const ci = findCommentIndex(line, arch);
  let codePart = ci === -1 ? line : line.slice(0, ci);
  const cmtPart = ci === -1 ? '' : line.slice(ci);

  let rest = escHtml(codePart);
  let out = '';

  const lbl = rest.match(/^([ \t]*)([A-Za-z_.$][\w.$]*)(:)(.*)$/);
  if (lbl) {
    out += lbl[1] + span('lbl', lbl[2]) + lbl[3];
    rest = lbl[4];
  }

  /* 伪指令（行首或标签后）：.org / .ascii / .equ … */
  const dir = rest.match(/^([ \t]*)(\.[A-Za-z][\w.]*)(.*)$/);
  if (dir) { out += dir[1] + span('dir', dir[2]); rest = dir[3]; }

  if (!dir) {
    const mn = rest.match(/^([ \t]*)([A-Za-z][\w.]*)(.*)$/);
    if (mn && (mn[2].length > 1 || /[a-z]/i.test(mn[2]))) {
      out += mn[1] + span('mnem', mn[2]);
      rest = mn[3];
    } else if (mn) {
      out += mn[1] + escHtml(mn[2]);
      rest = mn[3];
    }
  }

  const regSrc = REGEX[group] ? REGEX[group].source : '(?!)';
  const tokRe = new RegExp(
    '(' + regSrc + ')' +                       /* 1 register */
    '|("(?:[^"\\\\]|\\\\.)*")' +               /* 2 string */
    '|(0[xX][0-9a-fA-F]+|\\b\\d+\\b)' +        /* 3 number */
    '|(#\\d+)',                                /* 4 arm immediate */
    'g');
  rest = rest.replace(tokRe, (m, reg, str, num, imm) => {
    if (reg) return span('reg', m);
    if (str) return span('str', m);
    if (num || imm) return span('num', m);
    return m;
  });
  out += rest;
  if (cmtPart) out += '<span class="tk-cmt">' + escHtml(cmtPart) + '</span>';
  return out || '&nbsp;';
}

class AsmEditor {
  constructor(container, onChange) {
    this.onChange = onChange;
    this.arch = ARCHES.x86_64;
    this.states = [];
    container.classList.add('asm-editor');
    container.innerHTML =
      '<div class="ed-gutter"><div class="ed-gutter-inner"></div></div>' +
      '<div class="ed-scroll">' +
      '  <pre class="ed-hl" aria-hidden="true"><code></code></pre>' +
      '  <textarea class="ed-input" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off"></textarea>' +
      '</div>';
    this.gutterInner = container.querySelector('.ed-gutter-inner');
    this.gutter = container.querySelector('.ed-gutter');
    this.hl = container.querySelector('.ed-hl');
    this.ta = container.querySelector('.ed-input');

    this.ta.addEventListener('input', () => { this.render(); this.onChange && this.onChange(); });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const s = this.ta.selectionStart, epos = this.ta.selectionEnd;
        this.ta.value = this.ta.value.slice(0, s) + '    ' + this.ta.value.slice(epos);
        this.ta.selectionStart = this.ta.selectionEnd = s + 4;
        this.render(); this.onChange && this.onChange();
      }
    });
  }

  get value() { return this.ta.value; }
  set value(v) { this.ta.value = v; this.render(); }

  setArch(arch) { this.arch = arch; this.render(); }

  /* states: 与源码行对齐的数组；元素 null 或 {cls:'err'|'warn', title} */
  setLineStates(states) { this.states = states || []; this.renderGutter(); }

  syncScroll() {
    this.hl.scrollTop = this.ta.scrollTop;
    this.hl.scrollLeft = this.ta.scrollLeft;
    this.gutter.scrollTop = this.ta.scrollTop;
  }

  refresh() { this.syncScroll(); }

  render() { this.renderHighlight(); this.renderGutter(); }

  renderHighlight() {
    const lines = this.ta.value.split('\n');
    this.hl.firstElementChild.innerHTML = lines.map(l => highlightLine(l, this.arch)).join('\n');
    this.syncScroll();
  }

  renderGutter() {
    const n = this.ta.value.split('\n').length;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const st = this.states[i];
      const cls = 'ed-ln' + (st && st.cls ? ' ed-ln-' + st.cls : '');
      rows.push('<div class="' + cls + '"' + (st && st.title ? ' title="' + escHtml(st.title) + '"' : '') + '>' + (i + 1) + '</div>');
    }
    this.gutterInner.innerHTML = rows.join('');
    this.gutter.scrollTop = this.ta.scrollTop;
  }
}
