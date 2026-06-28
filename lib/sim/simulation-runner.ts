import { AVRRunner, type AVRRunnerOptions } from "../avr-runner";
import { wireComponents, cleanupWiring, type WiredComponent } from "../wire-components";
import { wireCustomChipsAsync, type CustomChipConfig, type CustomChipRuntime } from "../chip-runtime";
import { mapArduinoPin, mapAtmega328Pin } from "../pin-mapping";
import type { Diagram, MCUInfo } from "../diagram-parser";
import type { I2CBus } from "../i2c-bus";
import { createHeadlessMcu, type HeadlessMcu } from "./headless-mcu";
import type { SimCore } from "./sim-core";

export interface SimulationConfig {
  clockHz?: number;
  realtimeThrottle?: boolean;
  speedMultiplier?: number;
  maxCycles?: number;
  timeoutMs?: number;
}

export interface SimulationState {
  cycles: number;
  simulatedMs: number;
  wallMs: number;
  serial: string;
  effectiveSpeed: number;
}

export interface SimulationHandle {
  /** Underlying AVR runner (AVR only; undefined for STM32/RP2040). Legacy access. */
  runner?: AVRRunner;
  /** MCU clock in Hz (drives the run loop's cycle/time math). */
  clockHz: number;
  wired: Map<string, WiredComponent>;
  i2cBus?: I2CBus;
  chipRuntimes: Map<string, CustomChipRuntime>;
  getSerial: () => string;
  getState: () => SimulationState;
  sendSerial: (text: string) => void;
  /** Register a per-byte serial listener (e.g. to tee to stdout live). */
  addSerialListener: (cb: (byte: number) => void) => void;
  setControl: (partId: string, control: string, value: number | boolean | string) => void;
  runMs: (ms: number) => void;
  runCycles: (count: number) => void;
  stop: () => void;
  dispose: () => void;
}

/** Firmware for a simulation: a hex string (AVR) or a {simCore, hex|bin} object. */
export type SimulationFirmware =
  | string
  | { simCore: SimCore; hex?: string; bin?: Uint8Array };

function applyControl(
  wired: Map<string, WiredComponent>,
  partId: string,
  control: string,
  value: number | boolean | string,
): void {
  const wc = wired.get(partId);
  if (!wc) return;
  switch (control) {
    case "pressed": wc.setPressed?.(Boolean(value)); break;
    case "state": wc.setState?.(Boolean(value)); break;
    case "value": wc.setValue?.(Number(value)); break;
    case "temperature": wc.setTemperature?.(Number(value)); break;
    case "humidity": wc.setHumidity?.(Number(value)); break;
    case "pressure": wc.setPressure?.(Number(value)); break;
    case "stepCW": wc.stepCW?.(); break;
    case "stepCCW": wc.stepCCW?.(); break;
  }
}

/**
 * Create an AVR simulation synchronously from a compiled HEX. AVR-only and no
 * custom chips (use {@link wireChips} after, or {@link createSimulationAsync}).
 */
export function createSimulation(
  hex: string,
  diagram: Diagram,
  target: MCUInfo,
  config?: SimulationConfig,
): SimulationHandle {
  const clockHz = config?.clockHz ?? 16e6;
  const runnerOpts: AVRRunnerOptions = { clockHz };

  const runner = new AVRRunner(hex, runnerOpts);
  const { wired, i2cBus } = wireComponents(runner, diagram);

  let serial = "";
  const listeners: ((byte: number) => void)[] = [];
  const wallStartMs = performance.now();

  runner.usart.onByteTransmit = (byte: number) => {
    serial += String.fromCharCode(byte);
    for (const cb of listeners) cb(byte);
  };

  const chipRuntimes = new Map<string, CustomChipRuntime>();

  const getState = (): SimulationState => {
    const wallMs = performance.now() - wallStartMs;
    const simulatedMs = (runner.cpu.cycles / runner.speed) * 1000;
    return {
      cycles: runner.cpu.cycles,
      simulatedMs: Math.round(simulatedMs * 1000) / 1000,
      wallMs: Math.round(wallMs),
      serial,
      effectiveSpeed: wallMs > 0 ? simulatedMs / wallMs : 0,
    };
  };

  return {
    runner,
    clockHz: runner.speed,
    wired,
    i2cBus,
    chipRuntimes,
    getSerial: () => serial,
    getState,
    sendSerial: (text: string) => {
      for (const ch of text) runner.usart.writeByte(ch.charCodeAt(0));
    },
    addSerialListener: (cb) => { listeners.push(cb); },
    setControl: (partId, control, value) => applyControl(wired, partId, control, value),
    runMs: (ms: number) => runner.runMs(ms),
    runCycles: (count: number) => runner.runCycles(count),
    stop: () => runner.stop(),
    dispose: () => {
      for (const rt of chipRuntimes.values()) rt.dispose();
      cleanupWiring(wired);
      runner.stop();
    },
  };
}

