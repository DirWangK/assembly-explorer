/* arches.js — 架构定义表（主线程与 Unicorn Worker 共用）
 * 数据来源：Keystone/Capstone/Unicorn 常量名（@alexaltea/*-js WASM 构建）
 */
'use strict';

/* 内存布局约定（除 x86-16 外通用）
 *  CODE    [base, base+0x10000)      代码区，base 默认 0x10000
 *  STACK   [0x7e0000, 0x800000)      128 KiB 栈区，初始 SP = 0x7ff000
 *  SCRATCH [0x200000, 0x210000)      数据区，预填 "Hello, WASM!\n"
 */
const COMMON_LAYOUT = {
  stackBase: 0x7e0000, stackSize: 0x20000, spInit: 0x7ff000,
  scratchBase: 0x200000, scratchSize: 0x10000,
};

const ARCHES = {
  x86_64: {
    id: 'x86_64', label: 'x86-64', group: 'x86', width: 8,
    ks: { arch: 'ARCH_X86', modes: ['MODE_64'] },
    cs: { arch: 'ARCH_X86', modes: ['MODE_64'] },
    uc: { file: 'x86', arch: 'ARCH_X86', modes: ['MODE_64'] },
    layout: COMMON_LAYOUT,
    regs: [
      ['RAX', 'X86_REG_RAX'], ['RBX', 'X86_REG_RBX'], ['RCX', 'X86_REG_RCX'], ['RDX', 'X86_REG_RDX'],
      ['RSI', 'X86_REG_RSI'], ['RDI', 'X86_REG_RDI'], ['RBP', 'X86_REG_RBP'], ['RSP', 'X86_REG_RSP'],
      ['R8', 'X86_REG_R8'], ['R9', 'X86_REG_R9'], ['R10', 'X86_REG_R10'], ['R11', 'X86_REG_R11'],
      ['R12', 'X86_REG_R12'], ['R13', 'X86_REG_R13'], ['R14', 'X86_REG_R14'], ['R15', 'X86_REG_R15'],
    ],
    pc: ['RIP', 'X86_REG_RIP'], flags: ['RFLAGS', 'X86_REG_RFLAGS'],
    spReg: ['RSP', 'X86_REG_RSP'], spAliases: ['rsp', 'sp'], pcAliases: ['rip', 'pc'],
    comments: [';', '/*', '*/', '//'],
    /* 注意：keystone 在显式 OPT_SYNTAX_INTEL/NASM 下将裸数字按十六进制解析；
     * 空数组 = 不设置语法选项（默认 Intel + 十进制基数，行为最直观）。 */
    syntaxes: { intel: [], att: ['OPT_SYNTAX_ATT'] },
    callLike: ['call', 'callq'],
    branchLike: ['jmp', 'je', 'jne', 'jz', 'jnz', 'ja', 'jae', 'jb', 'jbe', 'jg', 'jge', 'jl', 'jle', 'js', 'jns', 'jo', 'jno', 'jp', 'jnp', 'jc', 'jnc', 'loop', 'loope', 'loopne', 'jecxz', 'jrcxz'],
    syscall: 'x86_64',
    example: [
      '; Linux x86-64 ABI：write(1, msg, 13) 后 exit(0)',
      '; 数据用 .org/.ascii 伪指令在源码内定义（真实汇编写法）',
      '.equ    SYS_WRITE, 1',
      '.equ    SYS_EXIT,  60',
      '.equ    STDOUT,    1',
      '',
      '_start:',
      '        mov     rax, SYS_WRITE',
      '        mov     rdi, STDOUT',
      '        mov     rsi, MSG        ; 数据段里的字符串地址',
      '        mov     rdx, MSG_LEN',
      '        syscall',
      '',
      '        mov     rax, SYS_EXIT',
      '        xor     rdi, rdi',
      '        syscall',
      '',
      '; ---- 只读数据段 ----',
      '.org    0x200000',
      'MSG:    .ascii  "Hello, WASM!\\n"',
      '        .equ    MSG_LEN, . - MSG',
    ].join('\n'),
  },
  x86_32: {
    id: 'x86_32', label: 'x86-32', group: 'x86', width: 4,
    ks: { arch: 'ARCH_X86', modes: ['MODE_32'] },
    cs: { arch: 'ARCH_X86', modes: ['MODE_32'] },
    uc: { file: 'x86', arch: 'ARCH_X86', modes: ['MODE_32'] },
    layout: COMMON_LAYOUT,
    regs: [
      ['EAX', 'X86_REG_EAX'], ['EBX', 'X86_REG_EBX'], ['ECX', 'X86_REG_ECX'], ['EDX', 'X86_REG_EDX'],
      ['ESI', 'X86_REG_ESI'], ['EDI', 'X86_REG_EDI'], ['EBP', 'X86_REG_EBP'], ['ESP', 'X86_REG_ESP'],
    ],
    pc: ['EIP', 'X86_REG_EIP'], flags: ['EFLAGS', 'X86_REG_EFLAGS'],
    spReg: ['ESP', 'X86_REG_ESP'], spAliases: ['esp', 'sp'], pcAliases: ['eip', 'ip', 'pc'],
    comments: [';', '/*', '*/', '//'],
    syntaxes: { intel: [], att: ['OPT_SYNTAX_ATT'] },
    callLike: ['call', 'callq'],
    branchLike: ['jmp', 'je', 'jne', 'jz', 'jnz', 'ja', 'jae', 'jb', 'jbe', 'jg', 'jge', 'jl', 'jle', 'js', 'jns', 'jo', 'jno', 'jp', 'jnp', 'jc', 'jnc', 'loop', 'loope', 'loopne', 'jecxz', 'jcxz'],
    syscall: 'x86_32',
    example: [
      '; Linux i386 ABI：int 0x80',
      '.equ    SYS_WRITE, 4',
      '.equ    SYS_EXIT,  1',
      '',
      '_start:',
      '        mov     eax, SYS_WRITE',
      '        mov     ebx, 1',
      '        mov     ecx, MSG',
      '        mov     edx, MSG_LEN',
      '        int     0x80',
      '',
      '        mov     eax, SYS_EXIT',
      '        xor     ebx, ebx',
      '        int     0x80',
      '',
      '; ---- 只读数据段 ----',
      '.org    0x200000',
      'MSG:    .ascii  "Hello, WASM!\\n"',
      '        .equ    MSG_LEN, . - MSG',
    ].join('\n'),
  },
  x86_16: {
    id: 'x86_16', label: 'x86-16 (实模式)', group: 'x86', width: 2,
    ks: { arch: 'ARCH_X86', modes: ['MODE_16'] },
    cs: { arch: 'ARCH_X86', modes: ['MODE_16'] },
    uc: { file: 'x86', arch: 'ARCH_X86', modes: ['MODE_16'] },
    layout: { single: true, regions: [{ addr: 0, size: 0x10000 }], spInit: 0xf000, scratchBase: 0x8000 },
    regs: [
      ['AX', 'X86_REG_AX'], ['BX', 'X86_REG_BX'], ['CX', 'X86_REG_CX'], ['DX', 'X86_REG_DX'],
      ['SI', 'X86_REG_SI'], ['DI', 'X86_REG_DI'], ['BP', 'X86_REG_BP'], ['SP', 'X86_REG_SP'],
    ],
    pc: ['IP', 'X86_REG_IP'], flags: ['FLAGS', 'X86_REG_FLAGS'],
    spReg: ['SP', 'X86_REG_SP'], spAliases: ['sp'], pcAliases: ['ip', 'pc'],
    comments: [';', '/*', '*/', '//'],
    syntaxes: { intel: [], att: ['OPT_SYNTAX_ATT'] },
    callLike: ['call', 'callq'],
    branchLike: ['jmp', 'je', 'jne', 'jz', 'jnz', 'ja', 'jae', 'jb', 'jbe', 'jg', 'jge', 'jl', 'jle', 'js', 'jns', 'jo', 'jno', 'jp', 'jnp', 'jc', 'jnc', 'loop', 'loope', 'loopne', 'jcxz'],
    syscall: null,
    example: [
      '; 实模式：内存读写往返（写入后读回，不依赖预填数据）',
      '        mov     ax, 0x1234',
      '        mov     bx, 0x0040      ; 缓冲区地址（见下方 .org）',
      '        mov     [bx], ax',
      '        xor     ax, ax',
      '        mov     ax, [bx]        ; 读回 0x1234',
      '        add     ax, 2           ; AX = 0x1236',
      '',
      '; ---- 数据缓冲区 ----',
      '.org    0x40',
      'buf:    .space  16',
    ].join('\n'),
  },
  arm: {
    id: 'arm', label: 'ARM (A32)', group: 'arm', width: 4,
    ks: { arch: 'ARCH_ARM', modes: ['MODE_ARM'] },
    cs: { arch: 'ARCH_ARM', modes: ['MODE_ARM'] },
    uc: { file: 'arm', arch: 'ARCH_ARM', modes: ['MODE_ARM'] },
    layout: COMMON_LAYOUT,
    regs: [
      ['R0', 'ARM_REG_R0'], ['R1', 'ARM_REG_R1'], ['R2', 'ARM_REG_R2'], ['R3', 'ARM_REG_R3'],
      ['R4', 'ARM_REG_R4'], ['R5', 'ARM_REG_R5'], ['R6', 'ARM_REG_R6'], ['R7', 'ARM_REG_R7'],
      ['R8', 'ARM_REG_R8'], ['R9', 'ARM_REG_R9'], ['R10', 'ARM_REG_R10'], ['R11', 'ARM_REG_R11'],
      ['R12', 'ARM_REG_R12'],
    ],
    pc: ['PC', 'ARM_REG_PC'], flags: ['CPSR', 'ARM_REG_CPSR'],
    spReg: ['SP', 'ARM_REG_SP'], spAliases: ['sp', 'r13'], pcAliases: ['pc', 'r15'],
    thumb: false,
    comments: [';', '@', '/*', '*/', '//'],
    callLike: ['bl', 'blx'],
    branchLike: ['b', 'bl', 'bx', 'blx', 'beq', 'bne', 'bcs', 'bhs', 'bcc', 'blo', 'bmi', 'bpl', 'bvs', 'bvc', 'bhi', 'bls', 'bge', 'blt', 'bgt', 'ble', 'bal'],
    syscall: 'arm',
    example: [
      '@ ARM A32：10+9+…+1 = 55，写入数据段后读回验证',
      '.equ    RESULT, 0x200000',
      '',
      '_start:',
      '        mov     r0, #0',
      '        mov     r1, #10',
      'loop:',
      '        add     r0, r0, r1',
      '        subs    r1, r1, #1',
      '        bne     loop',
      '',
      '        mov     r2, #RESULT',
      '        str     r0, [r2]',
      '        ldr     r3, [r2]        ; R3 = 55',
    ].join('\n'),
  },
  thumb: {
    id: 'thumb', label: 'ARM (Thumb-2)', group: 'arm', width: 4,
    ks: { arch: 'ARCH_ARM', modes: ['MODE_THUMB'] },
    cs: { arch: 'ARCH_ARM', modes: ['MODE_THUMB'] },
    uc: { file: 'arm', arch: 'ARCH_ARM', modes: ['MODE_THUMB'] },
    layout: COMMON_LAYOUT,
    regs: [
      ['R0', 'ARM_REG_R0'], ['R1', 'ARM_REG_R1'], ['R2', 'ARM_REG_R2'], ['R3', 'ARM_REG_R3'],
      ['R4', 'ARM_REG_R4'], ['R5', 'ARM_REG_R5'], ['R6', 'ARM_REG_R6'], ['R7', 'ARM_REG_R7'],
      ['R8', 'ARM_REG_R8'], ['R9', 'ARM_REG_R9'], ['R10', 'ARM_REG_R10'], ['R11', 'ARM_REG_R11'],
      ['R12', 'ARM_REG_R12'],
    ],
    pc: ['PC', 'ARM_REG_PC'], flags: ['CPSR', 'ARM_REG_CPSR'],
    spReg: ['SP', 'ARM_REG_SP'], spAliases: ['sp', 'r13'], pcAliases: ['pc', 'r15'],
    thumb: true,
    comments: [';', '@', '/*', '*/', '//'],
    callLike: ['bl', 'blx'],
    branchLike: ['b', 'bl', 'bx', 'blx', 'beq', 'bne', 'bcs', 'bhs', 'bcc', 'blo', 'bmi', 'bpl', 'bvs', 'bvc', 'bhi', 'bls', 'bge', 'blt', 'bgt', 'ble', 'bal'],
    syscall: 'arm',
    example: [
      '        movs    r0, #6',
      '        adds    r0, #3          ; R0 = 9',
      '        lsls    r0, r0, #2      ; R0 = 36',
    ].join('\n'),
  },
  arm64: {
    id: 'arm64', label: 'AArch64 (ARM64)', group: 'arm', width: 8,
    ks: { arch: 'ARCH_ARM64', modes: [] },
    cs: { arch: 'ARCH_ARM64', modes: [] },
    uc: { file: 'aarch64', arch: 'ARCH_ARM64', modes: [] },
    layout: COMMON_LAYOUT,
    regs: [
      ['X0', 'ARM64_REG_X0'], ['X1', 'ARM64_REG_X1'], ['X2', 'ARM64_REG_X2'], ['X3', 'ARM64_REG_X3'],
      ['X4', 'ARM64_REG_X4'], ['X5', 'ARM64_REG_X5'], ['X6', 'ARM64_REG_X6'], ['X7', 'ARM64_REG_X7'],
      ['X8', 'ARM64_REG_X8'], ['X9', 'ARM64_REG_X9'], ['X10', 'ARM64_REG_X10'], ['X11', 'ARM64_REG_X11'],
      ['X12', 'ARM64_REG_X12'], ['X13', 'ARM64_REG_X13'], ['X14', 'ARM64_REG_X14'], ['X15', 'ARM64_REG_X15'],
    ],
    pc: ['PC', 'ARM64_REG_PC'], flags: ['NZCV', 'ARM64_REG_NZCV'],
    spReg: ['SP', 'ARM64_REG_SP'], spAliases: ['sp'], pcAliases: ['pc'],
    comments: [';', '@', '/*', '*/', '//'],
    callLike: ['bl'],
    branchLike: ['b', 'bl', 'b.eq', 'b.ne', 'b.cs', 'b.hs', 'b.cc', 'b.lo', 'b.mi', 'b.pl', 'b.vs', 'b.vc', 'b.hi', 'b.ls', 'b.ge', 'b.lt', 'b.gt', 'b.le', 'b.al', 'cbz', 'cbnz', 'tbz', 'tbnz'],
    syscall: 'arm64',
    example: [
      '; AArch64：乘法结果写入数据段后读回验证',
      '.equ    RESULT, 0x200000',
      '',
      '_start:',
      '        mov     x0, #100',
      '        mov     x1, #7',
      '        mul     x2, x0, x1      ; X2 = 700',
      '        mov     x3, #RESULT',
      '        str     x2, [x3]',
      '        ldr     x4, [x3]        ; X4 = 700',
    ].join('\n'),
  },
  mips32el: {
    id: 'mips32el', label: 'MIPS32 (小端)', group: 'mips', width: 4,
    ks: { arch: 'ARCH_MIPS', modes: ['MODE_MIPS32'] },
    cs: { arch: 'ARCH_MIPS', modes: ['MODE_MIPS32'] },
    uc: { file: 'mips', arch: 'ARCH_MIPS', modes: ['MODE_MIPS32'] },
    layout: COMMON_LAYOUT,
    regs: [
      ['V0', 'MIPS_REG_V0'], ['V1', 'MIPS_REG_V1'],
      ['A0', 'MIPS_REG_A0'], ['A1', 'MIPS_REG_A1'], ['A2', 'MIPS_REG_A2'], ['A3', 'MIPS_REG_A3'],
      ['T0', 'MIPS_REG_T0'], ['T1', 'MIPS_REG_T1'], ['T2', 'MIPS_REG_T2'], ['T3', 'MIPS_REG_T3'],
      ['S0', 'MIPS_REG_S0'], ['S1', 'MIPS_REG_S1'], ['S2', 'MIPS_REG_S2'], ['S3', 'MIPS_REG_S3'],
      ['HI', 'MIPS_REG_HI'], ['LO', 'MIPS_REG_LO'],
    ],
    pc: ['PC', 'MIPS_REG_PC'],
    spReg: ['SP', 'MIPS_REG_SP'], spAliases: ['sp', '$sp'], pcAliases: ['pc'],
    comments: ['#', ';', '/*', '*/', '//'],
    callLike: ['jal', 'jalr', 'bal', 'bl', 'jirl'],
    branchLike: ['b', 'beq', 'bne', 'blez', 'bgtz', 'bltz', 'bgez', 'bltzal', 'bgezal', 'j', 'jal', 'beqzl', 'bnel'],
    syscall: 'mips',
    example: [
      '# MIPS32 o32 ABI：write(1, msg, 13) 后 exit(0)',
      '# $v0=4 → write($a0,$a1,$a2)；$v0=1 → exit($a0)',
      '',
      '_start:',
      '        lui     $a1, 0x20       # $a1 = 0x200000',
      '        addiu   $a2, $zero, 13',
      '        addiu   $v0, $zero, 4   # SYS_write',
      '        syscall',
      '        addiu   $v0, $zero, 1   # SYS_exit',
      '        syscall',
      '',
      '# ---- 只读数据段 ----',
      '.org    0x200000',
      'MSG:    .ascii  "Hello, MIPS!\\n"',
    ].join('\n'),
  },
  mips32be: {
    id: 'mips32be', label: 'MIPS32 (大端)', group: 'mips', width: 4,
    ks: { arch: 'ARCH_MIPS', modes: ['MODE_MIPS32', 'MODE_BIG_ENDIAN'] },
    cs: { arch: 'ARCH_MIPS', modes: ['MODE_MIPS32', 'MODE_BIG_ENDIAN'] },
    uc: { file: 'mips', arch: 'ARCH_MIPS', modes: ['MODE_MIPS32', 'MODE_BIG_ENDIAN'] },
    layout: COMMON_LAYOUT,
    regs: null, // 与 mips32el 相同，加载时引用
    pc: ['PC', 'MIPS_REG_PC'],
    spReg: ['SP', 'MIPS_REG_SP'], spAliases: ['sp', '$sp'], pcAliases: ['pc'],
    comments: ['#', ';', '/*', '*/', '//'],
    callLike: ['jal', 'jalr', 'bal', 'bl', 'jirl'],
    branchLike: ['b', 'beq', 'bne', 'blez', 'bgtz', 'bltz', 'bgez', 'bltzal', 'bgezal', 'j', 'jal', 'beqzl', 'bnel'],
    syscall: 'mips',
    example: [
      '# MIPS32 大端：write(1, msg, 13) 后 exit(0)',
      '_start:',
      '        lui     $a1, 0x20',
      '        addiu   $a2, $zero, 13',
      '        addiu   $v0, $zero, 4   # SYS_write',
      '        syscall',
      '        addiu   $v0, $zero, 1   # SYS_exit',
      '        syscall',
      '',
      '# ---- 只读数据段 ----',
      '.org    0x200000',
      'MSG:    .ascii  "Hello, MIPS!\\n"',
    ].join('\n'),
  },
  mips64el: {
    id: 'mips64el', label: 'MIPS64 (小端)', group: 'mips', width: 8,
    ks: { arch: 'ARCH_MIPS', modes: ['MODE_MIPS64'] },
    cs: { arch: 'ARCH_MIPS', modes: ['MODE_MIPS64'] },
    uc: { file: 'mips', arch: 'ARCH_MIPS', modes: ['MODE_MIPS64'] },
    layout: COMMON_LAYOUT,
    regs: [
      ['V0', 'MIPS_REG_V0'], ['V1', 'MIPS_REG_V1'],
      ['A0', 'MIPS_REG_A0'], ['A1', 'MIPS_REG_A1'], ['A2', 'MIPS_REG_A2'], ['A3', 'MIPS_REG_A3'],
      ['T0', 'MIPS_REG_T0'], ['T1', 'MIPS_REG_T1'], ['T2', 'MIPS_REG_T2'], ['T3', 'MIPS_REG_T3'],
      ['S0', 'MIPS_REG_S0'], ['S1', 'MIPS_REG_S1'], ['S2', 'MIPS_REG_S2'], ['S3', 'MIPS_REG_S3'],
      ['HI', 'MIPS_REG_HI'], ['LO', 'MIPS_REG_LO'],
    ],
    pc: ['PC', 'MIPS_REG_PC'],
    spReg: ['SP', 'MIPS_REG_SP'], spAliases: ['sp', '$sp'], pcAliases: ['pc'],
    comments: ['#', ';', '/*', '*/', '//'],
    callLike: ['jal', 'jalr', 'bal', 'bl', 'jirl'],
    branchLike: ['b', 'beq', 'bne', 'blez', 'bgtz', 'bltz', 'bgez', 'j', 'jal'],
    syscall: 'mips',
    example: [
      '# MIPS64：64 位运算',
      '# 注：该 Unicorn 构建的 MIPS64 下 sd/ld/dsrl 等指令有已知问题，示例使用已验证的指令',
      '.equ    NUM, 7',
      '',
      '_start:',
      '        daddiu  $v0, $zero, 5',
      '        daddiu  $v1, $zero, NUM',
      '        daddu   $a0, $v0, $v1   # 12',
      '        dsll    $a1, $a0, 3     # 96',
    ].join('\n'),
  },
  /* 注：Unicorn 的 PPC64 WASM 构建在 uc_emu_start 抛 UC_ERR_EXCEPTION（CPU 初始化缺陷），
   * 因此菜单提供可正常模拟的 PPC32 大端。 */
  ppc32be: {
    id: 'ppc32be', label: 'PowerPC32 (大端)', group: 'ppc', width: 4,
    ks: { arch: 'ARCH_PPC', modes: ['MODE_PPC32', 'MODE_BIG_ENDIAN'] },
    cs: { arch: 'ARCH_PPC', modes: ['MODE_PPC32', 'MODE_BIG_ENDIAN'] },
    uc: { file: 'ppc', arch: 'ARCH_PPC', modes: ['MODE_PPC32', 'MODE_BIG_ENDIAN'] },
    layout: COMMON_LAYOUT,
    regs: [
      ['R0', 'PPC_REG_0'], ['R1', 'PPC_REG_1'], ['R2', 'PPC_REG_2'], ['R3', 'PPC_REG_3'],
      ['R4', 'PPC_REG_4'], ['R5', 'PPC_REG_5'], ['R6', 'PPC_REG_6'], ['R7', 'PPC_REG_7'],
      ['R8', 'PPC_REG_8'], ['R9', 'PPC_REG_9'], ['R10', 'PPC_REG_10'], ['R11', 'PPC_REG_11'],
      ['R12', 'PPC_REG_12'], ['R13', 'PPC_REG_13'], ['R14', 'PPC_REG_14'], ['R15', 'PPC_REG_15'],
      ['LR', 'PPC_REG_LR'], ['CTR', 'PPC_REG_CTR'],
    ],
    pc: ['PC', 'PPC_REG_PC'], flags: ['CR', 'PPC_REG_CR'],
    spReg: ['R1', 'PPC_REG_1'], spAliases: ['r1'], pcAliases: ['pc'],
    comments: ['#', ';', '/*', '*/', '//'],
    callLike: ['bl'],
    branchLike: ['b', 'bl', 'ba', 'blt', 'ble', 'bgt', 'bge', 'beq', 'bne', 'bdz', 'bclr', 'bctr'],
    syscall: null,
    example: [
      'li      3, 5',
      'li      4, 7',
      'add     5, 3, 4         ; R5 = 12',
      'mullw   6, 3, 4         ; R6 = 35',
    ].join('\n'),
  },
  sparc32be: {
    id: 'sparc32be', label: 'SPARC V8 (大端)', group: 'sparc', width: 4,
    ks: { arch: 'ARCH_SPARC', modes: ['MODE_SPARC32', 'MODE_BIG_ENDIAN'] },
    cs: { arch: 'ARCH_SPARC', modes: ['MODE_SPARC32', 'MODE_BIG_ENDIAN'] },
    uc: { file: 'sparc', arch: 'ARCH_SPARC', modes: ['MODE_SPARC32', 'MODE_BIG_ENDIAN'] },
    layout: COMMON_LAYOUT,
    regs: [
      ['G1', 'SPARC_REG_G1'], ['G2', 'SPARC_REG_G2'], ['G3', 'SPARC_REG_G3'], ['G4', 'SPARC_REG_G4'],
      ['G5', 'SPARC_REG_G5'], ['G6', 'SPARC_REG_G6'], ['G7', 'SPARC_REG_G7'],
      ['O0', 'SPARC_REG_O0'], ['O1', 'SPARC_REG_O1'], ['O2', 'SPARC_REG_O2'], ['O3', 'SPARC_REG_O3'],
      ['O4', 'SPARC_REG_O4'], ['O5', 'SPARC_REG_O5'], ['SP', 'SPARC_REG_SP'], ['O7', 'SPARC_REG_O7'],
    ],
    pc: ['PC', 'SPARC_REG_PC'], flags: ['PSR', 'SPARC_REG_PSR'],
    spReg: ['SP', 'SPARC_REG_SP'], spAliases: ['sp', '%sp', 'o6'], pcAliases: ['pc'],
    comments: ['!', ';', '/*', '*/', '//'],
    callLike: ['call'],
    branchLike: ['ba', 'be', 'bne', 'bl', 'ble', 'bleu', 'bgu', 'bg', 'bge', 'blu', 'bneg', 'bpos', 'bvs', 'bvc', 'bcs', 'bcc'],
    syscall: null,
    example: [
      '! SPARC V8 大端：算术运算与标志位',
      '        or      %g0, 5, %o0',
      '        or      %g0, 7, %o1',
      '        add     %o0, %o1, %o2   ! 12',
      '        smul    %o0, %o1, %o3   ! 35',
      '        subcc   %o0, %o1, %g0   ! 置条件码（5-7=-2）',
      '        bneg    done',
      '        nop',
      '        or      %g0, 1, %o4     ! 未执行',
      'done:',
    ].join('\n'),
  },
};

