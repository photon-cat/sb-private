// Xtensa LX6 Instruction Decoder
// Reference: Xtensa Instruction Set Architecture (ISA) Reference Manual
//
// Xtensa uses little-endian byte order. Instructions are 24-bit (3 bytes) or
// 16-bit (2 bytes, "narrow" or Code Density instructions).
//
// The op0 field (bits 3:0 of byte 0) is the primary dispatch:
//   op0=0: QRST group — RRR format (most ALU ops)
//   op0=1: L32R — PC-relative literal load
//   op0=2: LSAI — Load/Store with immediate offset
//   op0=3: LSCI — Load/Store Coprocessor
//   op0=4: MAC16 — Multiply-accumulate
//   op0=5: CALLN — Direct call (CALL0/CALL4/CALL8/CALL12)
//   op0=6: SI — Branch and special instructions
//   op0=7: B — Branch immediate group
//   op0=8: L32I.N (narrow)
//   op0=9: S32I.N (narrow)
//   op0=10: ADD.N (narrow)
//   op0=11: ADDI.N (narrow)
//   op0=12: ST2 narrow group (MOV.N, BEQZ.N, BNEZ.N, etc.)
//   op0=13: ST3 narrow group (MOVI.N, RET.N, BREAK.N, etc.)
//   op0=14-15: reserved

import { MemoryBus } from "../memory/memory-bus.js";

// Instruction opcodes (our internal representation)
export const enum Opcode {
  // Unknown / illegal
  ILLEGAL = 0,

  // ALU — RRR format (op0=0)
  ADD, SUB, ADDX2, ADDX4, ADDX8, SUBX2, SUBX4, SUBX8,
  AND, OR, XOR,
  MULL, MULUH, MULSH, QUOU, QUOS, REMU, REMS,
  SLLI, SRLI, SRAI, SRC, SLL, SRL, SRA, SSL, SSR, SSA8L, SSA8B, SSAI,
  CLAMPS, MIN, MINU, MAX, MAXU, ABS, NEG,
  NSA, NSAU,
  MOVEQZ, MOVNEZ, MOVLTZ, MOVGEZ,
  SEX, EXTUI,

  // System — RRR format (op0=0, op1=0, various op2)
  NOP, RET, RETW,
  RSR, WSR, XSR,
  RFE, RFUE, RFDE, RFWO, RFWU,
  MOVSP,
  BREAK, SYSCALL,
  RSYNC, ESYNC, DSYNC, ISYNC, MEMW, EXTW,
  RER, WER, RUR, WUR,
  WAITI, RSIL,
  ANY4, ALL4, ANY8, ALL8,
  RFI,
  RIFI, WITI,
  ROTW,
  MUL16U, MUL16S,

  // Entry
  ENTRY,

  // Load/Store — RRI8 format (op0=2)
  L8UI, L16UI, L16SI, L32I,
  S8I, S16I, S32I,

  // L32R — RI16 format (op0=1)
  L32R,

  // Load/Store — RRI4 (op0=2 subgroup)
  // Also MOVI, ADDI, ADDMI here
  MOVI,
  ADDI, ADDMI,

  // Branch — BRI8/BRI12 format (op0=6,7)
  BEQ, BNE, BGE, BLT, BGEU, BLTU,
  BEQZ, BNEZ, BGEZ, BLTZ,
  BEQI, BNEI, BGEI, BLTI, BGEUI, BLTUI,
  BBCI, BBSI,
  BALL, BNALL, BANY, BNONE,
  BBC, BBS,

  // Unconditional jump
  J,

  // Call (op0=5)
  CALL0, CALL4, CALL8, CALL12,
  CALLX0, CALLX4, CALLX8, CALLX12, JX,

  // Loop
  LOOP, LOOPNEZ, LOOPGTZ,

  // Narrow instructions (16-bit)
  ADD_N, ADDI_N, L32I_N, S32I_N, MOV_N, MOVI_N,
  RET_N, RETW_N,
  BEQZ_N, BNEZ_N,
  BREAK_N,
  NOP_N,

  // Store conditional / load reserved
  S32C1I, L32E, S32E,

  // ILL — explicitly illegal instruction
  ILL,

  // S32RI — store with release
  S32RI,

  // Misc
  DPFR, DPFW, DPFRO, DPFWO, DHWB, DHWBI, DHI, DII,
  IPFL, IHU, IHI, III,
  LICT, SICT, LICW, SICW,

  // Processor sync
  LDCT, SDCT,
}

