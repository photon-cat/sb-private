// RP2040 headless execution + wiring.
//
// Guards the critical clock-tick fix in RP2040Runner.runCycles: rp2040js's
// SimulationClock must advance per instruction or the 64-bit TIMER never moves
// and sleep_ms()/busy_wait() spin forever (firmware never reaches its loop).
// Also exercises the unified HeadlessMcu adapter + RP2040 component wiring.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { RP2040Runner } from "../rp2040-runner";
import { createHeadlessMcu } from "../sim/headless-mcu";
import type { Diagram } from "../diagram-parser";

const UF2 = new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "pico_blink.uf2")));

describe("RP2040 headless execution", () => {
  it("advances the timer and toggles GP25 (clock-tick regression)", () => {
    const r = new RP2040Runner(UF2);
    const states = new Set<boolean>();
    // Break as soon as both on+off are seen (firmware blinks the onboard LED).
    for (let i = 0; i < 250 && states.size < 2; i++) {
      r.runCycles(1_000_000);
      states.add(r.gpioHigh(25));
    }
    expect(states.has(true)).toBe(true);
    expect(states.has(false)).toBe(true);
    r.stop();
  }, 60_000);

  it("drives an LED on GP25 through the HeadlessMcu adapter + wiring", async () => {
    const diagram: Diagram = {
      version: 1, author: "", editor: "",
      parts: [
        { type: "wokwi-pi-pico", id: "pico", top: 0, left: 0, attrs: {} },
        { type: "wokwi-led", id: "led", top: 0, left: 0, attrs: {} },
      ],
      connections: [
        { from: "pico:GP25", to: "led:A", color: "green", hints: [] },
        { from: "led:C", to: "pico:GND.1", color: "black", hints: [] },
      ],
    };
    const mcu = await createHeadlessMcu({ simCore: "rp2040", bin: UF2, diagram });

    const states: boolean[] = [];
    mcu.wired.get("led")!.onStateChange = (high) => states.push(high);
    for (let i = 0; i < 250 && new Set(states).size < 2; i++) mcu.runCycles(1_000_000);

    expect(states.length).toBeGreaterThan(1);
    expect(states).toContain(true);
    expect(states).toContain(false);
    expect(typeof mcu.pinHigh("GP25")).toBe("boolean");
    expect(() => mcu.pinHigh("ZZZ")).toThrow();
    mcu.dispose();
  }, 60_000);
});
