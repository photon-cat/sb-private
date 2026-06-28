// STM32 runner (Cortex-M0/M0+ families: C0/G0/L0) — wraps the SVD-driven
// peripheral framework and the rp2040js-derived M0+ core (CortexM0Host) the same
// way AVRRunner wraps avr8js and RP2040Runner wraps rp2040js.
//
// Construction = "SVD + firmware": buildPlatform() turns the CMSIS-SVD into the
// peripheral bus, CortexM0Host runs real Thumb against the STM32 memory map, and
// USART/GPIO are bridged to the same serial/pin surface the scenario runner uses.

import { CortexM0Host, type CortexM0HostOptions } from "./mcu/cortex-m0-host";
import type { McuCoreHost } from "./mcu/core-host";
import type { MMIOBus } from "./mcu/mmio-bus";
import { buildPlatform, STM32G0_MODELS, type Platform, type PeripheralFactory } from "./mcu/platform";
import type { Peripheral } from "./mcu/peripheral";
import type { I2CDevice } from "./mcu/peripherals/i2c-device";

/** GPIO surface shared by STM32GpioF1 and STM32GpioG0 (duck-typed across families). */
interface GpioModel {
  pinOutput(pin: number): boolean;
  setInput(pin: number, high: boolean): void;
  watch(cb: (pin: number, high: boolean) => void): () => void;
}
/** USART surface shared by STM32UsartF1 and STM32UsartG0. */
interface SerialModel {
  onByteTransmit?: (byte: number) => void;
  feedByte(byte: number): void;
}
/** ADC surface shared by STM32AdcF1 and STM32AdcG0. */
interface AnalogModel {
  setChannel(channel: number, value12bit: number): void;
}
/** I2C-master surface shared by STM32I2CF1 and STM32I2CG0. */
interface I2CHostModel {
  attach(device: I2CDevice): void;
}
const isGpio = (p: Peripheral | undefined): p is Peripheral & GpioModel =>
  !!p && typeof (p as Partial<GpioModel>).pinOutput === "function";
const isSerial = (p: Peripheral | undefined): p is Peripheral & SerialModel =>
  !!p && typeof (p as Partial<SerialModel>).feedByte === "function";
const isAnalog = (p: Peripheral | undefined): p is Peripheral & AnalogModel =>
  !!p && typeof (p as Partial<AnalogModel>).setChannel === "function";
const isI2CHost = (p: Peripheral | undefined): p is Peripheral & I2CHostModel =>
  !!p && typeof (p as Partial<I2CHostModel>).attach === "function";

const DEFAULT_CLOCK_HZ = 16_000_000; // STM32G0 HSI16
/** Instructions executed per real-time work unit in execute() (browser loop). */
const WORK_UNIT_INSTR = 200_000;

export interface STM32RunnerOptions extends CortexM0HostOptions {
  /** System clock in Hz (default 16 MHz HSI16). */
  clockHz?: number;
  /** IP-model registry keyed by SVD group (default G0/C0/L0 models). */
  models?: Record<string, PeripheralFactory>;
  /**
   * Build the core host from the peripheral bus. Defaults to a CortexM0Host
   * (ARMv6-M). Pass a factory returning a UnicornArmHost for ARMv7-M (F1/F4/…).
   */
  hostFactory?: (bus: MMIOBus) => McuCoreHost;
}

export class STM32Runner {
  readonly platform: Platform;
  readonly host: McuCoreHost;
  readonly clockHz: number;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wallStartMs = 0;
  private simStartCycles = 0;

  /** Set to receive each byte transmitted on any USART. */
  onSerialByte?: (byte: number) => void;

