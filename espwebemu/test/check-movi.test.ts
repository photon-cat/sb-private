// Check raw bytes at 0x4008774c to verify MOVI.N decoding
import { describe, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ESP32Runner } from "../src/index.js";
import { decode, Opcode } from "../src/cpu/xtensa-decoder.js";

const FIRMWARE_PATH = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");

describe("Check MOVI.N at 0x4008774c", () => {
  it("should show raw bytes and decoded fields", () => {
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner(binData);
    const mem = runner.cpu.memory;

    // Dump bytes around the function at 0x40087724
    console.log("\n=== Bytes and decoded instructions from 0x40087724 to 0x40087760 ===");
    let pc = 0x40087724;
    while (pc < 0x40087760) {
      const b0 = mem.read8(pc);
      const b1 = mem.read8(pc + 1);
      const b2 = mem.read8(pc + 2);
      const op0 = b0 & 0xf;
      const isNarrow = op0 >= 8 && op0 <= 15;

      const inst = decode(mem, pc);
      const opName = Opcode[inst.op] || `UNKNOWN(${inst.op})`;

      if (isNarrow) {
        const s = (b0 >> 4) & 0xf;
        const r = b1 & 0xf;
        const t = (b1 >> 4) & 0xf;
        console.log(`  0x${pc.toString(16)}: ${b0.toString(16).padStart(2,'0')} ${b1.toString(16).padStart(2,'0')}    ${opName} s=${s} r=${r} t=${t} imm=${inst.imm} (inst.s=${inst.s}, inst.t=${inst.t}, inst.r=${inst.r})`);
        pc += 2;
      } else {
        const t = (b0 >> 4) & 0xf;
        const s = b1 & 0xf;
        const r = (b1 >> 4) & 0xf;
        console.log(`  0x${pc.toString(16)}: ${b0.toString(16).padStart(2,'0')} ${b1.toString(16).padStart(2,'0')} ${b2.toString(16).padStart(2,'0')} ${opName} s=${s} r=${r} t=${t} imm=${inst.imm} (inst.s=${inst.s}, inst.t=${inst.t}, inst.r=${inst.r})`);
        pc += 3;
      }
    }

    // Also check what QEMU would say about 0x4008774c
    const addr = 0x4008774c;
    const byte0 = mem.read8(addr);
    const byte1 = mem.read8(addr + 1);
    console.log(`\n=== 0x${addr.toString(16)} raw: 0x${byte0.toString(16)} 0x${byte1.toString(16)} ===`);
    console.log(`  op0 = ${byte0 & 0xf} (${byte0 & 0xf === 12 ? 'ST2/MOVI.N' : 'other'})`);
    console.log(`  s (reg) = ${(byte0 >> 4) & 0xf}`);
    console.log(`  r = ${byte1 & 0xf}`);
    console.log(`  t = ${(byte1 >> 4) & 0xf}`);
    const inst = decode(mem, addr);
    console.log(`  Decoded: ${Opcode[inst.op]} s=${inst.s} r=${inst.r} t=${inst.t} imm=${inst.imm}`);
  });
});
