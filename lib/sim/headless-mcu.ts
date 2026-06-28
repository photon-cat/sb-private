// Unified headless MCU abstraction.
//
// AVRRunner (avr8js), STM32Runner (CortexM0Host / unicorn.js) and RP2040Runner
// (rp2040js) each expose different APIs for time, serial and GPIO. The headless
// simulation engine (createSimulation) and the scenario runner used to be hard-
// wired to AVRRunner; this adapter presents ONE interface over all three so a
// compiled `.hex`/`.bin`/`.uf2` runs the same way regardless of MCU.
//
// Each adapter owns: component wiring (the shared WiredComponent map), serial
// capture + injection, and pin-level reads by board-native pin name.

import { PinState } from "avr8js";
import { GPIOPinState } from "rp2040js";
import type { Diagram, MCUInfo } from "../diagram-parser";
import { findMCUs } from "../diagram-parser";
import type { WiredComponent } from "../wire-components";
import { wireComponents } from "../wire-components";
import { wireComponentsStm32 } from "../wire-components-stm32";
import { wireComponentsRp2040 } from "../wire-components-rp2040";
import { wireCustomChipsAsync, type CustomChipConfig, type CustomChipRuntime } from "../chip-runtime";
import {
  mapArduinoPin,
  mapAtmega328Pin,
  mapSTM32Pin,
  mapRp2040Pin,
  getPort,
} from "../pin-mapping";
import type { I2CBus } from "../i2c-bus";
import type { SimCore } from "./sim-core";

/** A board-native runner unified behind one headless interface. */
export interface HeadlessMcu {
  readonly simCore: SimCore;
  /** Clock in Hz — drives runMs() and simulated-time math. */
  readonly clockHz: number;
  /** Retired CPU cycles since reset. */
  readonly cycles: number;
  /** Components wired to the MCU (LED/buzzer/button/pot/displays/…). */
  readonly wired: Map<string, WiredComponent>;
  /** AVR I2C bus (used by custom chips). Undefined for STM32/RP2040. */
  readonly i2cBus?: I2CBus;
  /** Live custom-chip runtimes (AVR only; empty otherwise). */
  readonly chipRuntimes: Map<string, CustomChipRuntime>;

  runCycles(count: number): void;
  runMs(ms: number): void;

  /** Accumulated serial output so far. */
  serial(): string;
  /** Reset the captured serial buffer. */
  clearSerial(): void;
  /** Register a per-byte serial listener (e.g. to tee to stdout live). */
  addSerialListener(cb: (byte: number) => void): void;
  /** Append text into the captured serial stream (e.g. custom-chip console output). */
  injectSerial(text: string): void;
  /** Send text to the MCU's serial RX. Throws if unsupported on this core. */
  sendSerial(text: string): void;

  /** Logic level of a board-native pin ("13"/"A0"/"PB5"/"PC13"/"GP25"). Throws on unknown. */
  pinHigh(pinName: string): boolean;

  stop(): void;
  dispose(): void;
}

export interface HeadlessMcuOptions {
  simCore: SimCore;
  /** Intel HEX (AVR). */
  hex?: string;
  /** Raw firmware bytes — `.bin` for STM32, `.uf2` for RP2040. */
  bin?: Uint8Array;
  diagram: Diagram;
  /** Resolved MCU part (for pin mapping / chip wiring). Auto-detected if omitted. */
  target?: MCUInfo;
  clockHz?: number;
  /** Custom-chip configs (AVR only). */
  chipConfigs?: Map<string, CustomChipConfig>;
}

/** Build the right runner for `simCore` and return it behind the headless interface. */
export async function createHeadlessMcu(opts: HeadlessMcuOptions): Promise<HeadlessMcu> {
  switch (opts.simCore) {
    case "avr8js":
      return createAvrHeadless(opts);
    case "rp2040":
      return createRp2040Headless(opts);
    case "cortex-m0":
    case "unicorn-arm":
      return createStm32Headless(opts);
    default:
      throw new Error(`No headless simulation core for "${opts.simCore}"`);
  }
}

/** Shared serial-capture state used by every adapter. */
function makeSerialSink() {
  let buffer = "";
  const listeners: ((byte: number) => void)[] = [];
  return {
    onByte: (byte: number) => {
      buffer += String.fromCharCode(byte);
      for (const cb of listeners) cb(byte);
    },
    serial: () => buffer,
    clearSerial: () => { buffer = ""; },
    addSerialListener: (cb: (byte: number) => void) => { listeners.push(cb); },
    injectSerial: (text: string) => { for (const ch of text) buffer += ch; },
  };
}

// ── AVR (avr8js) ───────────────────────────────────────────────────────────

