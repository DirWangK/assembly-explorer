/* keystone-worker.js — Keystone 汇编 Worker（含 Capstone 反汇编）
 *
 * 为什么放 Worker：
 *  1. 汇编与反汇编是同步阻塞调用；
 *  2. 供应商 keystone WASM 对个别畸形输入会挂死（已知 "%%%"、"(((( 等连续
 *     运算符/括号序列）——assembler.js 的形状校验拦截了已知模式，但为了
 *     绝对稳定，Worker 宿主还带看门狗：响应超时即终止并重建 Worker，
 *     主线程永不冻结。
 *
 * 协议（入）：
 *   {type:'init'}
 *   {type:'assemble', id, params:{archId, syntax, source, base}}
 * 协议（出）：
 *   {type:'ready'} / {type:'result', id, res}
 */
'use strict';

/* 依赖脚本带上与 Worker 相同的版本参数，避免代理/浏览器缓存住旧实现 */
const VERSION_Q = (function () {
  try {
    const v = new URL(self.location.href).searchParams.get('v');
    return v ? '?v=' + encodeURIComponent(v) : '';
  } catch (e) { return ''; }
})();

let KS = null;

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      /* 依赖顺序：arches/preproc 需在 assembler 之前（UMD 工厂取 self.Preproc/self.ArchesModule） */
      importScripts('../core/arches.js' + VERSION_Q, '../core/preproc.js' + VERSION_Q,
        '../core/assembler.js' + VERSION_Q, '../../vendor/keystone.js');
      /* Worker 内脚本目录推导会指向 /js/，显式把 wasm 定位到 /vendor/ */
      KS = await self.MKeystone({
        locateFile: (f) => new URL('../../vendor/' + f, self.location.href).href,
      });
      self.postMessage({ type: 'ready' });
      return;
    }
    if (m.type === 'assemble') {
      if (!KS) throw new Error('Keystone 未初始化');
      const arch = self.ArchesModule.ARCHES[m.params.archId];
      const res = self.Assembler.assembleSource({
        ksLib: KS, arch, syntax: m.params.syntax,
        source: m.params.source, base: m.params.base,
      });
      self.postMessage({ type: 'result', id: m.id, res });
      return;
    }
  } catch (err) {
    if (m && m.type === 'init') {
      self.postMessage({ type: 'load-error', message: String(err && err.message || err) });
    } else {
      self.postMessage({
        type: 'result', id: m && m.id,
        res: emptyResult(String(err && err.message || err)),
      });
    }
  }
};

function emptyResult(message) {
  return {
    ok: false,
    errors: [{ line: 0, message: '汇编引擎错误: ' + message }],
    segments: [], image: [], codeSegments: [], dataSegments: [],
    symbols: {}, equ: {}, startAddr: 0, untilAddr: 0,
    lineInfo: [], deferredAny: false, totalInsns: 0, totalBytes: 0, cleaned: '',
  };
}
