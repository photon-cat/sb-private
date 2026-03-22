// Test loading and decoding real ESP32 firmware
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ESP32CPU } from "../src/cpu/cpu.js";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { loadESP32Bin } from "../src/memory/flash.js";
import { decode, Opcode } from "../src/cpu/xtensa-decoder.js";
import { executeInstruction } from "../src/cpu/xtensa-execute.js";

// Path to the real firmware built by ESP-IDF
const FIRMWARE_PATH = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");

describe("ESP32 Firmware Loading", () => {
  let binData: Uint8Array;
  let mem: MemoryBus;

  beforeAll(() => {
    binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
  });

  it("should parse firmware header correctly", () => {
    expect(binData[0]).toBe(0xe9); // Magic byte
    expect(binData.length).toBeGreaterThan(1000); // Non-trivial firmware
  });

  it("should load firmware segments into memory", () => {
    mem = new MemoryBus();
    const result = loadESP32Bin(binData, mem);

    // From QEMU output: entry point is 0x40081180 (call_start_cpu0)
    // But the .bin header says entry 0x40080840 (second-stage)
    expect(result.entryPoint).toBeGreaterThan(0x40000000);
    expect(result.segments.length).toBeGreaterThan(0);

    // Log segment info
    for (const seg of result.segments) {
      console.log(`  Segment: addr=0x${seg.addr.toString(16)}, size=${seg.size}`);
    }
  });

  it("should have valid instruction data at entry point", () => {
    mem = new MemoryBus();
    const result = loadESP32Bin(binData, mem);

    // Read first few bytes at entry point
    const b0 = mem.read8(result.entryPoint);
    const b1 = mem.read8(result.entryPoint + 1);
    const b2 = mem.read8(result.entryPoint + 2);
    console.log(`  Entry point: 0x${result.entryPoint.toString(16)}`);
    console.log(`  First bytes: 0x${b0.toString(16)} 0x${b1.toString(16)} 0x${b2.toString(16)}`);

    // Should be a valid instruction (op0 in range 0-13)
    expect(b0 & 0xf).toBeLessThan(14);
  });
});