export interface DecodedInstruction {
  op: Opcode;
  // Length in bytes (2 or 3)
  len: 2 | 3;
  // Register fields
  r: number;
  s: number;
  t: number;
  // Immediate value (sign-extended where appropriate)
  imm: number;
  // Raw bytes for debug
  raw: number;
}

// Sign-extend helpers
function sext8(v: number): number {
  return (v << 24) >> 24;
}
function sext12(v: number): number {
  return (v << 20) >> 20;
}
function sext16(v: number): number {
  return (v << 16) >> 16;
}
function sext18(v: number): number {
  return (v << 14) >> 14;
}

// B4CONST table (for BEQI, BNEI, etc.)
const B4CONST = [
  -1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256
];

// B4CONSTU table (for unsigned branch comparisons)
const B4CONSTU = [
  32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256
];

export { B4CONST, B4CONSTU };

export function decode(memory: MemoryBus, pc: number): DecodedInstruction {
  const b0 = memory.read8(pc);
  const op0 = b0 & 0xf;

  // Narrow instructions: op0 >= 8 → 16-bit
  if (op0 >= 8) {
    const b1 = memory.read8(pc + 1);
    return decodeNarrow(op0, b0, b1);
  }

  // 24-bit instruction
  const b1 = memory.read8(pc + 1);
  const b2 = memory.read8(pc + 2);
  const raw = b0 | (b1 << 8) | (b2 << 16);

  // Common field extraction for 24-bit instructions:
  // t = bits[7:4] = (b0 >> 4) & 0xf
  // s = bits[11:8] = b1 & 0xf
  // r = bits[15:12] = (b1 >> 4) & 0xf
  // op1 = bits[19:16] = b2 & 0xf
  // op2 = bits[23:20] = (b2 >> 4) & 0xf
  const t = (b0 >> 4) & 0xf;
  const s = b1 & 0xf;
  const r = (b1 >> 4) & 0xf;
  const op1 = b2 & 0xf;
  const op2 = (b2 >> 4) & 0xf;

  const inst: DecodedInstruction = { op: Opcode.ILLEGAL, len: 3, r, s, t, imm: 0, raw };

  switch (op0) {
    case 0: // QRST — RRR format
      decodeQRST(inst, op1, op2, r, s, t, raw);
      break;

    case 1: // L32R — RI16 format
      // imm16 = bits[23:8] → sign-extended, shifted left 2, added to (PC+3 aligned down to 4)
      inst.op = Opcode.L32R;
      inst.t = t;
      inst.imm = sext16((b1 | (b2 << 8)));
      break;

    case 2: // LSAI — load/store with 8-bit immediate
      decodeLSAI(inst, r, s, t, b2);
      break;

    case 3: // LSCI — load/store coprocessor (stub)
      inst.op = Opcode.ILLEGAL;
      break;

    case 4: // MAC16 — multiply-accumulate
      inst.op = Opcode.ILLEGAL; // TODO
      break;

    case 5: // CALLN — CALL0/CALL4/CALL8/CALL12
      // n = bits[5:4] (within call format)
      // offset = bits[23:6] sign-extended, shifted left 2
      {
        const n = (b0 >> 4) & 0x3;
        const offset18 = ((b0 >> 6) & 0x3) | ((b1 << 2)) | ((b2 << 10));
        inst.imm = sext18(offset18) << 2;
        switch (n) {
          case 0: inst.op = Opcode.CALL0; break;
          case 1: inst.op = Opcode.CALL4; break;
          case 2: inst.op = Opcode.CALL8; break;
          case 3: inst.op = Opcode.CALL12; break;
        }
      }
      break;

    case 6: // SI group — branches with 8-bit offset, etc.
      decodeSI(inst, op1, op2, r, s, t, b2, raw);
      break;

    case 7: // B group — branches with immediate test
      decodeB(inst, r, s, t, b2, raw);
      break;

    default:
      inst.op = Opcode.ILLEGAL;
  }

  return inst;
}

