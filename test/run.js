/* test/run.js — 测试入口：node test/run.js */
'use strict';

const path = require('path');
const suites = [
  './preproc.test.js',
  './arches.test.js',
  './hexio.test.js',
  './i18n.test.js',
  './assembler.test.js',
  './emu-core.test.js',
];

(async () => {
  let pass = 0, fail = 0;
  const failures = [];
  const t0 = Date.now();
  for (const s of suites) {
    const mod = require(path.join(__dirname, s));
    console.log('\n=== ' + path.basename(s) + ' (' + mod.tests.length + ' tests) ===');
    for (const t of mod.tests) {
      try {
        await t.fn();
        pass++;
        console.log('  ✔ ' + t.name);
      } catch (e) {
        fail++;
        failures.push({ suite: s, name: t.name, err: e });
        console.log('  ✘ ' + t.name);
        console.log('      ' + String(e.message || e).split('\n').join('\n      '));
      }
    }
  }
  const ms = Date.now() - t0;
  console.log('\n──────────────────────────────');
  console.log('通过 ' + pass + ' · 失败 ' + fail + ' · 耗时 ' + ms + 'ms');
  if (fail) {
    process.exit(1);
  }
})().catch(e => { console.error('RUNNER FAIL:', e); process.exit(1); });