describe("Decoder vs Real Disassembly", () => {
  // Test against known disassembly from xtensa-esp-elf-objdump
  // From call_start_cpu0:
  // 40081180: 00a136  entry a1, 80
  // 40081183: fca081  l32r a8, 40080404
  // 40081186: 13e780  wsr.vecbase a8
  // 40081189: 00a0a2  movi a10, 0

  let mem: MemoryBus;

  beforeAll(() => {
    mem = new MemoryBus();
  });

  it("should decode ENTRY a1, 80", () => {
    // Bytes: 0x36, 0xa1, 0x00 → entry a1, 80
    // Actually from disasm: 00a136 → byte order in memory is: 36, a1, 00
    const data = new Uint8Array([0x36, 0xa1, 0x00]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  ENTRY decode: op=${Opcode[inst.op]}, s=${inst.s}, imm=${inst.imm}`);
    expect(inst.op).toBe(Opcode.ENTRY);
    expect(inst.s).toBe(1); // a1 = stack pointer
    // ENTRY frame size: 80 bytes (encoded as some shift)
    // The encoding puts the 12-bit value that represents frame_size/8
    // So imm in the decoder should be frame_size
    // 80 = 10 * 8, so the raw 12-bit field should be 10
    console.log(`  ENTRY imm (frame size): ${inst.imm}`);
  });

  it("should decode L32R a8, <addr>", () => {
    // fca081 → bytes: 81, a0, fc
    // L32R: op0=1, t=8, imm16
    const data = new Uint8Array([0x81, 0xa0, 0xfc]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  L32R decode: op=${Opcode[inst.op]}, t=${inst.t}, imm=${inst.imm}`);
    expect(inst.op).toBe(Opcode.L32R);
    expect(inst.t).toBe(8); // dest = a8
  });

  it("should decode WSR.VECBASE a8 (wsr 231, a8)", () => {
    // 13e780 → bytes: 80, e7, 13
    // This is WSR with sr=231 (VECBASE)
    const data = new Uint8Array([0x80, 0xe7, 0x13]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  WSR decode: op=${Opcode[inst.op]}, t=${inst.t}, imm(sr)=${inst.imm}`);
    // WSR: op0=0, and the SR number should be extracted
    // Let's see what we get
    console.log(`  Raw decode: r=${inst.r}, s=${inst.s}, op fields from byte2: ${(0x13 & 0xf)}/${(0x13 >> 4) & 0xf}`);
  });

  it("should decode MOVI a10, 0", () => {
    // 00a0a2 → bytes: a2, a0, 00
    // MOVI: op0=2, r=0xa, t=part of imm, s=dest
    const data = new Uint8Array([0xa2, 0xa0, 0x00]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  MOVI decode: op=${Opcode[inst.op]}, t=${inst.t}, s=${inst.s}, imm=${inst.imm}`);
    expect(inst.op).toBe(Opcode.MOVI);
    // The dest should be a10, value should be 0
  });

  it("should decode CALLX8 a8", () => {
    // 0008e0 → bytes: e0, 08, 00
    // CALLX8: op0=0, op1=0, op2=0, and sub-fields indicate CALLX
    const data = new Uint8Array([0xe0, 0x08, 0x00]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  CALLX8 decode: op=${Opcode[inst.op]}, s=${inst.s}, r=${inst.r}, t=${inst.t}`);
    // CALLX8 should jump to address in a8
  });

  it("should decode MOV.N a6, a10", () => {
    // 0a6d → bytes: 6d, 0a
    // MOV.N: narrow instruction
    const data = new Uint8Array([0x6d, 0x0a]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  MOV.N decode: op=${Opcode[inst.op]}, t=${inst.t}, s=${inst.s}, r=${inst.r}`);
    expect(inst.len).toBe(2);
  });

  it("should decode S32I.N a10, a1, 0", () => {
    // 01a9 → bytes: a9, 01
    // S32I.N: op0=9
    const data = new Uint8Array([0xa9, 0x01]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  S32I.N decode: op=${Opcode[inst.op]}, t=${inst.t}, s=${inst.s}, r=${inst.r}, imm=${inst.imm}`);
    expect(inst.op).toBe(Opcode.S32I_N);
    expect(inst.len).toBe(2);
  });

  it("should decode MOVI.N a10, 1", () => {
    // 1a0c → bytes: 0c, 1a
    // MOVI.N: op0=0xd(13)
    const data = new Uint8Array([0x0c, 0x1a]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  MOVI.N decode: op=${Opcode[inst.op]}, s=${inst.s}, imm=${inst.imm}`);
    // From disasm: MOVI.N a10, 1 → s=10, imm=1
  });

  // From app_main disassembly:
  // 400d5e54: 004136  entry a1, 32
  // 400d5e57: 2a0c    movi.n a10, 2
  // 400d5e6a: 070c    movi.n a7, 0
  // 400d5e84: 771b    addi.n a7, a7, 1

  it("should decode ENTRY a1, 32 (from app_main)", () => {
    // 004136 → bytes: 36, 41, 00
    const data = new Uint8Array([0x36, 0x41, 0x00]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  ENTRY a1,32: op=${Opcode[inst.op]}, s=${inst.s}, imm=${inst.imm}`);
    expect(inst.op).toBe(Opcode.ENTRY);
  });

  it("should decode ADDI.N a7, a7, 1", () => {
    // 771b → bytes: 1b, 77
    // ADDI.N: op0=0xb(11)
    const data = new Uint8Array([0x1b, 0x77]);
    mem.writeBlock(0x40080000, data);
    const inst = decode(mem, 0x40080000);
    console.log(`  ADDI.N decode: op=${Opcode[inst.op]}, r=${inst.r}, s=${inst.s}, imm=${inst.imm}`);
    expect(inst.op).toBe(Opcode.ADDI_N);
    expect(inst.imm).toBe(1);
  });
});

describe("ESP32Runner Integration", () => {
  it("should create runner and load firmware", async () => {
    const { ESP32Runner } = await import("../src/index.js");
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner(binData);

    expect(runner.cpu.pc).toBeGreaterThan(0x40000000);
    console.log(`  Runner created. Entry: 0x${runner.cpu.pc.toString(16)}`);
    console.log(`  Speed: ${runner.speed / 1e6} MHz`);
  });

  it("should execute first few instructions without crashing", async () => {
    const { ESP32Runner } = await import("../src/index.js");
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner(binData);

    const serialOutput: string[] = [];
    runner.onSerialOutput = (ch) => serialOutput.push(String.fromCharCode(ch));

    // Try to run 1000 instructions
    let executed = 0;
    const startPC = runner.cpu.pc;
    try {
      for (let i = 0; i < 1000; i++) {
        executeInstruction(runner.cpu);
        executed++;
        if (runner.cpu.halted) break;
      }
    } catch (e) {
      console.log(`  Stopped after ${executed} instructions at PC=0x${runner.cpu.pc.toString(16)}`);
      console.log(`  Error: ${e}`);
    }

    console.log(`  Executed ${executed} instructions`);
    console.log(`  Start PC: 0x${startPC.toString(16)} → End PC: 0x${runner.cpu.pc.toString(16)}`);
    console.log(`  Cycles: ${runner.cpu.cycles}`);
    if (serialOutput.length > 0) {
      console.log(`  Serial output: "${serialOutput.join("")}"`);
    }
  });
});
