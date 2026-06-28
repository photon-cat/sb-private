import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { PinState } from "avr8js";
import { CustomChipRuntime, parseWasmMemoryImport, type CustomChipConfig } from "../chip-runtime";
import type { Diagram } from "../diagram-parser";
import type { AVRRunnerLike } from "../pin-mapping";
import { mapArduinoPin } from "../pin-mapping";

// Real Verilog inverter compiled with Verilator → WASI clang++ → WASM.
// module inv(input wire a, output wire y); assign y = ~a; endmodule
const WASM = readFileSync(path.join(__dirname, "fixtures", "inv_verilog.wasm"));

class MockPort {
  readonly states = new Uint8Array(8);
  readonly listeners = new Set<() => void>();
  setPin(pin: number, high: boolean) { this.states[pin] = high ? 1 : 0; for (const l of this.listeners) l(); }
  pinState(pin: number): number { return this.states[pin] ? PinState.High : PinState.Low; }
  addListener(cb: () => void) { this.listeners.add(cb); }
  removeListener(cb: () => void) { this.listeners.delete(cb); }
}

function makeRunner(): AVRRunnerLike {
  return {
    cpu: { cycles: 0, addClockEvent: vi.fn((cb: () => void) => { cb(); return null; }) },
    portB: new MockPort(), portC: new MockPort(), portD: new MockPort(),
    usart: { onByteTransmit: null, writeByte: vi.fn() },
    twi: {}, adc: { channelValues: [0, 0, 0, 0, 0, 0] },
    spi: { onByte: () => {}, completeTransfer: vi.fn() },
    speed: 16_000_000,
  } as unknown as AVRRunnerLike;
}

const diagram: Diagram = {
  parts: [
    { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
    { id: "chip1", type: "chip-inv", top: 0, left: 0, attrs: {} },
  ],
  connections: [
    { from: "chip1:A", to: "uno:8", color: "g", hints: [] }, // A → portB0
    { from: "chip1:Y", to: "uno:9", color: "g", hints: [] }, // Y → portB1
  ],
  version: 1, author: "t", editor: "sparkbench",
} as Diagram;

const config: CustomChipConfig = { chipJson: { name: "inv", pins: ["A", "Y"] }, wasmBytes: WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) };

describe("Verilog chip (Verilator → WASM) in CustomChipRuntime", () => {
  it("detects the shared-memory import the Verilator runtime requires", () => {
    const spec = parseWasmMemoryImport(config.wasmBytes);
    expect(spec).not.toBeNull();
    expect(spec!.shared).toBe(true);
    expect(spec!.initial).toBeGreaterThan(0);
  });

  it("instantiates and runs: Y = NOT A", async () => {
    const runner = makeRunner();
    const portB = runner.portB as unknown as MockPort;
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", config, mapArduinoPin);

    await runtime.init(); // instantiates the real Verilator WASM (shared memory + thread-spawn stub)

    // A low at init → Y should be high (NOT 0 = 1)
    expect(portB.pinState(1)).toBe(PinState.High);

    // Drive A high → Y goes low
    portB.setPin(0, true);
    expect(portB.pinState(1)).toBe(PinState.Low);

    // Drive A low → Y goes high
    portB.setPin(0, false);
    expect(portB.pinState(1)).toBe(PinState.High);

    runtime.dispose();
  });
});