function decodeNarrow(op0: number, b0: number, b1: number): DecodedInstruction {
  const t = (b0 >> 4) & 0xf;
  const s = b1 & 0xf;
  const r = (b1 >> 4) & 0xf;
  const raw = b0 | (b1 << 8);
  const inst: DecodedInstruction = { op: Opcode.ILLEGAL, len: 2, r, s, t, imm: 0, raw };

  switch (op0) {
    case 8: // L32I.N
      inst.op = Opcode.L32I_N;
      inst.imm = r << 2; // 4-bit offset * 4
      break;

    case 9: // S32I.N
      inst.op = Opcode.S32I_N;
      inst.imm = r << 2;
      break;

    case 10: // ADD.N
      inst.op = Opcode.ADD_N;
      break;

    case 11: // ADDI.N — imm is in t field (not r!)
      // ADDI.N ar, as, imm: r=dest, s=src, t=imm (0 encodes as -1)
      inst.op = Opcode.ADDI_N;
      inst.imm = t === 0 ? -1 : t;
      break;

    case 12: // ST2 — MOVI.N, BEQZ.N, BNEZ.N
      {
        // Sub-dispatch on t[3:2] (= bits 7:6 of byte 0):
        //   0x: MOVI.N — bit7=0 (sub 0 or 1), dest=s, imm7=(t[2:0]<<4)|r
        //   10: BEQZ.N — bit7=1, bit6=0, s=source, imm6 = (t[1:0]<<4)|r
        //   11: BNEZ.N — bit7=1, bit6=1, s=source, imm6 = (t[1:0]<<4)|r
        const sub = (t >> 2) & 0x3;
        switch (sub) {
          case 0: // MOVI.N (bit7=0, bit6=0)
          case 1: // MOVI.N (bit7=0, bit6=1) — bit6 is part of imm
            inst.op = Opcode.MOVI_N;
            inst.s = s; // dest register
            {
              const imm = ((t & 7) << 4) | r; // 7 bits: t[2:0] << 4 | r
              // MOVI.N value encoding: 0-31 → 0-31, 32-95 → 32-95, 96-127 → -32..-1
              inst.imm = imm >= 96 ? imm - 128 : imm;
            }
            break;
          case 2: // BEQZ.N
            inst.op = Opcode.BEQZ_N;
            inst.s = s;
            inst.imm = ((t & 3) << 4) | r;
            break;
          case 3: // BNEZ.N
            inst.op = Opcode.BNEZ_N;
            inst.s = s;
            inst.imm = ((t & 3) << 4) | r;
            break;
        }
      }
      break;

    case 13: // ST3 — MOV.N and special group
      {
        // r=0xf: special sub-group (RET.N, RETW.N, BREAK.N, NOP.N)
        // r!=0xf: MOV.N at, as (t=dest, s=src)
        if (r === 0xf) {
          // Dispatch on s and t fields:
          //   s=0, t=0: RET.N   (bytes: 0x0d, 0xf0)
          //   s=0, t=1: RETW.N  (bytes: 0x1d, 0xf0)
          //   s=0, t=3: NOP.N   (bytes: 0x3d, 0xf0)
          //   s=2:      BREAK.N (bytes: (t<<4)|0xd, 0xf2)
          if (s === 0) {
            switch (t) {
              case 0: inst.op = Opcode.RET_N; break;
              case 1: inst.op = Opcode.RETW_N; break;
              case 3: inst.op = Opcode.NOP_N; break;
              default: inst.op = Opcode.ILLEGAL; break;
            }
          } else if (s === 2) {
            inst.op = Opcode.BREAK_N;
            inst.imm = t;
          } else {
            inst.op = Opcode.ILLEGAL;
          }
        } else {
          inst.op = Opcode.MOV_N;
        }
      }
      break;

    default:
      inst.op = Opcode.ILLEGAL;
  }

  return inst;
}

