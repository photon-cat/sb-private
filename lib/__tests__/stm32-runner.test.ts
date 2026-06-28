// Phase-3 acceptance: a real, compiler-produced STM32G0 firmware runs headless
// on the rp2040js-derived Cortex-M0+ core, driving the SVD-built peripheral bus.
//
// firmware.bin is built from fixtures/stm32g0/firmware.c by build.sh with the
// real arm-none-eabi-gcc and committed, so this needs no toolchain.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { STM32Runner } from "../stm32-runner";

const SVD = readFileSync(path.join(__dirname, "fixtures", "stm32g0-mini.svd"), "utf-8");
const FW_PATH = path.join(__dirname, "fixtures", "stm32g0", "firmware.bin");
const hasFw = existsSync(FW_PATH);
const firmware = hasFw ? new Uint8Array(readFileSync(FW_PATH)) : new Uint8Array();

describe("STM32Runner (real STM32G0 firmware on the M0+ core)", () => {
  it("boots: vector table sets SP/PC from flash", () => {
    if (!hasFw) return;
    const r = new STM32Runner(firmware, SVD);
    expect(r.host.sp).toBe(0x20008000); // _estack = 0x20000000 + 32K
    expect(r.host.pc & ~1).toBe(0x080000c8); // Reset_Handler
    expect(r.clockHz).toBe(16_000_000);
  });

  it("drives GPIOA PA5 high through the SVD-built GPIO model", () => {
    if (!hasFw) return;
    const r = new STM32Runner(firmware, SVD);
    r.runCycles(2000);
    expect(r.pinState("GPIOA", 5)).toBe(true);
  });

  it("transmits 'HI' over USART1", () => {
    if (!hasFw) return;
    const r = new STM32Runner(firmware, SVD);
    let out = "";
    r.onSerialByte = (b) => (out += String.fromCharCode(b));
    r.runCycles(4000);
    expect(out).toBe("HI");
  });

  it("vectors a USART1 RX interrupt through the borrowed NVIC and echoes byte+1", () => {
    if (!hasFw) return;
    const r = new STM32Runner(firmware, SVD);
    let out = "";
    r.onSerialByte = (b) => (out += String.fromCharCode(b));
    r.runCycles(4000); // run past init "HI", into the idle loop
    out = "";
    r.feedSerial("A".charCodeAt(0)); // raises RXNE → NVIC IRQ 27
    r.runCycles(2000);
    expect(out).toBe("B"); // handler ran: 'A' + 1
  });

  it("watchPin observes the PA5 rising edge", () => {
    if (!hasFw) return;
    const r = new STM32Runner(firmware, SVD);
    const edges: boolean[] = [];
    r.watchPin("GPIOA", 5, (high) => edges.push(high));
    r.runCycles(2000);
    expect(edges).toContain(true);
  });

  it("validates clockHz", () => {
    if (!hasFw) return;
    expect(() => new STM32Runner(firmware, SVD, { clockHz: 0 })).toThrow();
    expect(() => new STM32Runner(firmware, SVD, { clockHz: -1 })).toThrow();
  });
});
