# Assembly Explorer

[English](README.en.md) | [中文](README.md)

[![CI](https://github.com/DirWangK/assembly-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/DirWangK/assembly-explorer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-green.svg)](package.json)
[![Live Demo](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E6%BC%94%E7%A4%BA-assembly--explorer-blue.svg)](https://37li7xnb4ptdll7m7qw.traesite.cn)

**Live demo**: https://37li7xnb4ptdll7m7qw.traesite.cn (deployed on Trae, publicly accessible)

A multi-architecture assembly playground in your browser (inspired by [Compiler Explorer](https://godbolt.org/)):

```
Assembly ⇄ Machine code (one input pane, mirrors both ways)
      └─① Keystone─▶ Machine code ──② Capstone──▶ Round-trip disassembly
                              └──────▶ ③ Unicorn debugger (step in/over, breakpoints)
```

All engines are compiled to WebAssembly (Emscripten). Pure frontend, no backend.

## Quick start

```bash
git clone https://github.com/DirWangK/assembly-explorer.git
cd assembly-explorer
npm install        # dev dependencies (npm builds of the three engines)
npm test           # 100 tests: preprocessor / assembler / debug core / hex⇄source / arch table / i18n
npm start          # local static server on port 8899
```

No build step — the repository *is* the site, deployable to any static host.

## Features

- **Three-engine pipeline**: Keystone assembles → Capstone round-trip disassembles → Unicorn emulates
- **One input surface, mirrored both ways**: pane 1 (Keystone) has 源码 / 机器码 tabs that mirror each other —
  - when source is authoritative, the machine-code tab mirrors Keystone's encoded image (with `@data` region markers);
  - pasting/importing hex in the machine-code tab (plain hex, objdump, xxd) disassembles live and rewrites the source tab with re-assemblable source (branch targets become `L_<addr>` labels), keeping the round-trip encoding identical;
  - switching back re-assembles and **audits byte differences in the log** (e.g. engine-inserted delay slots).
- **Code / data regions**: `@code 0x10000` / `@data 0x200000` (or `.org`) mark regions; data is only shown as hex/ASCII and written back as `.byte`/`.ascii` — **never mis-decoded into garbage instructions**. Data-only programs assemble, render and share normally (the debugger explicitly reports "nothing to execute").
- **Bottom log panel**: levels (debug/info/warn/error), module tags (KS/CS/UC/UI), timestamps, auto-scroll, level filter, clear, collapse; records assembly timing/failing lines, engine readiness & worker rebuilds, breakpoints, session stop reasons, hex parse errors, imports and conversions (also mirrored to the devtools console).
- **Real debugger**: run / pause / step in / step over (call-aware) / breakpoints (click a disassembly row) / execution trace / memory-access log / syscall console
- **Assembly syntax**:
  - Labels (forward/backward references within a segment, resolved relatively by Keystone)
  - Directives: `.org` `.align` `.byte` `.short/.word/.long/.quad` `.ascii/.asciz/.string` `.space/.zero` `.equ` (also `NAME = EXPR`); common headers like `.global/.text/.data` are accepted and ignored
  - Expressions: hex/binary/decimal, char `'A'`, `.` (current data offset), `+ - * / %` with parentheses; data labels participate as segment-relative offsets (e.g. `.equ LEN, . - MSG`)
  - Cross-segment symbol substitution: data labels and `.equ` constants are substituted into instruction text
  - Per-architecture comments: `;` `//` `#` `@` `!`
- **11 architectures**: x86-64 / x86-32 / x86-16 (real mode), ARM A32, Thumb-2, AArch64, MIPS32 (BE/LE), MIPS64 (LE), PowerPC32 (BE), SPARC V8 (BE)
- **syscall console**: x86-64 `syscall`, x86-32 `int 0x80`, ARM/AArch64 `svc`, MIPS `syscall` — `write`/`exit` wired up
- **UI**: dark/light/system themes, Chinese/English UI, share links (full state in the URL hash, including the machine-code tab), bottom log panel

## Known engine limitations (documented and worked around in the UI)

- Keystone wasm hangs on a few malformed inputs: blocked by a character whitelist + instruction-shape validation, and assembly runs in a watchdog-guarded Worker (the engine is rebuilt on timeout; the main thread never freezes)
- Unicorn wasm throws on unmapped memory access: sessions run in a Worker and the engine handle is rebuilt automatically after a trap
- Unicorn's PPC64 build throws `UC_ERR_EXCEPTION` on init → PPC32 is provided; MIPS64 has broken exception handling for `sd/ld/dsrl` etc. → examples only use verified instructions
- Keystone's explicit `OPT_SYNTAX_INTEL/NASM` parses bare numbers as hex → no syntax option is set by default (decimal radix); only AT&T sets an option

## Development

```bash
npm install       # install test dependencies (npm builds of the three engines)
npm test          # node test/run.js — 100 tests: preprocessor / assembler / debug core / hex⇄source / arch table / i18n
npm start         # local static server on port 8899
```

CI: every push/PR runs the syntax check and the full test suite (GitHub Actions, Node 20/22 matrix) — status in the badge above.

## Project layout

```
index.html            entry page
css/style.css         dual-theme styles (design tokens)
js/arches.js          architecture table (registers/modes/examples/comment rules)
js/preproc.js         directive preprocessor (location counter/data segments/symbols/expressions)
js/assembler.js       assembly pipeline core (multi-pass layout convergence, line diagnostics, input hardening)
js/hexio.js           machine-code text parser (@code/@data regions) + image→source generation
js/applog.js          bottom log panel (levels/filter/collapse)
js/session-payload.js debug-session payload builder
js/emu-core.js        Unicorn debug-session core (stepping/breakpoints/pause/chunked resume)
js/unicorn-worker.js  emulation Worker (session protocol)
js/keystone-worker.js assembly Worker (watchdog protected)
js/editor.js          code editor (line numbers/highlighting/error marks)
js/i18n.js            UI strings (zh/en)
js/main.js            UI orchestration
test/                 test suite (real-engine golden values + debugger behavior)
vendor/               bundled WASM engine builds & provenance (ATTRIBUTION.txt)
```

## License

This repository's code is MIT. The bundled engines under `vendor/` follow their own licenses (Keystone/Unicorn GPLv2, Capstone BSD-3) — see `vendor/ATTRIBUTION.txt`.
