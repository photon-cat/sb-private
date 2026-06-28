// Unit tests for CortexM0Host — the rp2040js-derived Cortex-M0+ core wired to an
// STM32 memory map. Validates the integration seam (reset vector, flash/SRAM,
// peripheral routing, IRQ delivery) with small hand-built Thumb programs.

import { describe, it, expect } from "vitest";
import { MMIOBus } from "../mcu/mmio-bus";
import { CortexM0Host, SRAM_BASE, FLASH_BASE } from "../mcu/cortex-m0-host";
import { RegisterPeripheral, type AccessWidth } from "../mcu/peripheral";

/** Assemble a flash image: vector table (SP, reset) + Thumb words at 0x08. */
function image(words: number[], sp = 0x20009000, entry = 0x08000008): Uint8Array {
  const img = new Uint8Array(0x200);
  const dv = new DataView(img.buffer);
  dv.setUint32(0x00, sp, true);
  dv.setUint32(0x04, entry | 1, true);
  let o = entry - FLASH_BASE;
  for (const w of words) {
    dv.setUint16(o, w, true);
    o += 2;
  }
  return img;
}

describe("CortexM0Host", () => {
  it("loads SP/PC from the vector table on reset", () => {
    const host = new CortexM0Host(new MMIOBus());
    host.loadFlash(image([0xe7fe], 0x20001234, 0x08000008));
    host.reset();
    expect(host.sp).toBe(0x20001234);
    expect(host.pc & ~1).toBe(0x08000008);
  });

  it("executes Thumb and stores to SRAM", () => {
    const host = new CortexM0Host(new MMIOBus());
    // movs r1,#0x20 ; lsls r1,#24 ; movs r0,#42 ; str r0,[r1] ; b .
    host.loadFlash(image([0x2120, 0x0609, 0x202a, 0x6008, 0xe7fe]));
    host.reset();
    for (let i = 0; i < 10; i++) host.step();
    expect(new DataView(host.sram.buffer).getUint32(0, true)).toBe(42);
  });

  it("routes stores in the peripheral region to the MMIO bus", () => {
    const bus = new MMIOBus();
    const writes: Array<[number, number]> = [];
    class Probe extends RegisterPeripheral {
      write(offset: number, width: AccessWidth, value: number): void {
        writes.push([offset, value]);
        super.write(offset, width, value);
      }
    }
    bus.add(new Probe("PROBE", 0x40011000, 0x400));
    const host = new CortexM0Host(bus);
    // r1 = 0x40011000 ; r0 = 0xAB ; str r0,[r1] ; b .
    // build 0x40011000: movs r1,#0x40010000? simpler: movs r1,#0x10; lsls #28 => 0x10<<28=0x100000000 overflow.
    // Use literal: ldr r1,[pc,#4] (pool), ldr r0,[pc,#4], str r0,[r1], b ., pool words.
    const words = [
      0x4901, // ldr r1,[pc,#4]  -> pool[0]
      0x4802, // ldr r0,[pc,#8]  -> pool[1]
      0x6008, // str r0,[r1,#0]
      0xe7fe, // b .
    ];
    const img = image(words);
    const dv = new DataView(img.buffer);
    // literal pool is word-aligned after the 4 halfwords at 0x08: PC-relative base
    // for ldr is (PC+4)&~3. Place pool at 0x10 and 0x14 (file offsets) = 0x08000010/14.
    dv.setUint32(0x10, 0x40011000, true); // pool[0] -> r1 base
    dv.setUint32(0x14, 0x000000ab, true); // pool[1] -> value
    host.loadFlash(img);
    host.reset();
    for (let i = 0; i < 12; i++) host.step();
    expect(writes).toContainEqual([0, 0xab]);
  });

  it("delivers a peripheral IRQ into the core NVIC (level-synced)", () => {
    const bus = new MMIOBus();
    let asserting = true;
    class IrqSource extends RegisterPeripheral {
      pendingIRQ(): number | null {
        return asserting ? 5 : null;
      }
    }
    bus.add(new IrqSource("SRC", 0x40012000, 0x400));
    const host = new CortexM0Host(bus);
    host.loadFlash(image([0xe7fe]));
    host.reset();
    const core = (host as unknown as { rp2040: { core: { setInterrupt: (i: number, v: boolean) => void } } }).rp2040.core;
    const calls: Array<[number, boolean]> = [];
    const orig = core.setInterrupt.bind(core);
    core.setInterrupt = (i: number, v: boolean) => {
      calls.push([i, v]);
      orig(i, v);
    };
    host.step(); // sees asserting -> setInterrupt(5,true)
    asserting = false;
    host.step(); // no longer pending -> setInterrupt(5,false)
    expect(calls).toContainEqual([5, true]);
    expect(calls).toContainEqual([5, false]);
  });
});
