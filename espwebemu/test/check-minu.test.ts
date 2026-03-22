import { describe, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ESP32Runner } from "../src/index.js";
import { decode, Opcode } from "../src/cpu/xtensa-decoder.js";

const FIRMWARE_PATH = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");

describe("Check MINU encoding", () => {
  it("should show bytes at 0x4008b407", () => {
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner(binData);
    const mem = runner.cpu.memory;

    // Read bytes at 0x4008b407
    const addr = 0x4008b407;
    const b0 = mem.read8(addr);
    const b1 = mem.read8(addr + 1);
    const b2 = mem.read8(addr + 2);

    console.log(`Bytes at 0x${addr.toString(16)}: 0x${b0.toString(16)} 0x${b1.toString(16)} 0x${b2.toString(16)}`);
    console.log(`  op0 = ${b0 & 0xf}`);
    console.log(`  t = ${(b0 >> 4) & 0xf}`);
    console.log(`  s = ${b1 & 0xf}`);
    console.log(`  r = ${(b1 >> 4) & 0xf}`);
    console.log(`  op1 = ${b2 & 0xf}`);
    console.log(`  op2 = ${(b2 >> 4) & 0xf}`);

    const inst = decode(mem, addr);
    console.log(`  Decoded: ${Opcode[inst.op]} r=${inst.r} s=${inst.s} t=${inst.t}`);

    // Also check callx8 at 0x4008b404
    const addr2 = 0x4008b404;
    const c0 = mem.read8(addr2);
    const c1 = mem.read8(addr2 + 1);
    const c2 = mem.read8(addr2 + 2);
    console.log(`\nBytes at 0x${addr2.toString(16)} (callx8): 0x${c0.toString(16)} 0x${c1.toString(16)} 0x${c2.toString(16)}`);
    console.log(`  op0=${c0 & 0xf} t=${(c0>>4)&0xf} s=${c1&0xf} r=${(c1>>4)&0xf} op1=${c2&0xf} op2=${(c2>>4)&0xf}`);

    // Also check a known MULL instruction if any
    // From the Xtensa ISA: MULL is op0=0, op1=2, op2=8
    // Let me check what other RST2 instructions look like
    console.log("\nRST2 op2 values for MIN/MINU/MAX/MAXU/MULL:");
    console.log("  Our decoder: MIN=4, MINU=5, MAX=6, MAXU=7, MULL=8");
    console.log("  Binary op1=" + (b2 & 0xf) + " op2=" + ((b2 >> 4) & 0xf) + " for what objdump calls 'minu'");
  });
});
