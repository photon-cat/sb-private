// Phase 4b — in-browser ARMv7-M core (unicorn.js, asm.js) via UnicornArmHost.
//
// Proves the vendored Unicorn engine: (1) executes Thumb-2 (mla/udiv) that the
// ARMv6-M M0+ core cannot, (2) drives the STM32 memory map (vector reset, SRAM),
// (3) bridges the peripheral region to the same MMIOBus (write forwarded, read
// substituted), and (4) reports a sane throughput. Pure JS — no native process.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { MMIOBus } from "../mcu/mmio-bus";
import { UnicornArmHost, SRAM_BASE } from "../mcu/unicorn-arm-host";
import { RegisterPeripheral, type AccessWidth } from "../mcu/peripheral";
import { ARM_REG } from "../mcu/unicorn/load-unicorn-arm";

const FW = new Uint8Array(
  readFileSync(path.join(__dirname, "fixtures", "unicorn-arm", "firmware.bin")),
);

/** Peripheral at the USART1 base that records writes and returns a sentinel on read. */
class Probe extends RegisterPeripheral {
  writes: Array<[number, number]> = [];
  write(offset: number, width: AccessWidth, value: number): void {
    this.writes.push([offset, value]);
    super.write(offset, width, value);
  }
  read(): number {
    return 0x68; // distinct from the 0x41 the firmware wrote — proves bus-sourced read
  }
}

describe("UnicornArmHost (ARMv7-M / Thumb-2, in-browser engine)", () => {
  it("executes Thumb-2 (mla + udiv) the M0+ core cannot", async () => {
    const host = await UnicornArmHost.create(new MMIOBus());
    host.loadFlash(FW);
    host.reset();
    expect(host.sp).toBe(0x20005000); // from the vector table
    host.run(300);
    expect(host.readReg(ARM_REG.R3)).toBe(47); // 7*6+5  (mla)
    expect(host.readReg(ARM_REG.R4)).toBe(6); //  47/7   (udiv)
    host.close();
  });

  it("drives the STM32 memory map: stores land in SRAM", async () => {
    const host = await UnicornArmHost.create(new MMIOBus());
    host.loadFlash(FW);
    host.reset();
    host.run(300);
    const dv = new DataView(host.readMem(SRAM_BASE, 12).buffer);
    expect(dv.getUint32(0, true)).toBe(47); // SRAM[0] = r3
    expect(dv.getUint32(4, true)).toBe(6); //  SRAM[1] = r4
    host.close();
  });

  it("bridges the peripheral region to the MMIOBus (write + read)", async () => {
    const bus = new MMIOBus();
    const probe = new Probe("USART1", 0x40013800, 0x400);
    bus.add(probe);
    const host = await UnicornArmHost.create(bus);
    host.loadFlash(FW);
    host.reset();
    host.run(300);
    // Firmware wrote 'A' (0x41) to TDR @ offset 4 — forwarded to the bus.
    expect(probe.writes).toContainEqual([4, 0x41]);
    // Firmware then read the same address; the bus returned 0x68, which the
    // load delivered and the firmware stored to SRAM[2].
    const dv = new DataView(host.readMem(SRAM_BASE, 12).buffer);
    expect(dv.getUint32(8, true)).toBe(0x68);
    host.close();
  });

  it("reports a usable instruction throughput", async () => {
    const host = await UnicornArmHost.create(new MMIOBus());
    host.loadFlash(FW);
    host.reset();
    host.run(2000); // reach the hang loop
    const N = 2_000_000;
    const t0 = performance.now();
    host.run(N);
    const ips = N / ((performance.now() - t0) / 1000);
    // Measured ~8–12 M ips; assert a conservative floor so it isn't flaky in CI.
    expect(ips).toBeGreaterThan(1_000_000);
    host.close();
  });
});
