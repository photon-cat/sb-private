import { describe, it, expect, beforeEach, vi } from "vitest";
import { PinState } from "avr8js";
import { CustomChipRuntime, type CustomChipConfig } from "../chip-runtime";
import type { Diagram } from "../diagram-parser";
import type { AVRRunnerLike } from "../pin-mapping";
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
  // SPI mock: default onByte mimics avr8js by completing with 0 MISO. Uses a
  // closure (not `this`) so the runtime can call the captured handler unbound.
  const completeTransfer = vi.fn();
  const spi = {
    completeTransfer,
    onByte: (_value: number) => completeTransfer(0),
  };
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
    usart: {
      onByteTransmit: null,
      writeByte: vi.fn(),
    } as unknown as AVRRunnerLike["usart"],
    twi: {} as AVRRunnerLike["twi"],
    adc: {
      channelValues: [0, 0, 0, 0, 0, 0],
    } as unknown as AVRRunnerLike["adc"],
    spi: spi as unknown as AVRRunnerLike["spi"],
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
    connections: extraConnections.map(([a, b]) => ({ from: a, to: b, color: "red", hints: [] as string[] })),
    version: 1,
    author: "test",
    editor: "sparkbench",
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

describe("chip-runtime — SPI", () => {
  function setup(connections: [string, string][]) {
    const runner = makeRunner();
    const diagram = makeDiagram(connections);
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);
    const memory = (imports.env as { memory: WebAssembly.Memory }).memory;
    return { runner, runtime, env, memory };
  }

  it("spiInit returns a device id and installs an onByte handler", () => {
    const { runner, env, memory } = setup([["chip1:MISO", "uno:12"]]);
    // spi_config_t: user_data@0, sck@4, mosi@8, miso@12, mode@16, done@20
    const cfgPtr = 128;
    new DataView(memory.buffer); // config can stay zeroed (no done callback)
    const id = env.spiInit(cfgPtr);
    expect(id).toBe(0);
    // Handler installed — exchanging a byte now routes through the runtime.
    expect(typeof runner.spi.onByte).toBe("function");
  });

  it("exchanges bytes: returns the chip's buffer as MISO and records MOSI", () => {
    const { runner, env, memory } = setup([["chip1:MISO", "uno:12"]]);
    const view = new DataView(memory.buffer);
    const cfgPtr = 128;
    // zero the config (done ptr 0 → no callback)
    for (let i = 0; i < 56; i++) view.setUint8(cfgPtr + i, 0);
    const spiId = env.spiInit(cfgPtr) as number;

    // Arm with a 2-byte MISO buffer [0x42, 0x43] at ptr 256.
    const bufPtr = 256;
    const mem = new Uint8Array(memory.buffer);
    mem[bufPtr] = 0x42;
    mem[bufPtr + 1] = 0x43;
    env.spiStart(spiId, bufPtr, 2);

    // MCU clocks two bytes. completeTransfer should receive the chip's buffer bytes.
    const completeTransfer = runner.spi.completeTransfer as unknown as ReturnType<typeof vi.fn>;
    runner.spi.onByte(0x0f);
    runner.spi.onByte(0x10);

    expect(completeTransfer).toHaveBeenNthCalledWith(1, 0x42);
    expect(completeTransfer).toHaveBeenNthCalledWith(2, 0x43);
    // Received MOSI bytes were written back into the buffer.
    expect(mem[bufPtr]).toBe(0x0f);
    expect(mem[bufPtr + 1]).toBe(0x10);
  });

  it("delegates to the previous handler when not armed (idle MISO)", () => {
    const { runner, env, memory } = setup([["chip1:MISO", "uno:12"]]);
    const view = new DataView(memory.buffer);
    for (let i = 0; i < 56; i++) view.setUint8(128 + i, 0);
    env.spiInit(128); // armed = false by default
    const completeTransfer = runner.spi.completeTransfer as unknown as ReturnType<typeof vi.fn>;
    runner.spi.onByte(0xaa);
    // Falls through to the captured default which completes with 0.
    expect(completeTransfer).toHaveBeenCalledWith(0);
  });
});