  constructor(firmware: Uint8Array, svdXml: string, options: STM32RunnerOptions = {}) {
    if (options.clockHz !== undefined && (options.clockHz <= 0 || !isFinite(options.clockHz))) {
      throw new Error(`clockHz must be a positive finite number, got ${options.clockHz}`);
    }
    this.clockHz = options.clockHz ?? DEFAULT_CLOCK_HZ;

    this.platform = buildPlatform(svdXml, { models: options.models ?? STM32G0_MODELS });
    this.host = options.hostFactory
      ? options.hostFactory(this.platform.bus)
      : new CortexM0Host(this.platform.bus, options);

    // Bridge every USART's TX to the unified serial sink (F1 or G0 flavor).
    for (const p of this.platform.device.peripherals) {
      const model = this.platform.bus.get(p.name);
      if (isSerial(model)) {
        model.onByteTransmit = (b) => this.emitByte(b);
      }
    }

    this.host.loadFlash(firmware);
    this.host.reset();
  }

  private emitByte(b: number): void {
    this.onSerialByte?.(b);
  }

  get cycles(): number {
    return this.host.cycles;
  }

  /** Run a fixed number of CPU cycles (instructions step the borrowed core). */
  runCycles(count: number): void {
    const target = this.host.cycles + count;
    let guard = count * 4 + 1000; // bound iterations even if cycles stall
    while (!this.stopped && this.host.cycles < target && guard-- > 0) {
      this.host.step();
    }
  }

  /**
   * Drive the simulation in real time from a host timer (the browser path,
   * mirroring AVRRunner.execute). Runs a batch of instructions per tick and
   * throttles so simulated time tracks wall-clock time. `callback` fires once
   * per batch (e.g. to flush UI state).
   */
  execute(callback?: () => void): void {
    if (this.stopped) return;
    if (this.wallStartMs === 0) {
      this.wallStartMs = performance.now();
      this.simStartCycles = this.host.cycles;
    }
    this.host.runBatch(WORK_UNIT_INSTR);
    callback?.();

    const simElapsedMs = ((this.host.cycles - this.simStartCycles) / this.clockHz) * 1000;
    const aheadMs = simElapsedMs - (performance.now() - this.wallStartMs);
    this.timer = setTimeout(() => this.execute(callback), aheadMs > 2 ? aheadMs : 0);
  }

  /** Resume after stop()/pause() — restarts the real-time loop on next execute(). */
  resume(): void {
    this.stopped = false;
  }

  /** Set an ADC channel's 12-bit sample value (0..4095), e.g. from a potentiometer. */
  setAnalog(channel: number, value12bit: number): void {
    for (const p of this.platform.device.peripherals) {
      const model = this.platform.bus.get(p.name);
      if (isAnalog(model)) {
        model.setChannel(channel, value12bit);
        return;
      }
    }
  }

  /** Run for the given number of milliseconds of simulated time. */
  runMs(ms: number): void {
    this.runCycles(Math.round((ms / 1000) * this.clockHz));
  }

  private gpio(port: string): GpioModel | undefined {
    const p = this.platform.bus.get(port);
    return isGpio(p) ? p : undefined;
  }

  /** Logic level driven on an output pin, e.g. ("GPIOA", 5). */
  pinState(port: string, pin: number): boolean {
    return this.gpio(port)?.pinOutput(pin) ?? false;
  }

  /** Drive an external input level onto a pin. */
  setPinInput(port: string, pin: number, high: boolean): void {
    this.gpio(port)?.setInput(pin, high);
  }

  /** Watch an output pin for changes. Returns an unsubscribe function. */
  watchPin(port: string, pin: number, cb: (high: boolean) => void): () => void {
    const g = this.gpio(port);
    if (!g) return () => {};
    return g.watch((p, high) => {
      if (p === pin) cb(high);
    });
  }

  /** Feed a byte into a USART receiver (default USART1). */
  feedSerial(byte: number, usart = "USART1"): void {
    const p = this.platform.bus.get(usart);
    if (isSerial(p)) p.feedByte(byte);
  }

  /** Attach an I2C slave device to a bus (default I2C1), e.g. an IMU or sensor. */
  attachI2CDevice(device: I2CDevice, bus = "I2C1"): void {
    const p = this.platform.bus.get(bus);
    if (isI2CHost(p)) p.attach(device);
    else throw new Error(`${bus} is not a modeled I2C peripheral`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.wallStartMs = 0;
    this.simStartCycles = 0;
  }
}
