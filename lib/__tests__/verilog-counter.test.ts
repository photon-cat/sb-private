import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { PinState } from "avr8js";
import { CustomChipRuntime, type CustomChipConfig } from "../chip-runtime";
import { parseVerilogPorts, generateShim } from "../sim/verilog-chip-builder";
import type { Diagram } from "../diagram-parser";
import type { AVRRunnerLike } from "../pin-mapping";
import { mapArduinoPin } from "../pin-mapping";

const COUNTER_SRC = `module counter(input wire clk, input wire rst, output wire q0, output wire q1, output wire q2, output wire q3);
  reg [3:0] count;
  always @(posedge clk or posedge rst) if (rst) count <= 4'b0; else count <= count + 1'b1;
  assign {q3,q2,q1,q0} = count;
endmodule`;

describe("verilog-chip-builder (parse + shim generation)", () => {
  it("parses ANSI module ports with direction and width", () => {
    const p = parseVerilogPorts(COUNTER_SRC);
    expect(p.module).toBe("counter");
    expect(p.ports).toEqual([
      { name: "clk", dir: "input", width: 1 },
      { name: "rst", dir: "input", width: 1 },
      { name: "q0", dir: "output", width: 1 },
      { name: "q1", dir: "output", width: 1 },
      { name: "q2", dir: "output", width: 1 },
      { name: "q3", dir: "output", width: 1 },
    ]);
  });

  it("parses vector ports into bit widths", () => {
    const p = parseVerilogPorts(
      "module m(input wire [3:0] btn, output reg [7:0] led, input wire clk); endmodule",
    );
    expect(p.ports.find((x) => x.name === "btn")?.width).toBe(4);
    expect(p.ports.find((x) => x.name === "led")?.width).toBe(8);
    expect(p.ports.find((x) => x.name === "clk")?.width).toBe(1);
  });

  it("generates a shim that watches inputs and writes outputs", () => {
    const shim = generateShim(parseVerilogPorts(COUNTER_SRC));
    expect(shim).toContain("#include \"Vcounter.h\"");
    expect(shim).toContain("pin_init(\"clk\", INPUT)");
    expect(shim).toContain("pin_init(\"q0\", OUTPUT)");
    expect(shim).toContain("top->eval()");
    expect(shim).toContain("void chip_init(void)");
  });

  it("expands vector ports to per-bit pins in the shim", () => {
    const shim = generateShim(parseVerilogPorts("module m(input wire [1:0] sw, output wire [1:0] o); endmodule"));
    expect(shim).toContain("pin_init(\"sw0\", INPUT)");
    expect(shim).toContain("pin_init(\"sw1\", INPUT)");
    expect(shim).toContain("out_o0");
    expect(shim).toContain("out_o1");
  });
});

// --- End-to-end: run the compiled counter WASM in the runtime ---

const FIXTURE = path.join(__dirname, "fixtures", "counter_verilog.wasm");

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
    usart: { onByteTransmit: null, writeByte: vi.fn() }, twi: {},
    adc: { channelValues: [0, 0, 0, 0, 0, 0] },
    spi: { onByte: () => {}, completeTransfer: vi.fn() },
    speed: 16_000_000,
  } as unknown as AVRRunnerLike;
}

// clk→D8(PB0) rst→D9(PB1) q0..q3→D10..D13(PB2..PB5)
const diagram: Diagram = {
  parts: [
    { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
    { id: "cnt", type: "chip-counter", top: 0, left: 0, attrs: {} },
  ],
  connections: [
    { from: "cnt:clk", to: "uno:8", color: "g", hints: [] },
    { from: "cnt:rst", to: "uno:9", color: "g", hints: [] },
    { from: "cnt:q0", to: "uno:10", color: "g", hints: [] },
    { from: "cnt:q1", to: "uno:11", color: "g", hints: [] },
    { from: "cnt:q2", to: "uno:12", color: "g", hints: [] },
    { from: "cnt:q3", to: "uno:13", color: "g", hints: [] },
  ],
  version: 1, author: "t", editor: "sparkbench",
} as Diagram;

describe.skipIf(!existsSync(FIXTURE))("Verilog counter chip end-to-end", () => {
  it("counts clock edges and resets (real Verilator WASM)", async () => {
    const wasm = readFileSync(FIXTURE);
    const config: CustomChipConfig = {
      chipJson: { name: "counter", pins: ["clk", "rst", "q0", "q1", "q2", "q3"] },
      wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    };
    const runner = makeRunner();
    const pb = runner.portB as unknown as MockPort;
    const runtime = new CustomChipRuntime(runner, diagram, "cnt", "uno", config, mapArduinoPin);
    await runtime.init();

    const readCount = () =>
      (pb.states[2] << 0) | (pb.states[3] << 1) | (pb.states[4] << 2) | (pb.states[5] << 3);

    const pulseClk = () => { pb.setPin(0, true); pb.setPin(0, false); };

    // Reset to 0
    pb.setPin(1, true); pb.setPin(1, false);
    expect(readCount()).toBe(0);

    // Five rising clock edges → count == 5
    for (let i = 0; i < 5; i++) pulseClk();
    expect(readCount()).toBe(5);

    // Five more → 10
    for (let i = 0; i < 5; i++) pulseClk();
    expect(readCount()).toBe(10);

    // Reset again
    pb.setPin(1, true); pb.setPin(1, false);
    expect(readCount()).toBe(0);

    runtime.dispose();
  });
});
