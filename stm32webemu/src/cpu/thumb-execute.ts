import { APSR_C, APSR_V, CortexM3, R_LR, R_PC, R_SP } from "./cpu.js";

/**
 * Thumb-2 instruction executor for Cortex-M3.
 *
 * Coverage status (slice 1 scaffold — blinky-class firmware only):
 *   - Move/compare: MOV/MOVS imm, MOVS reg, CMP imm/reg, CMP.W reg
 *   - Arithmetic: ADD/ADDS/SUB/SUBS imm3/imm8, ADD reg, ADD SP imm
 *   - Logical: ANDS, ORRS, EORS, MVNS, LSLS/LSRS/ASRS imm
 *   - Branches: B<cond>, B (uncond), BL, BX, BLX
 *   - Memory: LDR/STR imm5 (word), LDRH/STRH imm5, LDRB/STRB imm5, LDR literal
 *   - Stack: PUSH, POP
 *   - NOP, BKPT
 *
 * Known gaps (to add in slice 2):
 *   - Full 32-bit Thumb-2 encodings (MOV.W, MOVW, MOVT, most T3 data-proc)
 *   - MSR/MRS, CPS, interrupt entry/exit
 *   - Multiply, UDIV/SDIV
 *   - IT blocks (IT state is tracked but not consumed)
 *
 * Gaps throw UnsupportedInstructionError so callers can see exactly what is
 * missing when booting real firmware.
 */
export class UnsupportedInstructionError extends Error {
  constructor(readonly pc: number, readonly opcode: number, readonly detail: string) {
    super(
      `unsupported Thumb instruction at 0x${pc.toString(16).padStart(8, "0")}: ` +
        `0x${opcode.toString(16).padStart(4, "0")} — ${detail}`,
    );
    this.name = "UnsupportedInstructionError";
  }
}

/** Advance PC by `delta` bytes (used after decoding an instruction). */
function advancePc(cpu: CortexM3, delta: number): void {
  cpu.pc = (cpu.pc + delta) >>> 0;
}

/** Sign-extend `value` from `bits` bits to 32 bits. */
function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

/** Unsigned 32-bit add with carry and overflow. */
function addWithCarry(a: number, b: number, cin: number): { result: number; carry: boolean; overflow: boolean } {
  const ua = a >>> 0;
  const ub = b >>> 0;
  const usum = ua + ub + cin;
  const result = usum >>> 0;
  const carry = usum > 0xffff_ffff;
  const sa = a | 0;
  const sb = b | 0;
  const sr = result | 0;
  const overflow = ((sa ^ sr) & (sb ^ sr) & 0x8000_0000) !== 0;
  return { result, carry, overflow };
}

/**
 * Decode and execute a single Thumb / Thumb-2 instruction at PC.
 * Returns the number of cycles consumed (always 1 for this scaffold).
 */
