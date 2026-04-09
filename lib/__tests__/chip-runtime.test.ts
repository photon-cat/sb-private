import { describe, it, expect, beforeEach, vi } from "vitest";
import { PinState } from "avr8js";
import { CustomChipRuntime, type CustomChipConfig } from "../chip-runtime";
import type { Diagram } from "../diagram-parser";
import type { AVRRunnerLike, PinInfo } from "../pin-mapping";
import { mapArduinoPin } from "../pin-mapping";

/**
 * Mock port with in-memory state for testing chip-runtime bridges.
 * Matches the subset of avr8js AVRIOPort that chip-runtime actually uses.
 */
class MockPort {
  readonly states = new Uint8Array(8);
  readonly listeners = new Set<() => void>();

  setPin(pin: number, high: boolean) {
    this.states[pin] = high ? 1 : 0;
    for (const l of this.listeners) l();
  }

  pinState(pin: number): number {
    return this.states[pin] ? PinState.High : PinState.Low;
  }

  addListener(cb: () => void) {
    this.listeners.add(cb);
  }

  removeListener(cb: () => void) {
    this.listeners.delete(cb);
  }
}

function makeRunner(): AVRRunnerLike {
  return {
    cpu: {
      cycles: 0,
      addClockEvent: vi.fn((cb: () => void, _cycles: number) => {
        // Fire immediately for tests (cycles deferral isn't what we're testing)
        cb();
        return null;
      }),
    },
    portB: new MockPort(),
    portC: new MockPort(),
    portD: new MockPort(),
    usart: {} as AVRRunnerLike["usart"],
    twi: {} as AVRRunnerLike["twi"],
    adc: {
      channelValues: [0, 0, 0, 0, 0, 0],
    } as unknown as AVRRunnerLike["adc"],
    speed: 16_000_000,
  } as unknown as AVRRunnerLike;
}

/** Minimal diagram with an Uno and a chip. Used for connection-based tests. */
function makeDiagram(extraConnections: [string, string][] = [], extraParts: Diagram["parts"] = []): Diagram {
  return {
    parts: [
      { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
      { id: "chip1", type: "chip-test", top: 0, left: 0, attrs: {} },
      ...extraParts,
    ],
    connections: extraConnections.map(([a, b]) => [a, b, "red", []] as unknown as Diagram["connections"][number]),
    version: 1,
  } as Diagram;
}

function makeConfig(): CustomChipConfig {
  return {
    chipJson: { name: "test", pins: [] },
    // Empty buffer — buildImportsForTest doesn't instantiate the WASM.
    wasmBytes: new ArrayBuffer(0),
  };
}

/** Write a C string into the runtime's WASM memory at `offset`. Returns pointer. */
function writeCString(imports: WebAssembly.Imports, offset: number, s: string): number {
  const memory = (imports.env as { memory: WebAssembly.Memory }).memory;
  const view = new Uint8Array(memory.buffer);
  for (let i = 0; i < s.length; i++) view[offset + i] = s.charCodeAt(i);
  view[offset + s.length] = 0;
  return offset;
}

function getEnv(imports: WebAssembly.Imports) {
  return imports.env as unknown as Record<string, (...args: number[]) => number | void>;
}

describe("chip-runtime — GPIO", () => {
  let runner: AVRRunnerLike;
  let diagram: Diagram;
  let runtime: CustomChipRuntime;
  let imports: WebAssembly.Imports;
  let env: ReturnType<typeof getEnv>;

  beforeEach(() => {
    runner = makeRunner();
    diagram = makeDiagram([["chip1:IN", "uno:8"], ["chip1:OUT", "uno:9"]]);
    runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    imports = runtime.buildImportsForTest();
    env = getEnv(imports);
  });

  it("pinInit resolves a chip pin name to an MCU pin and returns a numeric id", () => {
    const ptr = writeCString(imports, 64, "IN");
    const id = env.pinInit(ptr, 0 /* INPUT */);
    expect(id).toBe(0); // first pin → id 0
  });

  it("pinInit with OUTPUT_HIGH drives the MCU pin high", () => {
    const ptr = writeCString(imports, 64, "OUT"); // OUT → uno:9 → portB pin 1
    env.pinInit(ptr, 17 /* OUTPUT_HIGH */);

    const portB = runner.portB as unknown as MockPort;
    expect(portB.states[1]).toBe(1);
  });

  it("pinRead returns 1 when the MCU pin is high", () => {
    const ptr = writeCString(imports, 64, "IN");
    const id = env.pinInit(ptr, 0);
    (runner.portB as unknown as MockPort).setPin(0, true); // uno:8 → portB 0
    expect(env.pinRead(id as number)).toBe(1);
  });

  it("pinWrite drives the connected MCU pin", () => {
    const ptr = writeCString(imports, 64, "OUT");
    const id = env.pinInit(ptr, 1 /* OUTPUT */);
    env.pinWrite(id as number, 1);
    expect((runner.portB as unknown as MockPort).states[1]).toBe(1);
    env.pinWrite(id as number, 0);
    expect((runner.portB as unknown as MockPort).states[1]).toBe(0);
  });

  it("pinInit on an unconnected pin name still returns an id", () => {
    const ptr = writeCString(imports, 64, "FLOATING");
    const id = env.pinInit(ptr, 0);
    expect(typeof id).toBe("number");
    // pinRead on it returns 0 (no MCU binding)
    expect(env.pinRead(id as number)).toBe(0);
  });
});

describe("chip-runtime — Analog ADC/DAC", () => {
  it("pinADCRead returns the voltage of a connected potentiometer", () => {
    const runner = makeRunner();
    const diagram: Diagram = {
      parts: [
        { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
        { id: "chip1", type: "chip-test", top: 0, left: 0, attrs: {} },
        { id: "pot1", type: "wokwi-potentiometer", top: 0, left: 0, attrs: { value: "512" } },
      ],
      connections: [["pot1:SIG", "chip1:IN", "red", []]],
      version: 1,
    } as unknown as Diagram;

    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);

    const ptr = writeCString(imports, 64, "IN");
    const id = env.pinInit(ptr, 4 /* ANALOG */) as number;
    const voltage = env.pinADCRead(id) as number;
    // 512 / 1023 * 5V ≈ 2.5V
    expect(voltage).toBeCloseTo(2.503, 2);
  });

  it("pinADCRead returns 0 for an unconnected pin", () => {
    const runner = makeRunner();
    const diagram = makeDiagram(); // no external connections to chip1
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);

    const ptr = writeCString(imports, 64, "FLOATING");
    const id = env.pinInit(ptr, 4) as number;
    expect(env.pinADCRead(id)).toBe(0);
  });

  it("pinADCRead reads from the MCU's ADC channel when connected to A0", () => {
    const runner = makeRunner();
    const diagram = makeDiagram([["chip1:SENSE", "uno:A0"]]);
    // Pre-set the ADC channel value
    (runner.adc.channelValues as unknown as number[])[0] = 3.14;

    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const env = getEnv(runtime.buildImportsForTest());
    const ptr = writeCString(runtime.buildImportsForTest(), 64, "SENSE");
    // Need to pinInit on the same imports object the pointer was written into:
    const imports = runtime.buildImportsForTest();
    const ptr2 = writeCString(imports, 64, "SENSE");
    const id = (imports.env as any).pinInit(ptr2, 4);
    const v = (imports.env as any).pinADCRead(id);
    expect(v).toBeCloseTo(3.14, 2);
  });

  it("pinDACWrite drives the MCU ADC channel when connected to an A-pin", () => {
    const runner = makeRunner();
    const diagram = makeDiagram([["chip1:OUT", "uno:A3"]]);
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);

    const ptr = writeCString(imports, 64, "OUT");
    const id = env.pinInit(ptr, 4) as number;
    env.pinDACWrite(id, 2.7);
    expect((runner.adc.channelValues as unknown as number[])[3]).toBeCloseTo(2.7, 2);
  });

  it("pinDACWrite clamps voltages to 0..5V", () => {
    const runner = makeRunner();
    const diagram = makeDiagram([["chip1:OUT", "uno:A0"]]);
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const env = getEnv(runtime.buildImportsForTest());

    // Redo with fresh imports to get a consistent pin id:
    const imports = runtime.buildImportsForTest();
    const ptr = writeCString(imports, 64, "OUT");
    const id = (imports.env as any).pinInit(ptr, 4);
    (imports.env as any).pinDACWrite(id, 99);
    expect((runner.adc.channelValues as unknown as number[])[0]).toBe(5);
    (imports.env as any).pinDACWrite(id, -10);
    expect((runner.adc.channelValues as unknown as number[])[0]).toBe(0);
  });
});

