// ESP32 Emulator Benchmark: espwebemu vs Wokwi
// Measures time to boot and reach "Blink N" for various N values

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { ESP32Runner } from "../src/index.js";
import { SR_PS } from "../src/cpu/cpu.js";
import { executeInstruction } from "../src/cpu/xtensa-execute.js";
import { handleRomCall } from "../src/stubs/rom-functions.js";

const FIRMWARE_PATH = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");
const WOKWI_DIR = resolve(__dirname, "wokwi");
const PIO_FIRMWARE = resolve(WOKWI_DIR, "firmware.bin");

// Benchmark targets — how many "Blink N" to wait for
const BLINK_TARGETS = [1, 5, 10];

function benchEspwebemu(targetBlink: number): { ms: number; instrCount: number; output: string } {
  const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
  const runner = new ESP32Runner();
  runner.appMainAddr = 0x400d5e54;
  runner.printfAddr = 0x400d93d4;
  runner.putsAddr = 0x400d947c;
  runner.loadFirmware(binData);
  const cpu = runner.cpu;

  let serialOutput = "";
  runner.onSerialOutput = (ch: number) => {
    serialOutput += String.fromCharCode(ch);
  };

  const targetText = `Blink ${targetBlink}`;
  const MAX_STEPS = 50_000_000;
  let instrCount = 0;
  let stuckPC = 0;
  let stuckCount = 0;

  const start = performance.now();

  for (let i = 0; i < MAX_STEPS; i++) {
    const pc = cpu.pc;

    if (pc === stuckPC) {
      stuckCount++;
      if (stuckCount > 1_000_000) break;
    } else {
      stuckPC = pc;
      stuckCount = 0;
    }

    // Intercept esp_startup_start_app → jump to app_main
    if (pc === 0x400e407c) { cpu.pc = 0x400d5e54; continue; }
    // Intercept printf
    if (pc === 0x400d93d4) { (runner as any).handlePrintfIntercept(); continue; }
    // Intercept puts
    if (pc === 0x400d947c) { (runner as any).handlePutsIntercept(); continue; }
    // Intercept vTaskDelay
    if (pc === 0x40087850) {
      const retAddrRaw = cpu.getAR(8);
      const retAddr = ((pc & 0xC0000000) | (retAddrRaw & 0x3FFFFFFF)) >>> 0;
      const ticks = cpu.getAR(10) >>> 0;
      cpu.cycles += Math.min(ticks * 240_000, 24_000_000);
      cpu.specialRegisters[SR_PS] &= ~(0x3 << 16);
      cpu.pc = retAddr;
      continue;
    }

    handleRomCall(cpu, pc, {
      onPrintf: (text: string) => { serialOutput += text; },
    });

    const ok = executeInstruction(cpu);
    if (!ok) { cpu.halted = false; cpu.pc += 3; }
    instrCount++;

    if (serialOutput.includes(targetText)) break;
  }

  const elapsed = performance.now() - start;
  return { ms: elapsed, instrCount, output: serialOutput };
}

function benchWokwi(targetBlink: number): { ms: number } {
  const targetText = `Blink ${targetBlink}`;
  // Wokwi timeout: give it plenty of time (firmware has 1s delays)
  const wokwiTimeout = (targetBlink + 5) * 1500;

  const start = performance.now();
  try {
    execSync(
      `wokwi-cli --timeout ${wokwiTimeout} --expect-text "${targetText}" -q "${WOKWI_DIR}"`,
      { timeout: wokwiTimeout + 5000, stdio: "pipe" }
    );
  } catch (e: any) {
    const elapsed = performance.now() - start;
    if (e.status === 42) {
      return { ms: -1 }; // timeout
    }
    // expect-text found triggers exit 0, but execSync might still throw
  }
  const elapsed = performance.now() - start;
  return { ms: elapsed };
}

console.log("╔═══════════════════════════════════════════════════════════════╗");
console.log("║         ESP32 Emulator Benchmark: espwebemu vs Wokwi        ║");
console.log("╚═══════════════════════════════════════════════════════════════╝");
console.log();

// Note about firmware differences
console.log("espwebemu: ESP-IDF firmware (hello_esp32.bin) — intercepts at known addresses");
console.log("Wokwi:     Arduino/PlatformIO firmware (same blink logic) — full QEMU emulation");
console.log();

const results: { target: number; espwebemu: { ms: number; instr: number }; wokwi: { ms: number } }[] = [];

for (const target of BLINK_TARGETS) {
  process.stdout.write(`Benchmarking Blink ${target}...\n`);

  // espwebemu
  process.stdout.write("  espwebemu: ");
  const espResult = benchEspwebemu(target);
  console.log(`${espResult.ms.toFixed(1)}ms (${(espResult.instrCount / 1e6).toFixed(2)}M instructions)`);

  // Wokwi
  process.stdout.write("  Wokwi:     ");
  const wokwiResult = benchWokwi(target);
  if (wokwiResult.ms === -1) {
    console.log("TIMEOUT");
  } else {
    console.log(`${wokwiResult.ms.toFixed(1)}ms`);
  }

  results.push({
    target,
    espwebemu: { ms: espResult.ms, instr: espResult.instrCount },
    wokwi: { ms: wokwiResult.ms },
  });

  console.log();
}

// Summary table
console.log("┌──────────┬───────────────┬───────────────┬──────────┐");
console.log("│  Target  │   espwebemu   │     Wokwi     │  Ratio   │");
console.log("├──────────┼───────────────┼───────────────┼──────────┤");
for (const r of results) {
  const esp = r.espwebemu.ms < 1000 ? `${r.espwebemu.ms.toFixed(0)}ms` : `${(r.espwebemu.ms / 1000).toFixed(2)}s`;
  const wok = r.wokwi.ms === -1 ? "TIMEOUT" : r.wokwi.ms < 1000 ? `${r.wokwi.ms.toFixed(0)}ms` : `${(r.wokwi.ms / 1000).toFixed(2)}s`;
  const ratio = r.wokwi.ms > 0 ? `${(r.wokwi.ms / r.espwebemu.ms).toFixed(1)}x` : "N/A";
  console.log(`│ Blink ${String(r.target).padStart(2)} │ ${esp.padStart(13)} │ ${wok.padStart(13)} │ ${ratio.padStart(8)} │`);
}
console.log("└──────────┴───────────────┴───────────────┴──────────┘");
console.log();
console.log("Note: Wokwi runs server-side (cloud QEMU) — includes network latency.");
console.log("      espwebemu runs locally in Node.js — pure CPU time.");
