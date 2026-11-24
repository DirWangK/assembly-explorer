/* test/i18n.test.js — 双语文案表完整性 */
'use strict';

const H = require('./helper.js');
const { test, tests } = H.createSuite();
const { assert, assertEq } = H;
const I18N = require('../js/ui/i18n.js');

test('zh/en 键完全一致', () => {
  const zh = Object.keys(I18N.dict.zh).sort();
  const en = Object.keys(I18N.dict.en).sort();
  assertEq(JSON.stringify(zh), JSON.stringify(en), 'key parity');
});

test('键数量合理（> 60）', () => {
  assert(Object.keys(I18N.dict.zh).length > 60, 'enough keys');
});

test('t() 插值与回退', () => {
  I18N.setLang('en');
  assertEq(I18N.t('reason.exit', { code: 0 }), 'exit(0)', 'interpolation');
  assertEq(I18N.t('nonexistent.key'), 'nonexistent.key', 'missing key passthrough');
  I18N.setLang('zh');
  assertEq(I18N.t('reason.exit', { code: 60 }), 'exit(60)', 'zh interpolation');
});

test('切换语言后取值生效', () => {
  I18N.setLang('en');
  assert(I18N.t('btn.run').length > 0, 'run text');
  I18N.setLang('zh');
  assertEq(I18N.t('dbg.state.paused'), '已暂停', 'zh paused');
  I18N.setLang('en');
  assertEq(I18N.t('dbg.state.paused'), 'Paused', 'en paused');
  I18N.setLang('zh');
});
module.exports = { tests };