function decodeQRST(
  inst: DecodedInstruction,
  op1: number, op2: number,
  r: number, s: number, t: number,
  raw: number
): void {
  switch (op1) {
    case 0: // RST0
      switch (op2) {
        case 0: // SNM0/ST — system ops, CALLX, JX, RET
          switch (r) {
            case 0: {
              // SNM0 group: decode by t field directly
              switch (t) {
                case 0: inst.op = Opcode.ILL; break;
                case 8: inst.op = Opcode.RET; break;
                case 9: inst.op = Opcode.RETW; break;
                case 10: inst.op = Opcode.JX; break;
                case 12: inst.op = Opcode.CALLX0; break;
                case 13: inst.op = Opcode.CALLX4; break;
                case 14: inst.op = Opcode.CALLX8; break;
                case 15: inst.op = Opcode.CALLX12; break;
                default: inst.op = Opcode.ILLEGAL; break;
              }
              break;
            }
            case 1: // MOVSP
              inst.op = Opcode.MOVSP;
              break;
            case 2: // SYNC group — dispatch on t
              switch (t) {
                case 0: inst.op = Opcode.ISYNC; break;
                case 1: inst.op = Opcode.RSYNC; break;
                case 2: inst.op = Opcode.ESYNC; break;
                case 3: inst.op = Opcode.DSYNC; break;
                case 8: inst.op = Opcode.EXTW; break;  // EXCW
                case 12: inst.op = Opcode.MEMW; break;
                case 13: inst.op = Opcode.EXTW; break;
                case 15: inst.op = Opcode.NOP; break;
                default: inst.op = Opcode.ILLEGAL; break;
              }
              break;
            case 3: // RFE/RFUE/RFDE/RFWO/RFWU/RFI — dispatch on s,t
              switch (s) {
                case 0:
                  if (t === 0) inst.op = Opcode.RFE;
                  else inst.op = Opcode.RFI; // RFI level=t
                  break;
                case 1: inst.op = Opcode.RFUE; break;
                case 2: inst.op = Opcode.RFDE; break;
                case 4: inst.op = Opcode.RFWO; break;
                case 5: inst.op = Opcode.RFWU; break;
                default: inst.op = Opcode.ILLEGAL; break;
              }
              break;
            case 4: inst.op = Opcode.BREAK; break;
            case 5: inst.op = Opcode.SYSCALL; break;
            case 6: // RSIL — read/set interrupt level
              inst.op = Opcode.RSIL;
              inst.imm = s; // new interrupt level (0-15)
              break;
            case 7: inst.op = Opcode.WAITI; break;
            default: inst.op = Opcode.ILLEGAL; break;
          }
          break;
        case 1: // AND
          inst.op = Opcode.AND; break;
        case 2: // OR
          inst.op = Opcode.OR; break;
        case 3: // XOR
          inst.op = Opcode.XOR; break;
        case 4: // ST1 sub-group
          switch (r) {
            case 0: inst.op = Opcode.SSR; break;
            case 1: inst.op = Opcode.SSL; break;
            case 2: inst.op = Opcode.SSA8L; break;
            case 3: inst.op = Opcode.SSA8B; break;
            case 4: inst.op = Opcode.SSAI; inst.imm = (s | ((t & 1) << 4)); break;
            case 6: inst.op = Opcode.RER; break;
            case 7: inst.op = Opcode.WER; break;
            case 8: inst.op = Opcode.ROTW; inst.imm = sext8(s << 4) >> 4; break;
            case 14: inst.op = Opcode.NSA; break;
            case 15: inst.op = Opcode.NSAU; break;
            default: inst.op = Opcode.ILLEGAL; break;
          }
          break;
        case 5: // TLB group — WITLB, RITLB0, RITLB1, PITLB, WDTLB, RDTLB0, RDTLB1, PDTLB
          // Treated as NOPs since we don't emulate the MMU/TLB
          inst.op = Opcode.NOP;
          break;
        case 6: // RT0 group — NEG, ABS, etc.
          switch (s) {
            case 0: inst.op = Opcode.NEG; break;
            case 1: inst.op = Opcode.ABS; break;
            default: inst.op = Opcode.ILLEGAL; break;
          }
          break;
        case 7: // reserved
          inst.op = Opcode.ILLEGAL; break;
        case 8: inst.op = Opcode.ADD; break;
        case 9: inst.op = Opcode.ADDX2; break;
        case 10: inst.op = Opcode.ADDX4; break;
        case 11: inst.op = Opcode.ADDX8; break;
        case 12: inst.op = Opcode.SUB; break;
        case 13: inst.op = Opcode.SUBX2; break;
        case 14: inst.op = Opcode.SUBX4; break;
        case 15: inst.op = Opcode.SUBX8; break;
        default: inst.op = Opcode.ILLEGAL; break;
      }
      break;

    case 1: // RST1 — shifts, conditional moves, CLAMPS, etc.
      switch (op2) {
        case 0: // SLLI (sa[4]=0, shift 17..32)
          inst.op = Opcode.SLLI;
          // sa = (op2[0] << 4) | t, shift = 32 - sa
          inst.imm = 32 - t;
          if (inst.imm <= 0) inst.imm += 32;
          break;
        case 1: // SLLI (sa[4]=1, shift 1..16)
          inst.op = Opcode.SLLI;
          inst.imm = 32 - (16 + t);
          if (inst.imm <= 0) inst.imm += 32;
          break;
        case 2: // SRAI (sa < 16)
          inst.op = Opcode.SRAI;
          inst.imm = s;
          break;
        case 3: // SRAI (sa >= 16)
          inst.op = Opcode.SRAI;
          inst.imm = s + 16;
          break;
        case 4: // SRLI
          inst.op = Opcode.SRLI;
          inst.imm = s;
          break;
        case 6: { // XSR — Exchange Special Register
          const sr = (r << 4) | s;
          inst.imm = sr;
          inst.op = Opcode.XSR;
          break;
        }
        case 7: // ACCER group
          inst.op = Opcode.ILLEGAL; break;
        case 8: inst.op = Opcode.SRC; break; // SRC (shift register combine)
        case 9: // SRL ar, at — s=0 fixed
          if (s === 0) inst.op = Opcode.SRL;
          else inst.op = Opcode.ILLEGAL;
          break;
        case 10: // SLL ar, as — t=0 fixed, r=dest, s=source
          if (t === 0) inst.op = Opcode.SLL;
          else inst.op = Opcode.ILLEGAL;
          break;
        case 11: // SRA ar, at — s=0 fixed, r=dest, t=source
          if (s === 0) inst.op = Opcode.SRA;
          else inst.op = Opcode.ILLEGAL;
          break;
        case 12: inst.op = Opcode.MUL16U; break; // not in our enum, use ILLEGAL for now
        case 13: inst.op = Opcode.MUL16S; break; // same
        case 14: // CLAMPS
          inst.op = Opcode.CLAMPS;
          inst.imm = r + 7; // clamp to -(2^(r+7)) .. (2^(r+7)-1)
          break;
        case 15:
          switch (r) {
            case 0: inst.op = Opcode.MOVEQZ; break;
            case 1: inst.op = Opcode.MOVNEZ; break;
            case 2: inst.op = Opcode.MOVLTZ; break;
            case 3: inst.op = Opcode.MOVGEZ; break;
            default: inst.op = Opcode.ILLEGAL; break;
          }
          break;
        default: inst.op = Opcode.ILLEGAL; break;
      }
      break;

    case 2: // RST2 — multiply, divide
      switch (op2) {
        case 8: inst.op = Opcode.MULL; break;
        case 10: inst.op = Opcode.MULUH; break;
        case 11: inst.op = Opcode.MULSH; break;
        case 12: inst.op = Opcode.QUOU; break;
        case 13: inst.op = Opcode.QUOS; break;
        case 14: inst.op = Opcode.REMU; break;
        case 15: inst.op = Opcode.REMS; break;
        default: inst.op = Opcode.ILLEGAL; break;
      }
      break;

    case 3: // RSR/WSR + MIN/MAX/SEXT/CLAMPS + conditional moves
      {
        switch (op2) {
          case 0: // RSR
          case 1: { // WSR
            const sr = (r << 4) | s;
            inst.imm = sr;
            inst.op = op2 === 0 ? Opcode.RSR : Opcode.WSR;
            break;
          }
          case 2: { // SEXT: ar[r] ← sign_extend(ar[s], t+7)
            inst.imm = t + 7; // bit position for sign extension (7..22)
            inst.op = Opcode.SEX;
            break;
          }
          case 3: { // CLAMPS: ar[r] ← clamp(ar[s], -(2^(t+7)), 2^(t+7)-1)
            inst.imm = t + 7;
            inst.op = Opcode.CLAMPS;
            break;
          }
          case 4: inst.op = Opcode.MIN; break;
          case 5: inst.op = Opcode.MAX; break;
          case 6: inst.op = Opcode.MINU; break;
          case 7: inst.op = Opcode.MAXU; break;
          case 8: inst.op = Opcode.MOVEQZ; break;
          case 9: inst.op = Opcode.MOVNEZ; break;
          case 10: inst.op = Opcode.MOVLTZ; break;
          case 11: inst.op = Opcode.MOVGEZ; break;
          case 14: { // RUR — Read User Register: ar[r] ← UR[(s << 4) | t]
            inst.op = Opcode.RUR;
            inst.imm = (s << 4) | t; // user register number
            break;
          }
          case 15: { // WUR — Write User Register: UR[(s << 4) | r] ← ar[t]
            inst.op = Opcode.WUR;
            inst.imm = (s << 4) | r; // user register number
            break;
          }
          default: inst.op = Opcode.ILLEGAL; break;
        }
      }
      break;

    case 4: // EXTUI
      // EXTUI at,as,shiftimm,maskimm
      // op1=4 for shift 0-15, op1=5 for shift 16-31 (but we handle based on encoding)
      {
        inst.op = Opcode.EXTUI;
        // shift amount from s field area + op1 high bit
        // Actually: op0=0, op1=4(shift<16) or 5(shift>=16), op2=bits telling mask
        // EXTUI encoding: shift=s|((op1&1)<<4)=sa[4:0], mask_size=op2+1
        // Wait, this doesn't match. Let me reconsider.
        // EXTUI: op0=0, op1[3:1]=010, op1[0]=sa4, op2=maskbits-1
        // So if op1=4: sa4=0, if op1=5: sa4=1
        const shift = s | ((op1 & 1) << 4);
        const mask = op2 + 1;
        inst.imm = shift;
        inst.r = r; // mask size stored in r... no, op2 is mask
        // Let me store shift in imm low bits, mask in high bits
        inst.imm = shift | (mask << 8);
      }
      break;

    case 5: // same EXTUI range
      {
        inst.op = Opcode.EXTUI;
        const shift = s | ((op1 & 1) << 4);
        const mask = op2 + 1;
        inst.imm = shift | (mask << 8);
      }
      break;

    case 6: // RST3 — XSR lives here, plus more
      {
        const sr = (r << 4) | s;
        inst.imm = sr;
        switch (op2) {
          case 0: inst.op = Opcode.RSR; break; // duplicate? Actually RSR might be at op1=3
          case 1: inst.op = Opcode.XSR; break;
          default: inst.op = Opcode.ILLEGAL; break;
        }
      }
      break;

    case 9: // S32E/L32E — exception store/load
      if (op2 === 4) {
        inst.op = Opcode.S32E;
        inst.imm = (r - 16) * 4; // negative offset: -64 to -4
      } else if (op2 === 0) {
        inst.op = Opcode.L32E;
        inst.imm = (r - 16) * 4;
      } else {
        inst.op = Opcode.ILLEGAL;
      }
      break;

    default:
      inst.op = Opcode.ILLEGAL;
      break;
  }
}