describe("chip-runtime — UART bridge gating", () => {
  function build(connections: [string, string][], rxName: string, txName: string) {
    const runner = makeRunner();
    const diagram = makeDiagram(connections);
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);
    const memory = (imports.env as { memory: WebAssembly.Memory }).memory;
    // pin_init RX and TX so their ids resolve to MCU pins
    const rxId = env.pinInit(writeCString(imports, 16, rxName), 0) as number;
    const txId = env.pinInit(writeCString(imports, 32, txName), 1) as number;
    // uart_config_t: user_data@0, rx@4, tx@8, baud@12, rx_data@16, write_done@20
    const cfgPtr = 128;
    const view = new DataView(memory.buffer);
    for (let i = 0; i < 56; i++) view.setUint8(cfgPtr + i, 0);
    view.setInt32(cfgPtr + 4, rxId, true);
    view.setInt32(cfgPtr + 8, txId, true);
    return { runner, env, cfgPtr };
  }

  it("bridges to the MCU USART when RX is wired to MCU TX (D1)", () => {
    const { runner, env, cfgPtr } = build([["chip1:RX", "uno:1"], ["chip1:TX", "uno:0"]], "RX", "TX");
    env.uartInit(cfgPtr);
    // Bridging replaces onByteTransmit with the chip's chained handler.
    expect(runner.usart.onByteTransmit).toBeTypeOf("function");
  });

  it("does NOT hijack the USART when UART pins are unrelated", () => {
    const { runner, env, cfgPtr } = build([["chip1:RX", "uno:7"], ["chip1:TX", "uno:8"]], "RX", "TX");
    env.uartInit(cfgPtr);
    expect(runner.usart.onByteTransmit).toBeNull();
  });
});

describe("chip-runtime — Framebuffer", () => {
  it("framebufferInit reads dimensions; bufferWrite/bufferRead round-trip pixels", () => {
    const runner = makeRunner();
    const diagram = makeDiagram();
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);
    const memory = (imports.env as { memory: WebAssembly.Memory }).memory;
    const view = new DataView(memory.buffer);

    // width=4, height=2 at pointers
    view.setUint32(8, 4, true);
    view.setUint32(12, 2, true);
    const fbId = env.framebufferInit(8, 12) as number;

    const fb = runtime.getFramebuffer(fbId);
    expect(fb?.width).toBe(4);
    expect(fb?.height).toBe(2);
    expect(fb?.pixels.length).toBe(4 * 2 * 4);

    // write 4 bytes at offset 0, read them back
    const mem = new Uint8Array(memory.buffer);
    mem[64] = 0xde; mem[65] = 0xad; mem[66] = 0xbe; mem[67] = 0xef;
    env.bufferWrite(fbId, 0, 64, 4);
    expect(Array.from(fb!.pixels.slice(0, 4))).toEqual([0xde, 0xad, 0xbe, 0xef]);

    env.bufferRead(fbId, 0, 128, 4);
    expect(Array.from(mem.slice(128, 132))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe("chip-runtime — string attrs & DAC return", () => {
  it("attrStringInit reads a persisted string attribute; stringRead copies it out", () => {
    const runner = makeRunner();
    const diagram: Diagram = {
      parts: [
        { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
        { id: "chip1", type: "chip-test", top: 0, left: 0, attrs: { label: "Hi" } },
      ],
      connections: [],
      version: 1,
      author: "test",
      editor: "sparkbench",
    } as Diagram;
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);
    const memory = (imports.env as { memory: WebAssembly.Memory }).memory;

    const nPtr = writeCString(imports, 16, "label");
    const sid = env.attrStringInit(nPtr_(nPtr)) as number;
    expect(env.stringGetLength(sid)).toBe(2);
    const n = env.stringRead(sid, 64, 16) as number;
    expect(n).toBe(2);
    const mem = new Uint8Array(memory.buffer);
    expect(String.fromCharCode(mem[64], mem[65])).toBe("Hi");
  });

  it("pinDACWrite returns the written voltage (ABI returns float)", () => {
    const runner = makeRunner();
    const diagram = makeDiagram([["chip1:OUT", "uno:A0"]]);
    const runtime = new CustomChipRuntime(runner, diagram, "chip1", "uno", makeConfig(), mapArduinoPin);
    const imports = runtime.buildImportsForTest();
    const env = getEnv(imports);
    const id = env.pinInit(writeCString(imports, 16, "OUT"), 4 /* ANALOG */) as number;
    expect(env.pinDACWrite(id, 3.3)).toBeCloseTo(3.3, 5);
  });
});

function nPtr_(p: number): number { return p; }
