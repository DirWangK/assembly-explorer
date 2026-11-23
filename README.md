# Assembly Explorer · 汇编实验室

**语言 / Language**: [中文](README.md) | [English](README.en.md)

[![CI](https://github.com/DirWangK/assembly-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/DirWangK/assembly-explorer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-green.svg)](package.json)
[![Live Demo](https://img.shields.io/badge/在线演示-assembly--explorer-blue.svg)](https://37li7xnb4ptdll7m7qw.traesite.cn)

**在线体验**：https://37li7xnb4ptdll7m7qw.traesite.cn （Trae 部署，所有人可见）

浏览器里的多架构汇编实验室（灵感来自 [Compiler Explorer](https://godbolt.org/)）：

```
汇编源码 ──① Keystone──▶ 机器码 ──② Capstone──▶ 反汇编回环验证
                              └──────▶ ③ Unicorn 调试器（步入/步过/断点/暂停）
```

全部引擎编译为 WebAssembly（Emscripten），纯前端运行，无后端。

## 快速开始

```bash
git clone https://github.com/DirWangK/assembly-explorer.git
cd assembly-explorer
npm install        # 安装测试依赖（三个引擎的 npm 构建）
npm test           # 72 项测试：预处理/汇编/调试核心/架构表/i18n
npm start          # 本地静态服务（端口 8899），浏览器打开 http://127.0.0.1:8899
```

无需构建步骤 —— 仓库即站点，克隆后可直接静态部署（任意静态托管均可）。


## 功能

- **三引擎流水线**：Keystone 汇编 → Capstone 回环反汇编 → Unicorn 模拟执行
- **真实调试器**：运行 / 暂停 / 步入 / 步过（自动识别 call 类指令）/ 断点（点击反汇编行）/ 执行轨迹 / 内存访问日志 / syscall 控制台
- **汇编语法支持**：
  - 标签（段内前向/后向引用，由 Keystone 相对解析）
  - 伪指令：`.org` `.align` `.byte` `.short/.word/.long/.quad` `.ascii/.asciz/.string` `.space/.zero` `.equ`（`NAME = EXPR` 亦可），兼容 `.global/.text/.data` 等常见头部
  - 表达式：十六进制/二进制/十进制、字符 `'A'`、`.`（数据段内当前位置）、`+ - * / %` 与括号；数据标签按段内偏移参与表达式（适合 `.equ LEN, . - MSG`）
  - 跨段符号替换：数据标签与 `.equ` 常量整词替换进指令文本
  - 按架构注释：`;` `//` `#` `@` `!`
- **11 种架构**：x86-64 / x86-32 / x86-16(实模式)、ARM A32、Thumb-2、AArch64、MIPS32(大/小端)、MIPS64(小端)、PowerPC32(大端)、SPARC V8(大端)
- **syscall 控制台**：x86-64 `syscall`、x86-32 `int 0x80`、ARM/AArch64 `svc`、MIPS `syscall` 的 write/exit 已接好
- **界面**：深/浅/跟随系统主题、中/英双语、分享链接（编码全部状态到 URL hash）

## 已知引擎限制（均已记录并在 UI 中规避）

- Keystone wasm 对个别畸形输入会挂死：已用字符白名单 + 指令形状校验拦截，且汇编运行在带看门狗的 Worker 中（超时自动重建引擎，主线程永不冻结）
- Unicorn wasm 访问未映射内存会抛 wasm 陷阱：会话在 Worker 中运行，陷阱后自动重建引擎句柄
- Unicorn 的 PPC64 构建初始化即抛 `UC_ERR_EXCEPTION` → 提供 PPC32；MIPS64 下 `sd/ld/dsrl` 等指令异常处理有问题 → 示例仅使用已验证指令
- Keystone 显式 `OPT_SYNTAX_INTEL/NASM` 会把裸数字按十六进制解析 → 默认不设语法选项（十进制基数），仅 AT&T 设置选项

## 开发

```bash
npm install       # 安装测试依赖（三个引擎的 npm 构建）
npm test          # node test/run.js —— 72 个测试：预处理/汇编/调试核心/架构表/i18n
npm start         # 本地静态服务（端口 8899）
```

CI：每次 push/PR 会自动运行语法检查与全量测试（GitHub Actions，Node 20/22 矩阵），状态见顶部徽章。

目录结构：

```
index.html            入口页
css/style.css         双主题样式（design tokens）
js/arches.js          架构定义表（寄存器/模式/示例/注释规则）
js/preproc.js         伪指令预处理（位置计数器/数据段/符号/表达式）
js/assembler.js       汇编流水线核心（多轮布局收敛、逐行诊断、输入防护）
js/session-payload.js 调试会话载荷构建
js/emu-core.js        Unicorn 调试会话核心（步进/断点/暂停/分块恢复）
js/unicorn-worker.js  模拟执行 Worker（会话协议）
js/keystone-worker.js 汇编 Worker（看门狗保护）
js/editor.js          代码编辑器（行号/高亮/错误标记）
js/i18n.js            中英文案
js/main.js            UI 编排
test/                 测试套件（真实引擎 golden 值 + 调试行为）
vendor/               三引擎 WASM 构建与来源说明（ATTRIBUTION.txt）
```

## 许可

本仓库代码 MIT。`vendor/` 中捆绑的引擎遵循其各自许可证（Keystone/Unicorn GPLv2、Capstone BSD-3），详见 `vendor/ATTRIBUTION.txt`。