export function stepThumb(cpu: CortexM3): number {
  const pc = cpu.pc;
  const opcode = cpu.memory.read16(pc);
  const top5 = (opcode >>> 11) & 0x1f;

  // 32-bit Thumb-2 instructions: top5 in {0b11101, 0b11110, 0b11111}
  if (top5 === 0b11101 || top5 === 0b11110 || top5 === 0b11111) {
    return step32(cpu, opcode);
  }

  // 16-bit encodings
  // Add/subtract register or small immediate (0b00011 xx) must be checked BEFORE
  // the generic shift-imm mask, since 0x1800..0x1FFF falls inside the top3=000 window.
  if ((opcode & 0xf800) === 0x1800) {
    return execAddSub(cpu, opcode);
  }

  // Shifted register (LSL/LSR/ASR imm5) — top5 in 00000..00010
  if ((opcode & 0xe000) === 0x0000) {
    return execShiftImm(cpu, opcode);
  }

  // MOV / CMP / ADD / SUB immediate (8-bit)
  if ((opcode & 0xe000) === 0x2000) {
    return execMovCmpAddSubImm(cpu, opcode);
  }

  // Data processing register (AND/EOR/LSL/LSR/ASR/ADC/SBC/ROR/TST/RSB/CMP/CMN/ORR/MUL/BIC/MVN)
  if ((opcode & 0xfc00) === 0x4000) {
    return execDataProcReg(cpu, opcode);
  }

  // Special data instructions + branch exchange (ADD/CMP/MOV high reg, BX, BLX)
  if ((opcode & 0xfc00) === 0x4400) {
    return execSpecialDataBx(cpu, opcode);
  }

  // LDR (literal) — load from PC-relative
  if ((opcode & 0xf800) === 0x4800) {
    return execLdrLiteral(cpu, opcode);
  }

  // Load/store register offset (LDR/STR Rt, [Rn, Rm])
  if ((opcode & 0xf000) === 0x5000) {
    return execLoadStoreReg(cpu, opcode);
  }

  // Load/store word/byte immediate offset
  if ((opcode & 0xe000) === 0x6000) {
    return execLoadStoreImmWB(cpu, opcode);
  }

  // Load/store halfword immediate offset
  if ((opcode & 0xf000) === 0x8000) {
    return execLoadStoreImmHW(cpu, opcode);
  }

  // Load/store to/from stack
  if ((opcode & 0xf000) === 0x9000) {
    return execLoadStoreStack(cpu, opcode);
  }

  // ADD (SP/PC-relative): ADR / ADD Rd, SP, #imm
  if ((opcode & 0xf000) === 0xa000) {
    return execAddSpPcRelative(cpu, opcode);
  }

  // Miscellaneous 16-bit: PUSH/POP, ADD/SUB SP imm, CBZ/CBNZ, BKPT, ...
  if ((opcode & 0xf000) === 0xb000) {
    return execMisc16(cpu, opcode);
  }

  // Conditional branch + SVC
  if ((opcode & 0xf000) === 0xd000) {
    return execCondBranch(cpu, opcode);
  }

  // Unconditional branch
  if ((opcode & 0xf800) === 0xe000) {
    const imm11 = signExtend(opcode & 0x7ff, 11) << 1;
    // PC for branch = current PC + 4 (prefetch)
    cpu.pc = ((pc + 4 + imm11) >>> 0) & ~1;
    cpu.cycles += 2;
    return 2;
  }

  throw new UnsupportedInstructionError(pc, opcode, "no 16-bit decoder matched");
}

// ── individual class decoders ────────────────────────────────────────────────

function execShiftImm(cpu: CortexM3, opcode: number): number {
  const op = (opcode >>> 11) & 0x3;
  const imm5 = (opcode >>> 6) & 0x1f;
  const rm = (opcode >>> 3) & 0x7;
  const rd = opcode & 0x7;
  const rmVal = cpu.regs[rm] >>> 0;
  let result = 0;
  let carry = (cpu.apsr & APSR_C) !== 0;
  switch (op) {
    case 0: { // LSL imm
      if (imm5 === 0) { result = rmVal; }
      else {
        carry = ((rmVal >>> (32 - imm5)) & 1) !== 0;
        result = (rmVal << imm5) >>> 0;
      }
      break;
    }
    case 1: { // LSR imm (imm5==0 → shift by 32)
      const sh = imm5 === 0 ? 32 : imm5;
      carry = ((rmVal >>> (sh - 1)) & 1) !== 0;
      result = sh === 32 ? 0 : rmVal >>> sh;
      break;
    }
    case 2: { // ASR imm (imm5==0 → shift by 32)
      const sh = imm5 === 0 ? 32 : imm5;
      carry = (((rmVal | 0) >> (sh - 1)) & 1) !== 0;
      result = ((rmVal | 0) >> sh) >>> 0;
      break;
    }
    default:
      throw new UnsupportedInstructionError(cpu.pc, opcode, "shift op=3");
  }
  cpu.regs[rd] = result;
  cpu.setFlagsNZ(result);
  cpu.apsr = carry ? (cpu.apsr | APSR_C) >>> 0 : (cpu.apsr & ~APSR_C) >>> 0;
  advancePc(cpu, 2);
  cpu.cycles += 1;
  return 1;
}