/**
 * Create a simulation for ANY core (AVR/STM32/RP2040). `firmware` is a hex string
 * (AVR) or {simCore, hex|bin}. Custom chips (AVR) wire in via `chipConfigs`.
 */
export async function createSimulationAsync(
  firmware: SimulationFirmware,
  diagram: Diagram,
  target: MCUInfo,
  config?: SimulationConfig,
  chipConfigs?: Map<string, CustomChipConfig>,
): Promise<SimulationHandle> {
  const fw = typeof firmware === "string" ? { simCore: "avr8js" as SimCore, hex: firmware } : firmware;
  const mcu = await createHeadlessMcu({
    simCore: fw.simCore,
    hex: fw.hex,
    bin: fw.bin,
    diagram,
    target,
    clockHz: config?.clockHz,
    chipConfigs,
  });
  return wrapHeadless(mcu);
}

/** Adapt a HeadlessMcu to the richer SimulationHandle used by the CLI. */
function wrapHeadless(mcu: HeadlessMcu): SimulationHandle {
  const wallStartMs = performance.now();
  const getState = (): SimulationState => {
    const wallMs = performance.now() - wallStartMs;
    const simulatedMs = (mcu.cycles / mcu.clockHz) * 1000;
    return {
      cycles: mcu.cycles,
      simulatedMs: Math.round(simulatedMs * 1000) / 1000,
      wallMs: Math.round(wallMs),
      serial: mcu.serial(),
      effectiveSpeed: wallMs > 0 ? simulatedMs / wallMs : 0,
    };
  };
  return {
    runner: undefined,
    clockHz: mcu.clockHz,
    wired: mcu.wired,
    i2cBus: mcu.i2cBus,
    chipRuntimes: mcu.chipRuntimes,
    getSerial: () => mcu.serial(),
    getState,
    sendSerial: (text) => mcu.sendSerial(text),
    addSerialListener: (cb) => mcu.addSerialListener(cb),
    setControl: (partId, control, value) => applyControl(mcu.wired, partId, control, value),
    runMs: (ms) => mcu.runMs(ms),
    runCycles: (count) => mcu.runCycles(count),
    stop: () => mcu.stop(),
    dispose: () => mcu.dispose(),
  };
}

/**
 * Wire custom chips into an existing AVR simulation handle. No-op without an AVR
 * runner (STM32/RP2040 wire chips through {@link createSimulationAsync} instead).
 */
export async function wireChips(
  handle: SimulationHandle,
  diagram: Diagram,
  target: MCUInfo,
  chipConfigs: Map<string, CustomChipConfig>,
): Promise<void> {
  if (chipConfigs.size === 0 || !handle.runner || !handle.i2cBus) return;

  const pinMapper =
    target.boardId === "atmega328p" ? mapAtmega328Pin : mapArduinoPin;
  const runtimes = await wireCustomChipsAsync(
    handle.runner,
    diagram,
    target.id,
    pinMapper,
    handle.wired,
    chipConfigs,
    handle.i2cBus,
  );

  for (const [k, v] of runtimes) {
    handle.chipRuntimes.set(k, v);
  }
}