describe("chip-runtime — Attributes", () => {
  let runtime: CustomChipRuntime;
  let imports: WebAssembly.Imports;
  let env: ReturnType<typeof getEnv>;

  beforeEach(() => {
    const runner = makeRunner();
    const diagram = makeDiagram();
    runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    imports = runtime.buildImportsForTest();
    env = getEnv(imports);
  });

  it("attrInit returns sequential ids and stores the default value", () => {
    const ptr1 = writeCString(imports, 64, "foo");
    const id1 = env.attrInit(ptr1, 42);
    expect(id1).toBe(0);
    expect(env.attrRead(id1 as number)).toBe(42);
  });

  it("attrInitFloat stores a float default", () => {
    const ptr = writeCString(imports, 64, "bar");
    const id = env.attrInitFloat(ptr, 1.5);
    expect(env.attrReadFloat(id as number)).toBeCloseTo(1.5);
  });

  it("host getAttr / setAttr round-trip by name", () => {
    const ptr = writeCString(imports, 64, "gain");
    env.attrInit(ptr, 1);
    expect(runtime.getAttr("gain")).toBe(1);

    runtime.setAttr("gain", 7);
    expect(runtime.getAttr("gain")).toBe(7);

    // Chip-side read sees the new value too
    expect(env.attrRead(0)).toBe(7);
  });

  it("getAttr returns undefined for an unknown attribute", () => {
    expect(runtime.getAttr("missing")).toBeUndefined();
  });

  it("setAttr on an unknown name is a no-op", () => {
    runtime.setAttr("nope", 100);
    expect(runtime.getAttr("nope")).toBeUndefined();
  });
});

describe("chip-runtime — Helpers", () => {
  it("getBaudRate-like pin mapping: verifies connection traversal", () => {
    const runner = makeRunner();
    const diagram = makeDiagram([["chip1:INPUT", "uno:13"]]);
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);

    const ptr = writeCString(imports, 64, "INPUT");
    const id = env.pinInit(ptr, 1 /* OUTPUT */) as number;
    env.pinWrite(id, 1);
    // uno:13 → portB pin 5
    expect((runner.portB as unknown as MockPort).states[5]).toBe(1);
  });
});
