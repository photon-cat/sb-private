// Xtensa LX6 Instruction Execution Engine
import { ESP32CPU, SR_SAR, SR_LBEG, SR_LEND, SR_LCOUNT, SR_PS, SR_WINDOWBASE, SR_WINDOWSTART, SR_CCOUNT, PS_CALLINC_SHIFT, PS_CALLINC_MASK, PS_WOE, EXCCAUSE_WINDOW_OVERFLOW4, EXCCAUSE_WINDOW_OVERFLOW8, EXCCAUSE_WINDOW_OVERFLOW12, EXCCAUSE_WINDOW_UNDERFLOW4, EXCCAUSE_ILLEGAL } from "./cpu.js";
import { decode, Opcode, B4CONST, B4CONSTU, type DecodedInstruction } from "./xtensa-decoder.js";

// Execute one instruction. Returns false if halted/illegal.
export function executeInstruction(cpu: ESP32CPU): boolean {
  if (cpu.halted) return false;

  const inst = decode(cpu.memory, cpu.pc);
  cpu.cycles++;
  cpu.specialRegisters[SR_CCOUNT] = (cpu.specialRegisters[SR_CCOUNT] + 1) | 0;

  switch (inst.op) {
    // ===== NOP / SYNC =====
    case Opcode.NOP:
    case Opcode.NOP_N:
    case Opcode.MEMW:
    case Opcode.EXTW:
    case Opcode.ISYNC:
    case Opcode.DSYNC:
    case Opcode.ESYNC:
    case Opcode.RSYNC:
      cpu.pc += inst.len;
      break;

    // ===== ALU — register-register =====
    case Opcode.ADD:
      cpu.setAR(inst.r, (cpu.getAR(inst.s) + cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.ADD_N:
      cpu.setAR(inst.r, (cpu.getAR(inst.s) + cpu.getAR(inst.t)) | 0);
      cpu.pc += 2;
      break;

    case Opcode.SUB:
      cpu.setAR(inst.r, (cpu.getAR(inst.s) - cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.ADDX2:
      cpu.setAR(inst.r, ((cpu.getAR(inst.s) << 1) + cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.ADDX4:
      cpu.setAR(inst.r, ((cpu.getAR(inst.s) << 2) + cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.ADDX8:
      cpu.setAR(inst.r, ((cpu.getAR(inst.s) << 3) + cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SUBX2:
      cpu.setAR(inst.r, ((cpu.getAR(inst.s) << 1) - cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SUBX4:
      cpu.setAR(inst.r, ((cpu.getAR(inst.s) << 2) - cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SUBX8:
      cpu.setAR(inst.r, ((cpu.getAR(inst.s) << 3) - cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.NEG:
      cpu.setAR(inst.r, (-cpu.getAR(inst.t)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.ABS:
      { const v = cpu.getAR(inst.t); cpu.setAR(inst.r, v < 0 ? -v : v); }
      cpu.pc += 3;
      break;

    case Opcode.AND:
      cpu.setAR(inst.r, cpu.getAR(inst.s) & cpu.getAR(inst.t));
      cpu.pc += 3;
      break;

    case Opcode.OR:
      cpu.setAR(inst.r, cpu.getAR(inst.s) | cpu.getAR(inst.t));
      cpu.pc += 3;
      break;

    case Opcode.XOR:
      cpu.setAR(inst.r, cpu.getAR(inst.s) ^ cpu.getAR(inst.t));
      cpu.pc += 3;
      break;

    // ===== Multiply =====
    case Opcode.MULL:
      cpu.setAR(inst.r, Math.imul(cpu.getAR(inst.s), cpu.getAR(inst.t)));
      cpu.pc += 3;
      break;

    case Opcode.MULUH: {
      // Unsigned multiply high
      const a = cpu.getAR(inst.s) >>> 0;
      const b = cpu.getAR(inst.t) >>> 0;
      // Use BigInt for 64-bit multiply
      const result = BigInt(a) * BigInt(b);
      cpu.setAR(inst.r, Number((result >> 32n) & 0xffffffffn) | 0);
      cpu.pc += 3;
      break;
    }

    case Opcode.MULSH: {
      // Signed multiply high
      const a = cpu.getAR(inst.s);
      const b = cpu.getAR(inst.t);
      const result = BigInt(a) * BigInt(b);
      cpu.setAR(inst.r, Number((result >> 32n) & 0xffffffffn) | 0);
      cpu.pc += 3;
      break;
    }

    case Opcode.QUOU: {
      const divisor = cpu.getAR(inst.t) >>> 0;
      if (divisor === 0) { cpu.raiseException(6); break; } // divide by zero
      cpu.setAR(inst.r, ((cpu.getAR(inst.s) >>> 0) / divisor) >>> 0);
      cpu.pc += 3;
      break;
    }

    case Opcode.QUOS: {
      const divisor = cpu.getAR(inst.t);
      if (divisor === 0) { cpu.raiseException(6); break; }
      cpu.setAR(inst.r, (cpu.getAR(inst.s) / divisor) | 0);
      cpu.pc += 3;
      break;
    }

    case Opcode.REMU: {
      const divisor = cpu.getAR(inst.t) >>> 0;
      if (divisor === 0) { cpu.raiseException(6); break; }
      cpu.setAR(inst.r, ((cpu.getAR(inst.s) >>> 0) % divisor) >>> 0);
      cpu.pc += 3;
      break;
    }

    case Opcode.REMS: {
      const divisor = cpu.getAR(inst.t);
      if (divisor === 0) { cpu.raiseException(6); break; }
      cpu.setAR(inst.r, (cpu.getAR(inst.s) % divisor) | 0);
      cpu.pc += 3;
      break;
    }

    // ===== Min/Max =====
    case Opcode.MIN:
      cpu.setAR(inst.r, Math.min(cpu.getAR(inst.s), cpu.getAR(inst.t)));
      cpu.pc += 3;
      break;

    case Opcode.MINU: {
      const a = cpu.getAR(inst.s) >>> 0;
      const b = cpu.getAR(inst.t) >>> 0;
      cpu.setAR(inst.r, (a < b ? a : b) | 0);
      cpu.pc += 3;
      break;
    }

    case Opcode.MAX:
      cpu.setAR(inst.r, Math.max(cpu.getAR(inst.s), cpu.getAR(inst.t)));
      cpu.pc += 3;
      break;

    case Opcode.MAXU: {
      const a = cpu.getAR(inst.s) >>> 0;
      const b = cpu.getAR(inst.t) >>> 0;
      cpu.setAR(inst.r, (a > b ? a : b) | 0);
      cpu.pc += 3;
      break;
    }

    // ===== Conditional moves =====
    case Opcode.MOVEQZ:
      if (cpu.getAR(inst.t) === 0) cpu.setAR(inst.r, cpu.getAR(inst.s));
      cpu.pc += 3;
      break;

    case Opcode.MOVNEZ:
      if (cpu.getAR(inst.t) !== 0) cpu.setAR(inst.r, cpu.getAR(inst.s));
      cpu.pc += 3;
      break;

    case Opcode.MOVLTZ:
      if (cpu.getAR(inst.t) < 0) cpu.setAR(inst.r, cpu.getAR(inst.s));
      cpu.pc += 3;
      break;

    case Opcode.MOVGEZ:
      if (cpu.getAR(inst.t) >= 0) cpu.setAR(inst.r, cpu.getAR(inst.s));
      cpu.pc += 3;
      break;

    // ===== Immediate ALU =====
    case Opcode.ADDI:
      cpu.setAR(inst.t, (cpu.getAR(inst.s) + inst.imm) | 0);
      cpu.pc += 3;
      break;

    case Opcode.ADDI_N:
      cpu.setAR(inst.r, (cpu.getAR(inst.s) + inst.imm) | 0);
      cpu.pc += 2;
      break;

    case Opcode.ADDMI:
      cpu.setAR(inst.t, (cpu.getAR(inst.s) + inst.imm) | 0);
      cpu.pc += 3;
      break;

    case Opcode.MOVI:
      cpu.setAR(inst.t, inst.imm);
      cpu.pc += 3;
      break;

    case Opcode.MOVI_N:
      cpu.setAR(inst.s, inst.imm);
      cpu.pc += 2;
      break;

    case Opcode.MOV_N:
      cpu.setAR(inst.t, cpu.getAR(inst.s));
      cpu.pc += 2;
      break;

    case Opcode.MOVSP:
      // MOVSP: move with window underflow check (used for alloca)
      // In our simplified emulation, just do the move
      cpu.setAR(inst.t, cpu.getAR(inst.s));
      cpu.pc += 3;
      break;

    // ===== EXTUI — extract unsigned immediate =====
    case Opcode.EXTUI: {
      const shift = inst.imm & 0xff;
      const mask = (inst.imm >> 8) & 0xff;
      const maskBits = (1 << mask) - 1;
      cpu.setAR(inst.r, ((cpu.getAR(inst.t) >>> shift) & maskBits) | 0);
      cpu.pc += 3;
      break;
    }

    // SEXT: sign-extend ar[s] from bit position imm to 32 bits, store in ar[r]
    case Opcode.SEX: {
      const val = cpu.getAR(inst.s);
      const bitPos = inst.imm; // 7..22
      const shift = 31 - bitPos;
      cpu.setAR(inst.r, (val << shift) >> shift); // arithmetic shift for sign extension
      cpu.pc += 3;
      break;
    }

    // CLAMPS: clamp ar[s] to signed range -(2^imm) .. (2^imm)-1, store in ar[r]
    case Opcode.CLAMPS: {
      const val = cpu.getAR(inst.s) | 0;
      const bitPos = inst.imm; // 7..22
      const max = (1 << bitPos) - 1;
      const min = -(1 << bitPos);
      cpu.setAR(inst.r, val > max ? max : val < min ? min : val);
      cpu.pc += 3;
      break;
    }

    // ===== Shifts =====
    case Opcode.SLLI:
      cpu.setAR(inst.r, (cpu.getAR(inst.s) << inst.imm) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SRLI:
      cpu.setAR(inst.r, (cpu.getAR(inst.t) >>> inst.imm) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SRAI:
      cpu.setAR(inst.r, (cpu.getAR(inst.t) >> inst.imm) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SSL: // Set Shift Left — SAR = 32 - a[s]
      cpu.specialRegisters[SR_SAR] = (32 - (cpu.getAR(inst.s) & 31)) & 31;
      cpu.pc += 3;
      break;

    case Opcode.SSR: // Set Shift Right — SAR = a[s]
      cpu.specialRegisters[SR_SAR] = cpu.getAR(inst.s) & 31;
      cpu.pc += 3;
      break;

    case Opcode.SSA8L: // Set shift for little-endian byte extract
      cpu.specialRegisters[SR_SAR] = (cpu.getAR(inst.s) & 3) << 3;
      cpu.pc += 3;
      break;

    case Opcode.SSA8B: // Set shift for big-endian byte extract
      cpu.specialRegisters[SR_SAR] = 32 - ((cpu.getAR(inst.s) & 3) << 3);
      cpu.pc += 3;
      break;

    case Opcode.SSAI:
      cpu.specialRegisters[SR_SAR] = inst.imm & 31;
      cpu.pc += 3;
      break;

    case Opcode.SLL: // Shift left logical: ar = as << (32 - SAR)
      cpu.setAR(inst.r, (cpu.getAR(inst.s) << ((32 - cpu.specialRegisters[SR_SAR]) & 31)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SRL: // Shift right logical by SAR
      cpu.setAR(inst.r, (cpu.getAR(inst.t) >>> (cpu.specialRegisters[SR_SAR] & 31)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SRA: // Shift right arithmetic by SAR
      cpu.setAR(inst.r, (cpu.getAR(inst.t) >> (cpu.specialRegisters[SR_SAR] & 31)) | 0);
      cpu.pc += 3;
      break;

    case Opcode.SRC: {
      // Funnel shift: result = (a[s] << (32-SAR)) | (a[t] >>> SAR)
      const sar = cpu.specialRegisters[SR_SAR] & 31;
      const high = cpu.getAR(inst.s);
      const low = cpu.getAR(inst.t);
      if (sar === 0) {
        cpu.setAR(inst.r, low);
      } else {
        cpu.setAR(inst.r, ((high << (32 - sar)) | (low >>> sar)) | 0);
      }
      cpu.pc += 3;
      break;
    }

    // ===== NSA / NSAU — count leading sign/zero bits =====
    case Opcode.NSA: {
      const v = cpu.getAR(inst.s);
      cpu.setAR(inst.t, 31 - Math.clz32(v < 0 ? ~v : v));
      cpu.pc += 3;
      break;
    }

    case Opcode.NSAU: {
      cpu.setAR(inst.t, Math.clz32(cpu.getAR(inst.s)));
      cpu.pc += 3;
      break;
    }

    // ===== Load/Store =====
    case Opcode.L32I: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.setAR(inst.t, cpu.memory.read32(addr));
      cpu.pc += 3;
      break;
    }

    case Opcode.L32I_N: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.setAR(inst.t, cpu.memory.read32(addr));
      cpu.pc += 2;
      break;
    }

    case Opcode.L16UI: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.setAR(inst.t, cpu.memory.read16(addr) & 0xffff);
      cpu.pc += 3;
      break;
    }

    case Opcode.L16SI: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      const v = cpu.memory.read16(addr);
      cpu.setAR(inst.t, (v << 16) >> 16); // sign-extend 16→32
      cpu.pc += 3;
      break;
    }

    case Opcode.L8UI: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.setAR(inst.t, cpu.memory.read8(addr) & 0xff);
      cpu.pc += 3;
      break;
    }

    case Opcode.S32I: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.memory.write32(addr, cpu.getAR(inst.t));
      cpu.pc += 3;
      break;
    }

    case Opcode.S32E: {
      // Store 32-bit for exception: mem[a[s] + offset] = a[t]
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.memory.write32(addr, cpu.getAR(inst.t));
      cpu.pc += 3;
      break;
    }

    case Opcode.L32E: {
      // Load 32-bit for exception: a[t] = mem[a[s] + offset]
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.setAR(inst.t, cpu.memory.read32(addr));
      cpu.pc += 3;
      break;
    }

    case Opcode.S32I_N: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.memory.write32(addr, cpu.getAR(inst.t));
      cpu.pc += 2;
      break;
    }

    case Opcode.S16I: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.memory.write16(addr, cpu.getAR(inst.t) & 0xffff);
      cpu.pc += 3;
      break;
    }

    case Opcode.S8I: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      cpu.memory.write8(addr, cpu.getAR(inst.t) & 0xff);
      cpu.pc += 3;
      break;
    }

    // ===== L32R — PC-relative literal load =====
    case Opcode.L32R: {
      // L32R: addr = ((PC + 3) & ~3) + (sext16(imm16) << 2)
      // (PC+3) gives next instruction address, aligned down to 4-byte boundary
      const addr = (((cpu.pc + 3) & ~3) + (inst.imm << 2)) >>> 0;
      cpu.setAR(inst.t, cpu.memory.read32(addr));
      cpu.pc += 3;
      break;
    }

    // ===== S32C1I — Store Conditional =====
    case Opcode.S32C1I: {
      const addr = (cpu.getAR(inst.s) + inst.imm) >>> 0;
      const oldVal = cpu.memory.read32(addr);
      const scompare1 = cpu.specialRegisters[12] >>> 0; // SCOMPARE1 (unsigned compare)
      if (oldVal === scompare1) {
        cpu.memory.write32(addr, cpu.getAR(inst.t));
      }
      cpu.setAR(inst.t, oldVal);
      cpu.pc += 3;
      break;
    }

    // ===== Branches — register-register (op0=7 B group: offset + 4) =====
    case Opcode.BEQ:
      if (cpu.getAR(inst.s) === cpu.getAR(inst.t)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BNE:
      if (cpu.getAR(inst.s) !== cpu.getAR(inst.t)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BLT:
      if (cpu.getAR(inst.s) < cpu.getAR(inst.t)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BGE:
      if (cpu.getAR(inst.s) >= cpu.getAR(inst.t)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BLTU:
      if ((cpu.getAR(inst.s) >>> 0) < (cpu.getAR(inst.t) >>> 0)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BGEU:
      if ((cpu.getAR(inst.s) >>> 0) >= (cpu.getAR(inst.t) >>> 0)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    // ===== Branches — register-zero (op0=6 BZ class: offset + 4) =====
    case Opcode.BEQZ:
      if (cpu.getAR(inst.s) === 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BNEZ:
      if (cpu.getAR(inst.s) !== 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BLTZ:
      if (cpu.getAR(inst.s) < 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BGEZ:
      if (cpu.getAR(inst.s) >= 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BEQZ_N:
      if (cpu.getAR(inst.s) === 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 2;
      break;

    case Opcode.BNEZ_N:
      if (cpu.getAR(inst.s) !== 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 2;
      break;

    // ===== Branches — register-immediate (op0=6 BI0/BI1 class: offset + 4) =====
    case Opcode.BEQI:
      if (cpu.getAR(inst.s) === B4CONST[inst.r]) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BNEI:
      if (cpu.getAR(inst.s) !== B4CONST[inst.r]) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BLTI:
      if (cpu.getAR(inst.s) < B4CONST[inst.r]) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BGEI:
      if (cpu.getAR(inst.s) >= B4CONST[inst.r]) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BLTUI:
      if ((cpu.getAR(inst.s) >>> 0) < (B4CONSTU[inst.r] >>> 0)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BGEUI:
      if ((cpu.getAR(inst.s) >>> 0) >= (B4CONSTU[inst.r] >>> 0)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    // ===== Bit-test branches =====
    // For BBCI/BBSI, inst.t = bit index (0-31), inst.s = source register
    // Branch offset = PC + sext8(imm8) + 4 (Xtensa ISA adds 4 for these)
    case Opcode.BBCI:
      if (((cpu.getAR(inst.s) >>> inst.t) & 1) === 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BBSI:
      if (((cpu.getAR(inst.s) >>> inst.t) & 1) === 1) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    // ===== Bitmask branches (op0=7 B group: offset + 4) =====
    case Opcode.BALL:
      if ((cpu.getAR(inst.s) & cpu.getAR(inst.t)) === cpu.getAR(inst.t)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BNALL:
      if ((cpu.getAR(inst.s) & cpu.getAR(inst.t)) !== cpu.getAR(inst.t)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BANY:
      if ((cpu.getAR(inst.s) & cpu.getAR(inst.t)) !== 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BNONE:
      if ((cpu.getAR(inst.s) & cpu.getAR(inst.t)) === 0) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;

    case Opcode.BBC: {
      const bitIndex = cpu.getAR(inst.t) & 0x1f;
      if (!((cpu.getAR(inst.s) >>> bitIndex) & 1)) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;
    }

    case Opcode.BBS: {
      const bitIndex = cpu.getAR(inst.t) & 0x1f;
      if ((cpu.getAR(inst.s) >>> bitIndex) & 1) cpu.pc += inst.imm + 4;
      else cpu.pc += 3;
      break;
    }

    // ===== Unconditional jump =====
    case Opcode.J:
      cpu.pc += inst.imm + 4; // J target = PC + offset + 4
      break;

    // ===== Loops (op0=6 BI1 class: LEND = PC + offset + 4) =====
    case Opcode.LOOP:
      cpu.specialRegisters[SR_LBEG] = cpu.pc + 3; // Loop start = next instruction
      cpu.specialRegisters[SR_LEND] = cpu.pc + inst.imm + 4; // Loop end
      cpu.specialRegisters[SR_LCOUNT] = cpu.getAR(inst.s) - 1;
      cpu.pc += 3;
      break;

    case Opcode.LOOPNEZ:
      if (cpu.getAR(inst.s) !== 0) {
        cpu.specialRegisters[SR_LBEG] = cpu.pc + 3;
        cpu.specialRegisters[SR_LEND] = cpu.pc + inst.imm + 4;
        cpu.specialRegisters[SR_LCOUNT] = cpu.getAR(inst.s) - 1;
      }
      cpu.pc += 3;
      break;

    case Opcode.LOOPGTZ:
      if (cpu.getAR(inst.s) > 0) {
        cpu.specialRegisters[SR_LBEG] = cpu.pc + 3;
        cpu.specialRegisters[SR_LEND] = cpu.pc + inst.imm + 4;
        cpu.specialRegisters[SR_LCOUNT] = cpu.getAR(inst.s) - 1;
      }
      cpu.pc += 3;
      break;

    // ===== CALL — windowed calls =====
    case Opcode.CALL0: {
      cpu.setAR(0, cpu.pc + 3); // Return address in a0
      const target0 = (((cpu.pc + 4) & ~3) + inst.imm) >>> 0;
      cpu.pc = target0;
      break;
    }

    case Opcode.CALL4: {
      // CALL4: store return address in caller's a4, set PS.CALLINC=1, jump
      // Window rotation happens in ENTRY, not here
      const retAddr = ((cpu.pc + 3) & 0x3FFFFFFF) | (1 << 30);
      cpu.setAR(4, retAddr);
      cpu.specialRegisters[SR_PS] = (cpu.specialRegisters[SR_PS] & ~PS_CALLINC_MASK) | (1 << PS_CALLINC_SHIFT);
      const target4 = (((cpu.pc + 4) & ~3) + inst.imm) >>> 0;
      cpu.pc = ((cpu.pc & 0xc0000000) | (target4 & 0x3fffffff)) >>> 0;
      break;
    }

    case Opcode.CALL8: {
      // CALL8: store return address in caller's a8, set PS.CALLINC=2, jump
      const retAddr = ((cpu.pc + 3) & 0x3FFFFFFF) | (2 << 30);
      cpu.setAR(8, retAddr);
      cpu.specialRegisters[SR_PS] = (cpu.specialRegisters[SR_PS] & ~PS_CALLINC_MASK) | (2 << PS_CALLINC_SHIFT);
      const target8 = (((cpu.pc + 4) & ~3) + inst.imm) >>> 0;
      cpu.pc = ((cpu.pc & 0xc0000000) | (target8 & 0x3fffffff)) >>> 0;
      break;
    }

    case Opcode.CALL12: {
      // CALL12: store return address in caller's a12, set PS.CALLINC=3, jump
      const retAddr = ((cpu.pc + 3) & 0x3FFFFFFF) | (3 << 30);
      cpu.setAR(12, retAddr);
      cpu.specialRegisters[SR_PS] = (cpu.specialRegisters[SR_PS] & ~PS_CALLINC_MASK) | (3 << PS_CALLINC_SHIFT);
      const target12 = (((cpu.pc + 4) & ~3) + inst.imm) >>> 0;
      cpu.pc = ((cpu.pc & 0xc0000000) | (target12 & 0x3fffffff)) >>> 0;
      break;
    }

    case Opcode.CALLX0:
      cpu.setAR(0, cpu.pc + 3);
      cpu.pc = cpu.getAR(inst.s) >>> 0;
      break;

    case Opcode.CALLX4: {
      const target = cpu.getAR(inst.s) >>> 0;
      const retAddr = ((cpu.pc + 3) & 0x3FFFFFFF) | (1 << 30);
      cpu.setAR(4, retAddr);
      cpu.specialRegisters[SR_PS] = (cpu.specialRegisters[SR_PS] & ~PS_CALLINC_MASK) | (1 << PS_CALLINC_SHIFT);
      cpu.pc = target;
      break;
    }

    case Opcode.CALLX8: {
      const target = cpu.getAR(inst.s) >>> 0;
      const retAddr = ((cpu.pc + 3) & 0x3FFFFFFF) | (2 << 30);
      cpu.setAR(8, retAddr);
      cpu.specialRegisters[SR_PS] = (cpu.specialRegisters[SR_PS] & ~PS_CALLINC_MASK) | (2 << PS_CALLINC_SHIFT);
      cpu.pc = target;
      break;
    }

    case Opcode.CALLX12: {
      const target = cpu.getAR(inst.s) >>> 0;
      const retAddr = ((cpu.pc + 3) & 0x3FFFFFFF) | (3 << 30);
      cpu.setAR(12, retAddr);
      cpu.specialRegisters[SR_PS] = (cpu.specialRegisters[SR_PS] & ~PS_CALLINC_MASK) | (3 << PS_CALLINC_SHIFT);
      cpu.pc = target;
      break;
    }

    case Opcode.JX:
      cpu.pc = cpu.getAR(inst.s) >>> 0;
      break;

    // ===== ENTRY — function entry (allocate stack frame) =====
    case Opcode.ENTRY: {
      // ENTRY: read SP from caller's window, rotate window, write new SP
      // 1. Read a[s] from current (caller's) window
      const oldSP = cpu.getAR(inst.s);
      // 2. Get callinc from PS (set by preceding CALLn instruction)
      const callinc = (cpu.specialRegisters[SR_PS] & PS_CALLINC_MASK) >> PS_CALLINC_SHIFT;
      // 3. Rotate the window
      cpu.rotateWindowUp(callinc);
      // 4. Write new SP (old SP - frame size) to a[s] in new window
      const newSP = (oldSP - inst.imm) | 0;
      cpu.setAR(inst.s, newSP);
      cpu.pc += 3;
      break;
    }

    // ===== RET / RETW — return =====
    case Opcode.RET:
    case Opcode.RET_N:
      cpu.pc = cpu.getAR(0) >>> 0;
      break;

    case Opcode.RETW:
    case Opcode.RETW_N: {
      // Windowed return: extract callinc from return address (top 2 bits of a0)
      const retAddr = cpu.getAR(0);
      const n = (retAddr >>> 30) & 0x3;
      if (n === 0) {
        // Non-windowed return stored in a0
        cpu.pc = retAddr >>> 0;
      } else {
        // Rotate window back
        cpu.rotateWindowDown(n);
        // Reconstruct PC: top 2 bits from current PC, bottom 30 from return address
        cpu.pc = ((cpu.pc & 0xc0000000) | (retAddr & 0x3fffffff)) >>> 0;
      }
      break;
    }

    // ===== RFE — Return from exception =====
    case Opcode.RFE: {
      const epc1 = cpu.specialRegisters[177]; // EPC1
      cpu.specialRegisters[SR_PS] &= ~(1 << 4); // Clear EXCM
      cpu.pc = epc1 >>> 0;
      break;
    }

    case Opcode.RFI: {
      // Return from high-priority interrupt
      // Level from s field
      const level = inst.s;
      if (level >= 2 && level <= 7) {
        cpu.pc = (cpu.specialRegisters[177 + level - 1]) >>> 0; // EPC[level]
        cpu.specialRegisters[SR_PS] = cpu.specialRegisters[194 + level - 2]; // EPS[level]
      } else {
        cpu.pc += 3;
      }
      break;
    }

    // ===== RSR / WSR / XSR — Special Register access =====
    case Opcode.RSR:
      cpu.setAR(inst.t, cpu.specialRegisters[inst.imm & 0xff]);
      cpu.pc += 3;
      break;

    case Opcode.WSR:
      cpu.specialRegisters[inst.imm & 0xff] = cpu.getAR(inst.t);
      cpu.pc += 3;
      break;

    case Opcode.RUR:
      cpu.setAR(inst.r, cpu.userRegisters[inst.imm & 0xff]);
      cpu.pc += 3;
      break;

    case Opcode.WUR:
      cpu.userRegisters[inst.imm & 0xff] = cpu.getAR(inst.t);
      cpu.pc += 3;
      break;

    case Opcode.XSR: {
      const sr = inst.imm & 0xff;
      const old = cpu.specialRegisters[sr];
      cpu.specialRegisters[sr] = cpu.getAR(inst.t);
      cpu.setAR(inst.t, old);
      cpu.pc += 3;
      break;
    }

    // ===== BREAK / SYSCALL =====
    case Opcode.ROTW: {
      // ROTW: rotate window by signed immediate (used in context switch)
      const imm = inst.imm; // sign-extended 4-bit value (-8..7)
      const newWB = (cpu.specialRegisters[SR_WINDOWBASE] + imm) & 0xf;
      cpu.specialRegisters[SR_WINDOWBASE] = newWB;
      cpu.pc += 3;
      break;
    }

    case Opcode.BREAK:
      if (cpu.onBreak) cpu.onBreak(inst.s, inst.t);
      cpu.pc += 3;
      break;

    case Opcode.BREAK_N:
      if (cpu.onBreak) cpu.onBreak(inst.s, 0);
      cpu.pc += 2;
      break;

    case Opcode.SYSCALL:
      if (cpu.onSyscall) cpu.onSyscall();
      cpu.pc += 3;
      break;

    // ===== WAITI — halt until interrupt =====
    case Opcode.WAITI:
      cpu.halted = true;
      cpu.pc += 3;
      break;

    case Opcode.RSIL: {
      // RSIL: AR[t] ← PS; PS.INTLEVEL ← imm4
      const oldPS = cpu.specialRegisters[SR_PS];
      cpu.setAR(inst.t, oldPS);
      cpu.specialRegisters[SR_PS] = (oldPS & ~0xf) | (inst.imm & 0xf);
      cpu.pc += 3;
      break;
    }

    // ===== ILL — Illegal instruction =====
    case Opcode.ILL:
    case Opcode.ILLEGAL: {
      // Check if this is a null function pointer call (CALLX to uninitialized
      // address). If a0 has a valid windowed return address, simulate RETW.
      const retAddr = cpu.getAR(0);
      const n = (retAddr >>> 30) & 0x3;
      if (n > 0) {
        // Simulate RETW: rotate window back and return to caller
        cpu.rotateWindowDown(n);
        // Use 0x40000000 as segment base for code (IRAM/flash), since
        // the caller is always in the code segment even if CALLX jumped to DRAM
        cpu.pc = (0x40000000 | (retAddr & 0x3fffffff)) >>> 0;
        break;
      }
      cpu.raiseException(EXCCAUSE_ILLEGAL, cpu.pc);
      break;
    }

    // ===== Window overflow/underflow return =====
    case Opcode.RFWO:
    case Opcode.RFWU: {
      // Return from window overflow/underflow handler
      const ps = cpu.specialRegisters[SR_PS];
      cpu.specialRegisters[SR_PS] = ps & ~(1 << 4); // Clear EXCM
      // Restore WindowBase from PS.OWB
      const owb = (ps >> 8) & 0xf;
      cpu.specialRegisters[SR_WINDOWBASE] = owb;
      cpu.pc = cpu.specialRegisters[177] >>> 0; // EPC1
      break;
    }

    default:
      // Unimplemented instruction
      cpu.raiseException(EXCCAUSE_ILLEGAL, cpu.pc);
      break;
  }

  // Zero-overhead loop check: if PC == LEND and LCOUNT > 0, jump to LBEG
  if (cpu.specialRegisters[SR_LCOUNT] > 0 && cpu.pc === cpu.specialRegisters[SR_LEND]) {
    cpu.specialRegisters[SR_LCOUNT]--;
    cpu.pc = cpu.specialRegisters[SR_LBEG];
  }

  return true;
}
