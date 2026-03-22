import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ESP32CPU, SR_WINDOWBASE, SR_PS } from "../src/cpu/cpu.js";
import { decode, Opcode } from "../src/cpu/xtensa-decoder.js";
import { executeInstruction } from "../src/cpu/xtensa-execute.js";
import { ESP32Runner } from "../src/index.js";
import { handleRomCall } from "../src/stubs/rom-functions.js";

const FIRMWARE_PATH = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");

describe("Boot trace", () => {
  it("should boot ESP-IDF and run app_main", () => {
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner();
    runner.appMainAddr = 0x400d5e54;
    runner.printfAddr = 0x400d93d4;
    runner.putsAddr = 0x400d947c;
    runner.loadFirmware(binData);
    const cpu = runner.cpu;
    const mem = cpu.memory;

    let serialOutput = "";
    runner.onSerialOutput = (ch: number) => {
      serialOutput += String.fromCharCode(ch);
    };

    const MAX_STEPS = 5_000_000;
    let stuckPC = 0;
    let stuckCount = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      const pc = cpu.pc;

      if (pc === stuckPC) {
        stuckCount++;
        if (stuckCount > 1000000) break;
      } else {
        stuckPC = pc;
        stuckCount = 0;
      }

      // Intercept esp_startup_start_app to jump directly to app_main
      if (pc === 0x400e407c) {
        cpu.pc = 0x400d5e54; // app_main
        continue;
      }
      // Intercept printf/puts — use runner's built-in handler
      if (pc === 0x400d93d4) {
        (runner as any).handlePrintfIntercept();
        continue;
      }
      if (pc === 0x400d947c) {
        (runner as any).handlePutsIntercept();
        continue;
      }
      // Intercept vTaskDelay — return after advancing cycles
      if (pc === 0x40087850) {
        const retAddrRaw = cpu.getAR(8);
        const retAddr = ((pc & 0xC0000000) | (retAddrRaw & 0x3FFFFFFF)) >>> 0;
        const ticks = cpu.getAR(10) >>> 0;
        cpu.cycles += Math.min(ticks * 240_000, 24_000_000);
        cpu.specialRegisters[SR_PS] &= ~(0x3 << 16); // clear CALLINC
        cpu.pc = retAddr;
        continue;
      }

      handleRomCall(cpu, pc, {
        onPrintf: (text: string) => { serialOutput += text; },
      });
      const ok = executeInstruction(cpu);
      if (!ok) {
        cpu.halted = false;
        cpu.pc += 3;
      }
    }

    // Verify output contains expected strings
    expect(serialOutput).toContain("Hello from ESP32 emulator!");
    expect(serialOutput).toContain("Blink 0");
    expect(serialOutput).toContain("Blink 1");

    // Print summary
    const clean = serialOutput.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = clean.split('\n');
    const deduped: string[] = [];
    let lastLine = '';
    let repeatCount = 0;
    for (const line of lines) {
      if (line === lastLine) {
        repeatCount++;
      } else {
        if (repeatCount > 0) deduped.push(`  ... repeated ${repeatCount} more times`);
        deduped.push(line);
        lastLine = line;
        repeatCount = 0;
      }
    }
    if (repeatCount > 0) deduped.push(`  ... repeated ${repeatCount} more times`);
    console.log(`  Serial output (${clean.length} chars):\n${deduped.join('\n').substring(0, 2000)}`);
  });
});