function decodeLSAI(
  inst: DecodedInstruction,
  r: number, s: number, t: number,
  b2: number
): void {
  // op0=2, r field = sub-opcode, imm8 = byte2
  const imm8 = b2;
  inst.imm = imm8;

  switch (r) {
    case 0: // L8UI
      inst.op = Opcode.L8UI; break;
    case 1: // L16UI
      inst.op = Opcode.L16UI;
      inst.imm = imm8 << 1; // offset * 2
      break;
    case 2: // L32I
      inst.op = Opcode.L32I;
      inst.imm = imm8 << 2; // offset * 4
      break;
    case 4: // S8I
      inst.op = Opcode.S8I; break;
    case 5: // S16I
      inst.op = Opcode.S16I;
      inst.imm = imm8 << 1;
      break;
    case 6: // S32I
      inst.op = Opcode.S32I;
      inst.imm = imm8 << 2;
      break;
    case 7: // DPFR/DPFW/etc cache ops
      inst.op = Opcode.NOP; // Treat cache prefetch as NOP
      break;
    case 9: // L16SI
      inst.op = Opcode.L16SI;
      inst.imm = imm8 << 1;
      break;
    case 10: // MOVI — move immediate
      inst.op = Opcode.MOVI;
      // MOVI at, imm12: dest is t field, imm12 = sign_extend_12((s << 8) | byte2)
      inst.imm = sext12((s << 8) | imm8);
      break;
    case 11: // L32AI — load acquire (treat as regular L32I)
      inst.op = Opcode.L32I;
      inst.imm = imm8 << 2;
      break;
    case 12: // ADDI
      inst.op = Opcode.ADDI;
      inst.imm = sext8(imm8);
      break;
    case 13: // ADDMI
      inst.op = Opcode.ADDMI;
      inst.imm = sext8(imm8) << 8; // shifted by 8
      break;
    case 14: // S32C1I — store conditional
      inst.op = Opcode.S32C1I;
      inst.imm = imm8 << 2;
      break;
    case 15: // S32RI — store release
      inst.op = Opcode.S32RI;
      inst.imm = imm8 << 2;
      break;
    default:
      inst.op = Opcode.ILLEGAL;
      break;
  }
}

