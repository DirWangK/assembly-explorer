# Assembly Explorer · 汇编实验室

**语言 / Language**: [中文](README.md) | [English](README.en.md)

[![CI](https://github.com/DirWangK/assembly-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/DirWangK/assembly-explorer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-green.svg)](package.json)
[![Live Demo](https://img.shields.io/badge/在线演示-assembly--explorer-blue.svg)](https://37li7xnb4ptdll7m7qw.traesite.cn)

**在线体验**：https://37li7xnb4ptdll7m7qw.traesite.cn （Trae 部署，所有人可见）

浏览器里的多架构汇编实验室（自研：聚焦汇编 ⇄ 机器码 ⇄ 模拟执行）：

```
汇编源码 ⇄ 机器码（同一输入面板，双向实时同步）
      └─① Keystone─▶ 机器码 ──② Capstone──▶ 反汇编回环验证
                              └──────▶ ③ Unicorn 调试器（步入/步过/断点/暂停）
```

全部引擎编译为 WebAssembly（Emscripten），纯前端运行，无后端。

## 快速开始

```bash
git clone https://github.com/DirWangK/assembly-explorer.git
cd assembly-explorer
npm install        # 安装测试依赖（三个引擎的 npm 构建）
npm test           # 100 项测试：预处理/汇编/调试核心/机器码⇄源码/架构表/i18n
npm start          # 本地静态服务（端口 8899），浏览器打开 http://127.0.0.1:8899
```

无需构建步骤 —— 仓库即站点，克隆后可直接静态部署（任意静态托管均可）。


## 功能

- **三引擎流水线**：Keystone 汇编 → Capstone 回环反汇编 → Unicorn 模拟执行
- **单一输入面 + 双向同步**：第 1 栏（Keystone）内分「源码 / 机器码」两页，互为镜像 ——
  - 源码页是权威输入时，机器码页自动镜像 Keystone 的编码产物（含 `@data` 分区标记）；
  - 在机器码页粘贴/导入 hex（支持纯 hex、objdump、xxd 转储），实时反汇编且源码页同步生成可再汇编的源码（分支目标自动转 `L_<addr>` 标签），编码往返一致；
  - 切回源码页会重新汇编并**在日志中审计字节差异**（如引擎自动补延迟槽）。
- **代码 / 数据分区**：`@code 0x10000` / `@data 0x200000`（或 `.org`）标记区域；数据区只做 hex/ASCII 展示与 `.byte`/`.ascii` 回写，**绝不被误解码成垃圾指令**；纯数据程序也能正常汇编、展示与分享（调试器会明确提示"无可执行指令"）
- **底部日志面板**：分级（debug/info/warn/error）、模块标签（KS/CS/UC/UI）、时间戳、跟随滚动、级别过滤、清空、折叠；汇编耗时/错误行、引擎就绪与重建、断点、会话结束原因、机器码解析错误、导入与转换动作都会记录（也同步到 devtools 控制台）
- **真实调试器**：运行 / 暂停 / 步入 / 步过（自动识别 call 类指令）/ 断点（点击反汇编行）/ 执行轨迹 / 内存访问日志 / syscall 控制台；任意状态下单步会自动从入口载入暂停会话（无需先停止），停止会真正结束会话并清空调试视图，程序变更时自动重建会话避免数据过期
- **内存故障引导**：运行中访问未映射地址时，引擎在故障指令处安全暂停并弹窗——可映射 4 KiB–16 MiB 内存页、导入文件或粘贴 HEX/文本；补齐后原地继续（引擎不重建）。调试栏「内存」按钮可随时手动映射
- **汇编语法支持**：
  - 标签（段内前向/后向引用，由 Keystone 相对解析）
  - 伪指令：`.org` `.align` `.byte` `.short/.word/.long/.quad` `.ascii/.asciz/.string` `.space/.zero` `.equ`（`NAME = EXPR` 亦可），兼容 `.global/.text/.data` 等常见头部
  - 表达式：十六进制/二进制/十进制、字符 `'A'`、`.`（数据段内当前位置）、`+ - * / %` 与括号；数据标签按段内偏移参与表达式（适合 `.equ LEN, . - MSG`）
  - 跨段符号替换：数据标签与 `.equ` 常量整词替换进指令文本
  - 按架构注释：`;` `//` `#` `@` `!`
- **11 种架构**：x86-64 / x86-32 / x86-16(实模式)、ARM A32、Thumb-2、AArch64、MIPS32(大/小端)、MIPS64(小端)、PowerPC32(大端)、SPARC V8(大端)
- **syscall 控制台**：x86-64 `syscall`、x86-32 `int 0x80`、ARM/AArch64 `svc`、MIPS `syscall` 的 write/exit 已接好
- **界面**：深/浅/跟随系统主题、中/英双语、分享链接（状态编码进 URL hash，含机器码页内容）、底部日志面板、三引擎并行加载进度条（Capstone / Keystone / Unicorn）

## 引擎限制与处理策略

- Unicorn 访问未映射内存：通过 `UC_HOOK_MEM_UNMAPPED` 在故障指令处安全暂停，弹窗引导映射内存页 / 导入文件 / 粘贴 HEX 或文本，补齐后原地继续（引擎不重建）。取指故障会提示写入完整可执行代码；若钩子未覆盖而触发 wasm 陷阱，则自动重建引擎并在弹窗中手动补映射
- Keystone wasm 对个别畸形输入会挂死：已用字符白名单 + 指令形状校验拦截，且汇编运行在带看门狗的 Worker 中（超时自动重建引擎，主线程永不冻结）
- Unicorn 的 PPC64 构建初始化即抛 `UC_ERR_EXCEPTION` → 提供 PPC32；MIPS64 下 `sd/ld/dsrl` 等指令异常处理有问题 → 示例仅使用已验证指令
- Keystone 显式 `OPT_SYNTAX_INTEL/NASM` 会把裸数字按十六进制解析 → 默认不设语法选项（十进制基数），仅 AT&T 设置选项

## 开发

```bash
npm install       # 安装测试依赖（三个引擎的 npm 构建）
npm test          # node test/run.js —— 103 个测试：预处理/汇编/调试核心/机器码⇄源码/架构表/i18n
npm start         # 本地静态服务（端口 8899）
```

CI：每次 push/PR 会自动运行语法检查与全量测试（GitHub Actions，Node 20/22 矩阵），状态见顶部徽章。

目录结构：

```
index.html                入口页（按顺序加载脚本，无构建步骤）
css/
  tokens.css              设计令牌：深/浅主题色板、字体栈
  base.css                基础：盒模型、页面骨架、滚动条、选区
  layout.css              布局：顶栏、三栏网格、页脚、响应式
  components.css          组件：按钮/徽标/编辑器/列表/输入视图/日志面板/toast
js/
  core/                   纯逻辑层（UMD，浏览器、Worker、Node 测试共用）
    arches.js             架构定义表（寄存器/模式/示例/注释规则）
    preproc.js            伪指令预处理（位置计数器/数据段/符号/表达式）
    assembler.js          汇编流水线核心（多轮布局收敛、逐行诊断、输入防护）
    hexio.js              机器码文本解析（@code/@data 分区）与镜像→源码生成
    session-payload.js    调试会话载荷构建
    emu-core.js           Unicorn 调试会话核心（步进/断点/暂停/分块恢复）
  workers/                Web Worker（importScripts 加载 core）
    keystone-worker.js    汇编 Worker（看门狗保护）
    unicorn-worker.js     模拟执行 Worker（会话协议）
  ui/                    DOM 编排层（命名空间 AE.*，单向依赖）
    i18n.js               中英文案
    dom.js                选择器/转义/格式化/防抖/toast
    state.js              共享状态（应用配置、调试器）与构建标识
    log.js                底部日志面板（分级/过滤/折叠）
    engines.js            Capstone 缓存与 Keystone/Unicorn Worker 宿主
    editor.js             代码编辑器（行号/高亮/错误标记）
    output.js             第 2 栏渲染（hex dump / 反汇编 / 数据段）
    debugger.js           第 3 栏：会话、寄存器、轨迹、断点、单步
    memfault.js           未映射内存引导弹窗（映射页/导入文件/粘贴数据）
    input.js              第 1 栏：源码⇄机器码双页与流水线入口
    prefs.js              主题/语言/架构/基址/分享链接
    app.js                装配与启动
test/                     测试套件（真实引擎 golden 值 + 调试行为）
vendor/                   三引擎 WASM 构建与来源说明（ATTRIBUTION.txt）
```

分层约定（零构建）：

- `core/` 不触碰 DOM，可被 Node 测试直接 `require`，也可被 Worker `importScripts`；
- `ui/` 只通过 `window.AE` 下的命名空间协作，加载顺序即依赖顺序（见 `index.html` 末尾）；
- 状态只有一份（`AE.state` / `AE.dbg`），模块之间不复制状态，只传递引用。

## 许可

本仓库代码 MIT。`vendor/` 中捆绑的引擎遵循其各自许可证（Keystone/Unicorn GPLv2、Capstone BSD-3），详见 `vendor/ATTRIBUTION.txt`。