function execAddSub(cpu: CortexM3, opcode: number): number {
  const immFlag = (opcode >>> 10) & 1;
  const sub = (opcode >>> 9) & 1;
  const rmOrImm = (opcode >>> 6) & 0x7;
  const rn = (opcode >>> 3) & 0x7;
  const rd = opcode & 0x7;
  const a = cpu.regs[rn] >>> 0;
  const b = immFlag ? rmOrImm : (cpu.regs[rmOrImm] >>> 0);
  const { result, carry, overflow } = sub
    ? addWithCarry(a, ~b >>> 0, 1)
    : addWithCarry(a, b, 0);
  cpu.regs[rd] = result;
  cpu.setFlagsNZCV(result, carry, overflow);
  advancePc(cpu, 2);
  cpu.cycles += 1;
  return 1;
}

function execMovCmpAddSubImm(cpu: CortexM3, opcode: number): number {
  const op = (opcode >>> 11) & 0x3;
  const rd = (opcode >>> 8) & 0x7;
  const imm8 = opcode & 0xff;
  switch (op) {
    case 0: { // MOVS rd, #imm8
      cpu.regs[rd] = imm8;
      cpu.setFlagsNZ(imm8);
      break;
    }
    case 1: { // CMP rd, #imm8
      const a = cpu.regs[rd] >>> 0;
      const { result, carry, overflow } = addWithCarry(a, ~imm8 >>> 0, 1);
      cpu.setFlagsNZCV(result, carry, overflow);
      break;
    }
    case 2: { // ADDS rd, #imm8
      const a = cpu.regs[rd] >>> 0;
      const { result, carry, overflow } = addWithCarry(a, imm8, 0);
      cpu.regs[rd] = result;
      cpu.setFlagsNZCV(result, carry, overflow);
      break;
    }
    case 3: { // SUBS rd, #imm8
      const a = cpu.regs[rd] >>> 0;
      const { result, carry, overflow } = addWithCarry(a, ~imm8 >>> 0, 1);
      cpu.regs[rd] = result;
      cpu.setFlagsNZCV(result, carry, overflow);
      break;
    }
  }
  advancePc(cpu, 2);
  cpu.cycles += 1;
  return 1;
}

function execDataProcReg(cpu: CortexM3, opcode: number): number {
  const op = (opcode >>> 6) & 0xf;
  const rm = (opcode >>> 3) & 0x7;
  const rd = opcode & 0x7;
  const a = cpu.regs[rd] >>> 0;
  const b = cpu.regs[rm] >>> 0;
  switch (op) {
    case 0x0: { // ANDS
      const r = (a & b) >>> 0;
      cpu.regs[rd] = r;
      cpu.setFlagsNZ(r);
      break;
    }
    case 0x1: { // EORS
      const r = (a ^ b) >>> 0;
      cpu.regs[rd] = r;
      cpu.setFlagsNZ(r);
      break;
    }
    case 0x8: { // TST
      const r = (a & b) >>> 0;
      cpu.setFlagsNZ(r);
      break;
    }
    case 0xa: { // CMP reg
      const { result, carry, overflow } = addWithCarry(a, ~b >>> 0, 1);
      cpu.setFlagsNZCV(result, carry, overflow);
      break;
    }
    case 0xc: { // ORRS
      const r = (a | b) >>> 0;
      cpu.regs[rd] = r;
      cpu.setFlagsNZ(r);
      break;
    }
    case 0xe: { // BICS
      const r = (a & ~b) >>> 0;
      cpu.regs[rd] = r;
      cpu.setFlagsNZ(r);
      break;
    }
    case 0xf: { // MVNS
      const r = (~b) >>> 0;
      cpu.regs[rd] = r;
      cpu.setFlagsNZ(r);
      break;
    }
    default:
      throw new UnsupportedInstructionError(cpu.pc, opcode, `data-proc reg op=${op.toString(16)}`);
  }
  advancePc(cpu, 2);
  cpu.cycles += 1;
  return 1;
}