function decodeSI(
  inst: DecodedInstruction,
  op1: number, op2: number,
  r: number, s: number, t: number,
  b2: number, raw: number
): void {
  // op0=6 — SI group
  // n = bits[5:4] of byte0 = t[1:0]
  // op1 = bits[19:16] differentiates sub-groups
  const n = t & 0x3;

  switch (n) {
    case 0: // J — unconditional jump
      // offset18 = bits[23:6] sign-extended, shifted left by... no:
      // J: op0=6, bits[5:4]=0, offset = sign_extend_18(bits[23:6])
      {
        inst.op = Opcode.J;
        const offset18 = ((raw >> 6) & 0x3ffff);
        inst.imm = sext18(offset18);
      }
      break;

    case 1: // BZ group — BEQZ, BNEZ, BLTZ, BGEZ
      // BRI12 format: 12-bit offset
      {
        // m = bits[5:4] actually n=1 means BZ, and bits[7:6]= sub-select
        // Actually for op0=6, n=t[1:0]:
        // n=0: J
        // n=1: BZ class (BEQZ, BNEZ, BLTZ, BGEZ)
        // n=2: BI0 class (BEQI, BNEI, BLTI, BGEI)
        // n=3: BI1 class (various with unsigned)
        // For BZ: m = t[3:2] selects which BZ
        const m = (t >> 2) & 0x3;
        // 12-bit signed offset = bits[23:12] ... actually:
        // BRI12: imm12 = byte2 << 4 | r (bits 23:16 = b2, bits 15:12 = r)
        // offset = sign_extend_12(imm12)
        const imm12 = (b2 << 4) | r;
        inst.imm = sext12(imm12);
        switch (m) {
          case 0: inst.op = Opcode.BEQZ; break;
          case 1: inst.op = Opcode.BNEZ; break;
          case 2: inst.op = Opcode.BLTZ; break;
          case 3: inst.op = Opcode.BGEZ; break;
        }
      }
      break;

    case 2: // BI0 — BEQI, BNEI, BLTI, BGEI
      {
        const m = (t >> 2) & 0x3;
        const imm8 = b2;
        inst.imm = sext8(imm8); // branch offset
        // r field contains the B4CONST index
        inst.r = r; // register index for source
        // s is the register, r is the B4CONST index
        // Actually: for BEQI etc., s = register, r = b4const_index, imm8 = offset
        switch (m) {
          case 0: inst.op = Opcode.BEQI; break;
          case 1: inst.op = Opcode.BNEI; break;
          case 2: inst.op = Opcode.BLTI; break;
          case 3: inst.op = Opcode.BGEI; break;
        }
      }
      break;

    case 3: // BI1 — ENTRY, BLTUI, BGEUI, etc.
      {
        const m = (t >> 2) & 0x3;
        switch (m) {
          case 0: // ENTRY
            inst.op = Opcode.ENTRY;
            // ENTRY as,imm12: s = register, imm12 = (b2 << 4 | r) << 3 (frame size)
            inst.imm = ((b2 << 4) | r) << 3;
            break;
          case 1:
            // B1 sub-group — LOOP, LOOPNEZ, LOOPGTZ, etc.
            {
              // r field differentiates
              const sub = r;
              inst.imm = sext8(b2); // 8-bit offset
              switch (sub) {
                case 0: inst.op = Opcode.LOOP; break;
                case 1: inst.op = Opcode.LOOPNEZ; break;
                case 2: inst.op = Opcode.LOOPGTZ; break;
                default: inst.op = Opcode.ILLEGAL; break;
              }
            }
            break;
          case 2: inst.op = Opcode.BLTUI; inst.imm = sext8(b2); break;
          case 3: inst.op = Opcode.BGEUI; inst.imm = sext8(b2); break;
        }
      }
      break;
  }
}

