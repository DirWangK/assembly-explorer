/* state.js — 共享状态：应用配置 / 调试器状态 / 构建标识
 * 所有 UI 模块通过 AE.state 与 AE.dbg 读写同一份对象（引用不变） */
'use strict';

(function () {
  const AE = window.AE;

  /* Worker 脚本版本：随构建更新，避免浏览器/代理缓存住旧的 Worker 依赖 */
  AE.BUILD = '20261124e';
  AE.MAX_IMPORT_BYTES = 256 * 1024;

  /* 编辑器实例（app.js 启动时创建） */
  AE.editor = null;

  AE.state = {
    archId: 'x86_64',
    syntax: 'intel',
    base: 0x10000,
    maxCount: 200000,
    autoEmu: true,
    theme: 'dark',
    tab: 'src',           // 第 1 栏输入页：'src' 源码 | 'hex' 机器码
    hexDirty: false,      // 机器码文本被手动编辑（此时由机器码驱动流水线）
    hexBytes: null,       // 机器码驱动时的镜像字节数（用于切回源码页的差异审计）
    last: null,           // 最近一次流水线结果（源码或机器码驱动）
    enginePills: { ks: false, cs: false, uc: false },
    loadedExample: null,
  };

  AE.dbg = {
    seq: 0,
    session: null,        // 活动会话 promise 句柄标记
    state: 'idle',        // idle | ready | running | paused | ended | error | pausing
    pc: 0,
    reason: { type: 'init' },
    instrs: 0, ms: 0,
    repIdx: { trace: 0, mem: 0, consoleBytes: 0 },
    traceRows: [],        // 已注解的轨迹行 HTML
    memopsRows: [],
    consoleText: '',
    initRegs: {},         // name -> BigInt（会话启动时的初值）
    breakpoints: new Set(),
    busy: false,
    regions: [],          // 当前会话已映射区域 [[start,end],...]（Worker 回传）
    extraMaps: [],        // 弹窗/手动添加的映射（跨会话保留，重新汇编仍生效）
    extraWrites: [],      // 弹窗/手动写入的数据 [{addr, bytes:number[]}]
  };
})();