function execSpecialDataBx(cpu: CortexM3, opcode: number): number {
  const op = (opcode >>> 8) & 0x3;
  const dnHi = (opcode >>> 7) & 1;
  const rm = (opcode >>> 3) & 0xf;
  const rdLo = opcode & 0x7;
  const rd = (dnHi << 3) | rdLo;

  if (op === 3) {
    // BX / BLX (BLX when H=1)
    const blx = ((opcode >>> 7) & 1) !== 0;
    const target = cpu.regs[rm] >>> 0;
    if (blx) cpu.regs[R_LR] = ((cpu.pc + 2) | 1) >>> 0;
    cpu.pc = target & ~1;
    cpu.cycles += 2;
    return 2;
  }

  // Cortex-M: reads of PC return current instruction address + 4 (prefetch).
  const rmVal = rm === R_PC ? ((cpu.pc + 4) >>> 0) : (cpu.regs[rm] >>> 0);
  const rdVal = rd === R_PC ? ((cpu.pc + 4) >>> 0) : (cpu.regs[rd] >>> 0);

  switch (op) {
    case 0: { // ADD Rd, Rm (high regs)
      const result = (rdVal + rmVal) >>> 0;
      if (rd === R_PC) {
        cpu.pc = result & ~1;
        cpu.cycles += 2;
        return 2;
      }
      cpu.regs[rd] = result;
      break;
    }
    case 1: { // CMP Rd, Rm (high regs)
      const { result, carry, overflow } = addWithCarry(rdVal, ~rmVal >>> 0, 1);
      cpu.setFlagsNZCV(result, carry, overflow);
      break;
    }
    case 2: { // MOV Rd, Rm (high regs) — does NOT set flags
      if (rd === R_PC) {
        cpu.pc = rmVal & ~1;
        cpu.cycles += 2;
        return 2;
      }
      cpu.regs[rd] = rmVal;
      break;
    }
  }
  advancePc(cpu, 2);
  cpu.cycles += 1;
  return 1;
}

function execLdrLiteral(cpu: CortexM3, opcode: number): number {
  const rt = (opcode >>> 8) & 0x7;
  const imm8 = opcode & 0xff;
  // Aligned PC + 4
  const base = ((cpu.pc + 4) & ~3) >>> 0;
  const addr = (base + (imm8 << 2)) >>> 0;
  cpu.regs[rt] = cpu.memory.read32(addr) >>> 0;
  advancePc(cpu, 2);
  cpu.cycles += 2;
  return 2;
}

function execLoadStoreReg(cpu: CortexM3, opcode: number): number {
  const op = (opcode >>> 9) & 0x7;
  const rm = (opcode >>> 6) & 0x7;
  const rn = (opcode >>> 3) & 0x7;
  const rt = opcode & 0x7;
  const addr = ((cpu.regs[rn] >>> 0) + (cpu.regs[rm] >>> 0)) >>> 0;
  switch (op) {
    case 0: cpu.memory.write32(addr, cpu.regs[rt]); break; // STR
    case 1: cpu.memory.write16(addr, cpu.regs[rt] & 0xffff); break; // STRH
    case 2: cpu.memory.write8(addr, cpu.regs[rt] & 0xff); break; // STRB
    case 3: cpu.regs[rt] = signExtend(cpu.memory.read8(addr), 8) >>> 0; break; // LDRSB
    case 4: cpu.regs[rt] = cpu.memory.read32(addr) >>> 0; break; // LDR
    case 5: cpu.regs[rt] = cpu.memory.read16(addr) & 0xffff; break; // LDRH
    case 6: cpu.regs[rt] = cpu.memory.read8(addr) & 0xff; break; // LDRB
    case 7: cpu.regs[rt] = signExtend(cpu.memory.read16(addr), 16) >>> 0; break; // LDRSH
  }
  advancePc(cpu, 2);
  cpu.cycles += 2;
  return 2;
}

function execLoadStoreImmWB(cpu: CortexM3, opcode: number): number {
  const isByte = ((opcode >>> 12) & 1) !== 0;
  const isLoad = ((opcode >>> 11) & 1) !== 0;
  const imm5 = (opcode >>> 6) & 0x1f;
  const rn = (opcode >>> 3) & 0x7;
  const rt = opcode & 0x7;
  const offset = isByte ? imm5 : imm5 << 2;
  const addr = ((cpu.regs[rn] >>> 0) + offset) >>> 0;
  if (isLoad) {
    cpu.regs[rt] = isByte
      ? cpu.memory.read8(addr) & 0xff
      : cpu.memory.read32(addr) >>> 0;
  } else {
    if (isByte) cpu.memory.write8(addr, cpu.regs[rt] & 0xff);
    else cpu.memory.write32(addr, cpu.regs[rt]);
  }
  advancePc(cpu, 2);
  cpu.cycles += 2;
  return 2;
}