/* mips32be / 共享寄存器组 */
ARCHES.mips32be.regs = ARCHES.mips32el.regs;

/* SPARC 的 SP 初始值也要 8 字节对齐 */
function regList(arch) {
  const list = arch.regs ? arch.regs.slice() : [];
  if (arch.spReg && !list.some(r => r[0] === arch.spReg[0])) list.push(arch.spReg);
  list.push(arch.pc);
  if (arch.flags) list.push(arch.flags);
  return list;
}

/* 高亮用的寄存器正则（按架构组） */
const REGEX = {
  x86: /\b(?:[re]?(?:ax|bx|cx|dx|si|di|bp|sp)|r(?:1[0-5]|[89])[dwb]?\b|[abcd][hl]|ip|eip|rip|flags|eflags|rflags)\b/gi,
  arm: /\b(?:[xw]([0-9]|[12][0-9]|30)|xzr|wzr|r(?:1[0-5]|[0-9])\b|sp|lr|pc|fp|ip|sl|sb|cpsr|spsr|nzcv)\b/gi,
  mips: /(?:\$[a-z0-9]{1,4}|\b(?:zero|at|v[01]|a[0-3]|t[0-9]|s[0-7]|k[01]|gp|sp|fp|ra|hi|lo|pc)\b)/gi,
  ppc: /\b(?:r(?:3[01]|[12]?[0-9])\b|cr[0-7]|lr|ctr|xer|msr)/gi,
  sparc: /%[goli][0-7]|%s?p|%f?p|%y|%xcc|%icc/gi,
};

const ARCH_GROUP_BY_ID = Object.fromEntries(Object.values(ARCHES).map(a => [a.id, a.group]));

/* 逐行注释剥离（'/*' 视为行注释的近似处理）：返回去除注释后的源码 */
function stripComments(src, arch) {
  const chars = (arch.comments || [';']).filter(c => c !== '*/');
  return src.split('\n').map(line => {
    let idx = -1;
    for (const c of chars) {
      const i = line.indexOf(c);
      if (i !== -1 && (idx === -1 || i < idx)) idx = i;
    }
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

if (typeof module !== 'undefined') module.exports = { ARCHES, regList, stripComments, REGEX, ARCH_GROUP_BY_ID };
if (typeof self !== 'undefined') self.ArchesModule = { ARCHES, regList, stripComments, REGEX, ARCH_GROUP_BY_ID };
