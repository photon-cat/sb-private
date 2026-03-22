// Diagnostic: trace the boot sequence to find where it derails
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ESP32CPU, SR_EXCCAUSE, SR_EXCVADDR, SR_PS, SR_VECBASE, SR_WINDOWBASE, SR_WINDOWSTART, SR_EPC1 } from "../src/cpu/cpu.js";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { loadESP32Bin } from "../src/memory/flash.js";
import { decode, Opcode } from "../src/cpu/xtensa-decoder.js";
import { executeInstruction } from "../src/cpu/xtensa-execute.js";
import { ESP32Runner } from "../src/index.js";
import { handleRomCall } from "../src/stubs/rom-functions.js";

const FIRMWARE_PATH = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");

describe("Boot Trace Diagnostics", () => {
  it("should trace first 200 instructions with full detail", () => {
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner(binData);
    const cpu = runner.cpu;
    const mem = cpu.memory;

    const trace: string[] = [];
    let exceptions = 0;
    let illegalOps = 0;
    let romCalls = 0;
    const pcHistory: number[] = [];
    const exceptionPCs: number[] = [];
    const unknownOpcodes = new Map<number, number>(); // raw -> count

    const origOnException = cpu.onException;
    cpu.onException = (cause, vaddr) => {
      exceptions++;
      exceptionPCs.push(cpu.pc);
      trace.push(`  !! EXCEPTION cause=${cause} vaddr=0x${vaddr.toString(16)} at PC=0x${(cpu.specialRegisters[SR_EPC1] >>> 0).toString(16)}`);
      if (origOnException) origOnException(cause, vaddr);
    };

    for (let i = 0; i < 2000; i++) {
      const pc = cpu.pc;
      pcHistory.push(pc);

      // Check for ROM call
      const romHandled = handleRomCall(cpu, pc, {
        onPrintf: (text) => trace.push(`  [ROM] ets_printf: "${text}"`),
      });
      if (romHandled) romCalls++;

      // Decode before execute for tracing
      let inst;
      try {
        inst = decode(mem, pc);
      } catch (e) {
        trace.push(`  [${i}] PC=0x${pc.toString(16)} DECODE ERROR: ${e}`);
        break;
      }

      const opName = Opcode[inst.op] || `UNKNOWN(${inst.op})`;
      if (i < 50 || inst.op === Opcode.ILLEGAL || inst.op === Opcode.ILL) {
        trace.push(`  [${i}] PC=0x${pc.toString(16)} ${opName} r=${inst.r} s=${inst.s} t=${inst.t} imm=${inst.imm} (raw=0x${inst.raw.toString(16)})`);
      }

      if (inst.op === Opcode.ILLEGAL || inst.op === Opcode.ILL) {
        illegalOps++;
        const raw = inst.raw;
        unknownOpcodes.set(raw, (unknownOpcodes.get(raw) || 0) + 1);
      }

      // Execute
      const ok = executeInstruction(cpu);
      if (!ok) {
        trace.push(`  [${i}] HALTED at PC=0x${pc.toString(16)}`);
        break;
      }
    }

    console.log("\n=== BOOT TRACE (first 50 + exceptions/illegals) ===");
    for (const line of trace) console.log(line);

    console.log(`\n=== SUMMARY ===`);
    console.log(`  Total exceptions: ${exceptions}`);
    console.log(`  Illegal instructions: ${illegalOps}`);
    console.log(`  ROM calls intercepted: ${romCalls}`);
    console.log(`  Final PC: 0x${cpu.pc.toString(16)}`);
    console.log(`  EXCCAUSE: ${cpu.specialRegisters[SR_EXCCAUSE]}`);
    console.log(`  VECBASE: 0x${(cpu.specialRegisters[SR_VECBASE] >>> 0).toString(16)}`);
    console.log(`  WINDOWBASE: ${cpu.specialRegisters[SR_WINDOWBASE]}`);

    if (exceptionPCs.length > 0) {
      console.log(`  Exception PCs: ${exceptionPCs.map(p => '0x' + p.toString(16)).join(', ')}`);
    }

    if (unknownOpcodes.size > 0) {
      console.log(`  Unknown opcode raw values:`);
      for (const [raw, count] of unknownOpcodes) {
        const b0 = raw & 0xff, b1 = (raw >> 8) & 0xff, b2 = (raw >> 16) & 0xff;
        const op0 = b0 & 0xf;
        console.log(`    0x${raw.toString(16)} (op0=${op0}, bytes=${b0.toString(16)} ${b1.toString(16)} ${b2.toString(16)}) x${count}`);
      }
    }

    // Check: where do we keep looping?
    const pcCounts = new Map<number, number>();
    for (const pc of pcHistory) {
      pcCounts.set(pc, (pcCounts.get(pc) || 0) + 1);
    }
    const hotPCs = [...pcCounts.entries()].filter(([_, c]) => c > 2).sort((a, b) => b[1] - a[1]);
    if (hotPCs.length > 0) {
      console.log(`  Hot PCs (visited >2x):`);
      for (const [pc, count] of hotPCs.slice(0, 10)) {
        const inst = decode(mem, pc);
        console.log(`    0x${pc.toString(16)}: ${Opcode[inst.op]} x${count}`);
      }
    }
  });

  it("should trace with longer run and check for serial output", () => {
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner(binData);
    const cpu = runner.cpu;
    const mem = cpu.memory;

    const serialChars: number[] = [];
    runner.onSerialOutput = (ch) => serialChars.push(ch);

    let exceptions = 0;
    let lastExcPC = 0;
    let firstExcPC = 0;
    const illegalPCs = new Set<number>();

    cpu.onException = (cause, vaddr) => {
      exceptions++;
      if (firstExcPC === 0) firstExcPC = cpu.specialRegisters[SR_EPC1] >>> 0;
      lastExcPC = cpu.specialRegisters[SR_EPC1] >>> 0;

      // Log the faulting instruction
      try {
        const inst = decode(mem, vaddr);
        if (inst.op === Opcode.ILLEGAL || inst.op === Opcode.ILL) {
          illegalPCs.add(vaddr);
        }
      } catch {}
    };

    // Run 100K cycles
    for (let i = 0; i < 100000; i++) {
      const pc = cpu.pc;
      handleRomCall(cpu, pc, {
        onPrintf: (text) => {
          for (let j = 0; j < text.length; j++) {
            serialChars.push(text.charCodeAt(j));
          }
        },
      });

      if (!executeInstruction(cpu)) {
        // Try to continue past halt
        cpu.halted = false;
        cpu.pc += 3;
      }
    }

    const serialStr = String.fromCharCode(...serialChars.filter(c => c >= 32 && c < 127 || c === 10));
    console.log(`\n=== 100K CYCLE RUN ===`);
    console.log(`  Final PC: 0x${cpu.pc.toString(16)}`);
    console.log(`  Cycles: ${cpu.cycles}`);
    console.log(`  Exceptions: ${exceptions}`);
    console.log(`  First exception at: 0x${firstExcPC.toString(16)}`);
    console.log(`  Last exception at: 0x${lastExcPC.toString(16)}`);
    console.log(`  Unique illegal instruction PCs: ${illegalPCs.size}`);
    if (illegalPCs.size > 0) {
      const sorted = [...illegalPCs].sort((a, b) => a - b);
      for (const pc of sorted.slice(0, 20)) {
        const b0 = mem.read8(pc), b1 = mem.read8(pc + 1), b2 = mem.read8(pc + 2);
        console.log(`    0x${pc.toString(16)}: bytes ${b0.toString(16)} ${b1.toString(16)} ${b2.toString(16)} (op0=${b0 & 0xf})`);
      }
    }
    console.log(`  Serial output (${serialChars.length} chars): "${serialStr.slice(0, 500)}"`);
  });

  it("should identify the exact instruction that causes first exception", () => {
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner(binData);
    const cpu = runner.cpu;
    const mem = cpu.memory;

    let exceptionHit = false;
    let faultPC = 0;
    let faultCause = 0;
    let prevPCs: number[] = [];

    cpu.onException = (cause, vaddr) => {
      if (!exceptionHit) {
        exceptionHit = true;
        faultPC = cpu.specialRegisters[SR_EPC1] >>> 0;
        faultCause = cause;
      }
    };

    for (let i = 0; i < 10000; i++) {
      const pc = cpu.pc;
      prevPCs.push(pc);
      if (prevPCs.length > 20) prevPCs.shift();

      // Log RETW/RETW_N with window state
      const inst = decode(mem, pc);
      if (inst.op === Opcode.RETW || inst.op === Opcode.RETW_N) {
        const a0 = cpu.getAR(0);
        const wb = cpu.specialRegisters[SR_WINDOWBASE];
        const ws = cpu.specialRegisters[SR_WINDOWSTART];
        const n = (a0 >>> 30) & 3;
        const targetFrame = (wb - n + 16) & 0xf;
        const targetValid = (ws & (1 << targetFrame)) !== 0;
        console.log(`  [${i}] RETW at 0x${pc.toString(16)}: a0=0x${(a0>>>0).toString(16)}, n=${n}, WB=${wb}, WS=0b${ws.toString(2).padStart(16,'0')}, targetFrame=${targetFrame}, valid=${targetValid}`);
      }

      handleRomCall(cpu, pc, {});

      if (!executeInstruction(cpu)) {
        cpu.halted = false;
        cpu.pc += 3;
      }

      if (exceptionHit) {
        console.log(`\n=== FIRST EXCEPTION ===`);
        console.log(`  Cause: ${faultCause} (${getExcCauseName(faultCause)})`);
        console.log(`  Faulting PC: 0x${faultPC.toString(16)}`);
        console.log(`  VECBASE: 0x${(cpu.specialRegisters[SR_VECBASE]>>>0).toString(16)}`);
        console.log(`  WB: ${cpu.specialRegisters[SR_WINDOWBASE]}, WS: 0b${cpu.specialRegisters[SR_WINDOWSTART].toString(2).padStart(16,'0')}`);

        // Show preceding PCs
        console.log(`  Preceding PCs:`);
        for (let j = Math.max(0, prevPCs.length - 15); j < prevPCs.length; j++) {
          const ppc = prevPCs[j];
          const pinst = decode(mem, ppc);
          console.log(`    0x${ppc.toString(16)}: ${Opcode[pinst.op]} r=${pinst.r} s=${pinst.s} t=${pinst.t} imm=${pinst.imm}`);
        }

        console.log(`  Instruction #${i}`);
        break;
      }
    }

    // With window spill/fill and null function pointer handling,
    // the firmware may run 10K instructions without exceptions
    // expect(exceptionHit).toBe(true);
    console.log(`  Exception hit: ${exceptionHit}, ran 10K instructions`);
  });
});

function getExcCauseName(cause: number): string {
  const names: Record<number, string> = {
    0: "IllegalInstruction",
    1: "Syscall",
    2: "InstructionFetchError",
    3: "LoadStoreError",
    4: "Level1Interrupt",
    5: "Alloca",
    6: "DivideByZero",
    9: "WindowOverflow4",
    10: "WindowOverflow8",
    11: "WindowOverflow12",
    13: "WindowUnderflow4",
    14: "WindowUnderflow8",
    15: "WindowUnderflow12",
  };
  return names[cause] || `Unknown(${cause})`;
}