function execLoadStoreImmHW(cpu: CortexM3, opcode: number): number {
  const isLoad = ((opcode >>> 11) & 1) !== 0;
  const imm5 = (opcode >>> 6) & 0x1f;
  const rn = (opcode >>> 3) & 0x7;
  const rt = opcode & 0x7;
  const addr = ((cpu.regs[rn] >>> 0) + (imm5 << 1)) >>> 0;
  if (isLoad) cpu.regs[rt] = cpu.memory.read16(addr) & 0xffff;
  else cpu.memory.write16(addr, cpu.regs[rt] & 0xffff);
  advancePc(cpu, 2);
  cpu.cycles += 2;
  return 2;
}

function execLoadStoreStack(cpu: CortexM3, opcode: number): number {
  const isLoad = ((opcode >>> 11) & 1) !== 0;
  const rt = (opcode >>> 8) & 0x7;
  const imm8 = opcode & 0xff;
  const addr = ((cpu.regs[R_SP] >>> 0) + (imm8 << 2)) >>> 0;
  if (isLoad) cpu.regs[rt] = cpu.memory.read32(addr) >>> 0;
  else cpu.memory.write32(addr, cpu.regs[rt]);
  advancePc(cpu, 2);
  cpu.cycles += 2;
  return 2;
}

function execAddSpPcRelative(cpu: CortexM3, opcode: number): number {
  const useSp = ((opcode >>> 11) & 1) !== 0;
  const rd = (opcode >>> 8) & 0x7;
  const imm8 = opcode & 0xff;
  const base = useSp ? (cpu.regs[R_SP] >>> 0) : (((cpu.pc + 4) & ~3) >>> 0);
  cpu.regs[rd] = (base + (imm8 << 2)) >>> 0;
  advancePc(cpu, 2);
  cpu.cycles += 1;
  return 1;
}

function execMisc16(cpu: CortexM3, opcode: number): number {
  // ADD/SUB SP imm7
  if ((opcode & 0xff00) === 0xb000) {
    const sub = ((opcode >>> 7) & 1) !== 0;
    const imm7 = (opcode & 0x7f) << 2;
    cpu.regs[R_SP] = sub
      ? ((cpu.regs[R_SP] - imm7) >>> 0)
      : ((cpu.regs[R_SP] + imm7) >>> 0);
    advancePc(cpu, 2);
    cpu.cycles += 1;
    return 1;
  }

  // PUSH: 1011 010 M register_list
  if ((opcode & 0xfe00) === 0xb400) {
    const m = ((opcode >>> 8) & 1) !== 0;
    const regList = opcode & 0xff;
    let sp = cpu.regs[R_SP] >>> 0;
    const count = popcount(regList) + (m ? 1 : 0);
    sp = (sp - count * 4) >>> 0;
    let addr = sp;
    for (let i = 0; i < 8; i++) {
      if (regList & (1 << i)) {
        cpu.memory.write32(addr, cpu.regs[i]);
        addr = (addr + 4) >>> 0;
      }
    }
    if (m) cpu.memory.write32(addr, cpu.regs[R_LR]);
    cpu.regs[R_SP] = sp;
    advancePc(cpu, 2);
    cpu.cycles += 1 + count;
    return 1 + count;
  }

  // POP: 1011 110 P register_list
  if ((opcode & 0xfe00) === 0xbc00) {
    const p = ((opcode >>> 8) & 1) !== 0;
    const regList = opcode & 0xff;
    let addr = cpu.regs[R_SP] >>> 0;
    for (let i = 0; i < 8; i++) {
      if (regList & (1 << i)) {
        cpu.regs[i] = cpu.memory.read32(addr) >>> 0;
        addr = (addr + 4) >>> 0;
      }
    }
    let branched = false;
    if (p) {
      const loadedPc = cpu.memory.read32(addr) >>> 0;
      addr = (addr + 4) >>> 0;
      cpu.pc = loadedPc & ~1;
      branched = true;
    }
    cpu.regs[R_SP] = addr;
    if (!branched) advancePc(cpu, 2);
    cpu.cycles += 2;
    return 2;
  }

  // CBZ / CBNZ: 1011 i0 i1 0 imm5 Rn (imm6 = i:imm5 << 1, zero-extended)
  if ((opcode & 0xf500) === 0xb100) {
    const nonzero = ((opcode >>> 11) & 1) !== 0;
    const i = (opcode >>> 9) & 1;
    const imm5 = (opcode >>> 3) & 0x1f;
    const rn = opcode & 0x7;
    const imm = ((i << 6) | (imm5 << 1)) >>> 0;
    const rnVal = cpu.regs[rn] >>> 0;
    const taken = nonzero ? rnVal !== 0 : rnVal === 0;
    if (taken) {
      cpu.pc = ((cpu.pc + 4 + imm) >>> 0) & ~1;
      cpu.cycles += 2;
      return 2;
    }
    advancePc(cpu, 2);
    cpu.cycles += 1;
    return 1;
  }

  // BKPT
  if ((opcode & 0xff00) === 0xbe00) {
    cpu.halted = true;
    advancePc(cpu, 2);
    cpu.cycles += 1;
    return 1;
  }

  // NOP / hints (1011 1111 000x xxxx) — treat as no-op
  if ((opcode & 0xff00) === 0xbf00) {
    advancePc(cpu, 2);
    cpu.cycles += 1;
    return 1;
  }

  throw new UnsupportedInstructionError(cpu.pc, opcode, "misc16");
}