async function createAvrHeadless(opts: HeadlessMcuOptions): Promise<HeadlessMcu> {
  const { AVRRunner } = await import("../avr-runner");
  const runner = new AVRRunner(opts.hex ?? "", { clockHz: opts.clockHz });
  const { wired, i2cBus } = wireComponents(runner, opts.diagram);
  const sink = makeSerialSink();
  runner.usart.onByteTransmit = sink.onByte;

  const chipRuntimes = new Map<string, CustomChipRuntime>();
  if (opts.chipConfigs && opts.chipConfigs.size > 0) {
    const target = opts.target ?? findMCUs(opts.diagram).find((m) => m.simulatable);
    if (target) {
      const pinMapper = target.boardId === "atmega328p" ? mapAtmega328Pin : mapArduinoPin;
      const runtimes = await wireCustomChipsAsync(
        runner, opts.diagram, target.id, pinMapper, wired, opts.chipConfigs, i2cBus,
      );
      for (const [k, v] of runtimes) chipRuntimes.set(k, v);
    }
  }

  return {
    simCore: "avr8js",
    clockHz: runner.speed,
    get cycles() { return runner.cpu.cycles; },
    wired,
    i2cBus,
    chipRuntimes,
    runCycles: (n) => runner.runCycles(n),
    runMs: (ms) => runner.runMs(ms),
    serial: sink.serial,
    clearSerial: sink.clearSerial,
    addSerialListener: sink.addSerialListener,
    injectSerial: sink.injectSerial,
    sendSerial: (text) => {
      for (const ch of text) runner.usart.writeByte(ch.charCodeAt(0));
    },
    pinHigh: (pinName) => {
      const info = mapArduinoPin(pinName) ?? mapAtmega328Pin(pinName);
      if (!info) throw new Error(`Unknown AVR pin "${pinName}"`);
      return getPort(runner, info.port).pinState(info.pin) === PinState.High;
    },
    stop: () => runner.stop(),
    dispose: () => {
      for (const rt of chipRuntimes.values()) rt.dispose();
      runner.stop();
    },
  };
}

// ── STM32 (CortexM0Host / unicorn.js) ──────────────────────────────────────

async function createStm32Headless(opts: HeadlessMcuOptions): Promise<HeadlessMcu> {
  if (!opts.bin) throw new Error("STM32 simulation requires firmware bytes (bin)");
  const { createStm32Runner } = await import("./create-stm32-runner");
  const runner = await createStm32Runner(opts.simCore, opts.bin, { clockHz: opts.clockHz });
  const { wired } = wireComponentsStm32(runner, opts.diagram, opts.target?.id);
  const sink = makeSerialSink();
  runner.onSerialByte = sink.onByte;

  return {
    simCore: opts.simCore,
    clockHz: runner.clockHz,
    get cycles() { return runner.cycles; },
    wired,
    chipRuntimes: new Map(),
    runCycles: (n) => runner.runCycles(n),
    runMs: (ms) => runner.runMs(ms),
    serial: sink.serial,
    clearSerial: sink.clearSerial,
    addSerialListener: sink.addSerialListener,
    injectSerial: sink.injectSerial,
    sendSerial: () => {
      throw new Error("send-serial is not supported on the STM32 core yet (no USART RX feed)");
    },
    pinHigh: (pinName) => {
      const loc = mapSTM32Pin(pinName);
      if (!loc) throw new Error(`Unknown STM32 pin "${pinName}"`);
      return runner.pinState(loc.port, loc.pin);
    },
    stop: () => runner.stop(),
    dispose: () => runner.stop(),
  };
}

// ── RP2040 (rp2040js) ──────────────────────────────────────────────────────

async function createRp2040Headless(opts: HeadlessMcuOptions): Promise<HeadlessMcu> {
  if (!opts.bin) throw new Error("RP2040 simulation requires firmware bytes (uf2)");
  const { RP2040Runner } = await import("../rp2040-runner");
  const runner = new RP2040Runner(opts.bin, { clockHz: opts.clockHz });
  const { wired } = wireComponentsRp2040(runner, opts.diagram, opts.target?.id);
  const sink = makeSerialSink();
  runner.onSerialByte = sink.onByte;

  return {
    simCore: "rp2040",
    clockHz: runner.speed,
    get cycles() { return runner.mcu.core.cycles; },
    wired,
    chipRuntimes: new Map(),
    runCycles: (n) => runner.runCycles(n),
    runMs: (ms) => runner.runMs(ms),
    serial: sink.serial,
    clearSerial: sink.clearSerial,
    addSerialListener: sink.addSerialListener,
    injectSerial: sink.injectSerial,
    sendSerial: (text) => {
      for (const ch of text) runner.feedUart(ch.charCodeAt(0));
    },
    pinHigh: (pinName) => {
      const gp = mapRp2040Pin(pinName);
      if (gp == null) throw new Error(`Unknown RP2040 pin "${pinName}"`);
      return runner.gpioState(gp) === GPIOPinState.High;
    },
    stop: () => runner.stop(),
    dispose: () => runner.stop(),
  };
}
