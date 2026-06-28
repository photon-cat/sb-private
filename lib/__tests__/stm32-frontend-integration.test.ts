// Frontend integration: a compiled STM32 .bin runs on the in-browser unicorn.js
// core and drives a diagram component through the SAME wiring the UI uses.
//
// This is the end-to-end proof that "unicorn.js works in the front end": real
// F103 firmware → createStm32Runner (unicorn-arm) → wireComponentsStm32 → an LED
// on PC13 toggles. Runs headless in jsdom (the test environment), exercising the
// exact libraries the React hooks call.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { createStm32Runner, decodeFirmwareBin } from "../sim/create-stm32-runner";
import { wireComponentsStm32 } from "../wire-components-stm32";
import { mapSTM32Pin } from "../pin-mapping";
import type { Diagram } from "../diagram-parser";

const BLINK = new Uint8Array(
  readFileSync(path.join(__dirname, "fixtures", "unicorn-arm", "blink-pc13.bin")),
);

const diagram: Diagram = {
  version: 1,
  author: "",
  editor: "",
  parts: [
    { type: "sb-stm32f103", id: "stm32", top: 0, left: 0, attrs: {} },
    { type: "wokwi-led", id: "led1", top: 0, left: 0, attrs: {} },
  ],
  connections: [
    { from: "stm32:PC13", to: "led1:A", color: "green", hints: [] },
    { from: "led1:C", to: "stm32:GND", color: "black", hints: [] },
  ],
};

describe("STM32 frontend integration (unicorn.js → component wiring)", () => {
  it("maps STM32 pin names to GPIO port/pin", () => {
    expect(mapSTM32Pin("PC13")).toEqual({ port: "GPIOC", pin: 13 });
    expect(mapSTM32Pin("PA5")).toEqual({ port: "GPIOA", pin: 5 });
    expect(mapSTM32Pin("5V")).toBeNull();
  });

  it("round-trips base64 firmware", () => {
    const b64 = Buffer.from(BLINK).toString("base64");
    expect(decodeFirmwareBin(b64)).toEqual(BLINK);
  });

  it("drives an LED on PC13 from real F103 firmware via unicorn.js", async () => {
    const runner = await createStm32Runner("unicorn-arm", BLINK);
    const { wired } = wireComponentsStm32(runner, diagram, "stm32");

    const states: boolean[] = [];
    wired.get("led1")!.onStateChange = (high) => states.push(high);

    // Execute enough instructions to cross several blink half-periods.
    runner.host.runBatch(300_000);

    expect(states.length).toBeGreaterThan(1); // the pin toggled repeatedly
    expect(states).toContain(true);
    expect(states).toContain(false);
    runner.stop();
  });

  it("exposes the AVR-shaped execute()/stop() loop for the UI", async () => {
    const runner = await createStm32Runner("unicorn-arm", BLINK);
    expect(typeof runner.execute).toBe("function");
    expect(typeof runner.stop).toBe("function");
    expect(typeof runner.resume).toBe("function");
    // One real-time batch should advance the cycle counter, then stop cleanly.
    runner.execute();
    expect(runner.cycles).toBeGreaterThan(0);
    runner.stop();
  });
});