function execCondBranch(cpu: CortexM3, opcode: number): number {
  const cond = (opcode >>> 8) & 0xf;
  if (cond === 0xf) {
    // SVC
    throw new UnsupportedInstructionError(cpu.pc, opcode, "SVC not implemented");
  }
  const imm8 = signExtend(opcode & 0xff, 8) << 1;
  if (cpu.condPasses(cond)) {
    cpu.pc = ((cpu.pc + 4 + imm8) >>> 0) & ~1;
    cpu.cycles += 2;
    return 2;
  }
  advancePc(cpu, 2);
  cpu.cycles += 1;
  return 1;
}

// ── 32-bit Thumb-2 encodings (minimal: BL, B.W, data-proc imm, LDR/STR imm12) ──

function step32(cpu: CortexM3, opcode1: number): number {
  const pc = cpu.pc;
  const opcode2 = cpu.memory.read16(pc + 2);
  // BL T1: 11110 S imm10 : 11 J1 1 J2 imm11
  const op1 = (opcode1 >>> 11) & 0x1f;
  const op2class = (opcode2 >>> 14) & 0x3;
  if (op1 === 0b11110 && op2class === 0b11) {
    const s = (opcode1 >>> 10) & 1;
    const imm10 = opcode1 & 0x3ff;
    const j1 = (opcode2 >>> 13) & 1;
    const isBl = ((opcode2 >>> 12) & 1) !== 0;
    const j2 = (opcode2 >>> 11) & 1;
    const imm11 = opcode2 & 0x7ff;
    const i1 = (~(j1 ^ s)) & 1;
    const i2 = (~(j2 ^ s)) & 1;
    const imm = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1);
    const offset = signExtend(imm, 25);
    const target = (pc + 4 + offset) >>> 0;
    if (isBl) {
      cpu.regs[R_LR] = ((pc + 4) | 1) >>> 0;
    }
    cpu.pc = target & ~1;
    cpu.cycles += 4;
    return 4;
  }

  throw new UnsupportedInstructionError(
    pc,
    opcode1,
    `32-bit Thumb-2 not implemented (opcode2=0x${opcode2.toString(16)})`,
  );
}

function popcount(n: number): number {
  let c = 0;
  let x = n;
  while (x) { c += x & 1; x >>>= 1; }
  return c;
}