function decodeB(
  inst: DecodedInstruction,
  r: number, s: number, t: number,
  b2: number, raw: number
): void {
  // op0=7 — B group
  // Uses BRI8 format: r = sub-opcode, imm8 = b2, s and t are register fields
  const imm8 = b2;
  inst.imm = sext8(imm8); // signed branch offset

  switch (r) {
    case 0: inst.op = Opcode.BNONE; break;
    case 1: inst.op = Opcode.BEQ; break;
    case 2: inst.op = Opcode.BLT; break;
    case 3: inst.op = Opcode.BLTU; break;
    case 4: inst.op = Opcode.BALL; break;
    case 5: inst.op = Opcode.BBC; break;
    case 6: // BBCI — bit[4]=0, bit index = t (0-15)
      inst.op = Opcode.BBCI;
      inst.imm = sext8(imm8); // branch offset
      inst.t = t; // bit index (0-15)
      break;
    case 7: // BBCI — bit[4]=1, bit index = 16+t
      inst.op = Opcode.BBCI;
      inst.imm = sext8(imm8);
      inst.t = 16 + t; // bit index (16-31)
      break;
    case 8: inst.op = Opcode.BANY; break;
    case 9: inst.op = Opcode.BNE; break;
    case 10: inst.op = Opcode.BGE; break;
    case 11: inst.op = Opcode.BGEU; break;
    case 12: inst.op = Opcode.BNALL; break;
    case 13: inst.op = Opcode.BBS; break;
    case 14: // BBSI — bit[4]=0, bit index = t (0-15)
      inst.op = Opcode.BBSI;
      inst.imm = sext8(imm8);
      inst.t = t; // bit index (0-15)
      break;
    case 15: // BBSI — bit[4]=1, bit index = 16+t
      inst.op = Opcode.BBSI;
      inst.imm = sext8(imm8);
      inst.t = 16 + t; // bit index (16-31)
      break;
    default:
      inst.op = Opcode.ILLEGAL;
  }
}
