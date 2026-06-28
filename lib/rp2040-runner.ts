// RP2040 (Raspberry Pi Pico) runner — wraps wokwi/rp2040js the same way
// AVRRunner wraps avr8js. Loads UF2/hex firmware, steps the dual Cortex-M0+,
// bridges GPIO, and captures serial from both UART0 and USB CDC (Arduino-Pico's
// `Serial` is USB CDC; `Serial1` is UART0 on GP0/GP1).

import { Simulator, RP2040, USBCDC, GPIOPinState } from "rp2040js";
import type { TWIEventHandler } from "avr8js";
import { bootromB1 } from "./rp2040/bootrom";
import { loadUF2 } from "./rp2040/load-flash";
import { loadHex } from "./rp2040/intelhex";
import { Rp2040I2CBridge } from "./rp2040-i2c-bridge";

/** A scheduled one-shot timer on the simulation clock (rp2040js IAlarm shape). */
export interface Rp2040Alarm {
  schedule(deltaNanos: number): void;
  cancel(): void;
}

const FLASH_START = 0x10000000;
const DEFAULT_CLOCK_HZ = 125_000_000;

export interface RP2040RunnerOptions {
  clockHz?: number;
}

export class RP2040Runner {
  readonly sim: Simulator;
  readonly mcu: RP2040;
  readonly cdc: USBCDC;
  readonly speed: number;
  private stopped = false;
  /** Lazily-created I2C routers, one per rp2040js I2C peripheral (i2c0/i2c1). */
  private readonly i2cBridges: Array<Rp2040I2CBridge | undefined> = [];

  /** Set to receive each serial byte (UART0 + USB CDC) as it is produced. */
  onSerialByte?: (byte: number) => void;

  constructor(firmware: Uint8Array | string, options?: RP2040RunnerOptions) {
    if (options?.clockHz !== undefined && (options.clockHz <= 0 || !isFinite(options.clockHz))) {
      throw new Error(`clockHz must be a positive finite number, got ${options.clockHz}`);
    }
    this.speed = options?.clockHz ?? DEFAULT_CLOCK_HZ;

    this.sim = new Simulator();
    this.mcu = this.sim.rp2040;
    this.mcu.loadBootrom(bootromB1);

    if (typeof firmware === "string") {
      loadHex(firmware, this.mcu.flash, FLASH_START);
    } else {
      loadUF2(firmware, this.mcu);
    }

    // Start executing from flash (boot2 stage), matching the rp2040js demo.
    this.mcu.core.PC = FLASH_START;

    // UART0 serial output.
    this.mcu.uart[0].onByte = (value: number) => this.emitByte(value);

    // USB CDC serial output (Arduino-Pico default `Serial`).
    this.cdc = new USBCDC(this.mcu.usbCtrl);
    this.cdc.onSerialData = (buffer: Uint8Array) => {
      for (const b of buffer) this.emitByte(b);
    };
  }

  private emitByte(b: number): void {
    this.onSerialByte?.(b);
  }

  /**
   * Run ~`count` CPU cycles synchronously (headless/test use).
   *
   * Mirrors rp2040js's Simulator.execute(): each instruction advances the
   * SimulationClock by its cycle cost, and WFI/WFE fast-forwards to the next
   * alarm. Without ticking the clock the 64-bit TIMER never advances, so
   * sleep_ms()/busy_wait() spin forever and firmware never reaches its loop.
   */
  runCycles(count: number): void {
    const clock = this.sim.clock;
    const cycleNanos = 1e9 / this.speed;
    let executed = 0;
    while (!this.stopped && executed < count) {
      if (this.mcu.core.waiting) {
        const { nanosToNextAlarm } = clock;
        if (!isFinite(nanosToNextAlarm) || nanosToNextAlarm <= 0) break; // WFI with no pending alarm
        clock.tick(nanosToNextAlarm);
        executed += nanosToNextAlarm / cycleNanos;
      } else {
        const cycles = this.mcu.core.executeInstruction();
        clock.tick(cycles * cycleNanos);
        executed += cycles;
      }
    }
  }

  /** Run for the given number of milliseconds of simulated time. */
  runMs(ms: number): void {
    this.runCycles(Math.round((ms / 1000) * this.speed));
  }

  /** Current logic state of a GPIO pin (GP0..GP29). */
  gpioState(pin: number): GPIOPinState {
    return this.mcu.gpio[pin].value;
  }

  /** True when the GPIO pin is driven high (output) or reads high. */
  gpioHigh(pin: number): boolean {
    const s = this.mcu.gpio[pin].value;
    return s === GPIOPinState.High;
  }

  /** Watch a GPIO pin for state changes. Returns an unsubscribe function. */
  watchGpio(pin: number, cb: (state: GPIOPinState, old: GPIOPinState) => void): () => void {
    return this.mcu.gpio[pin].addListener(cb);
  }

  /** Drive an external input value onto a GPIO pin. */
  setGpioInput(pin: number, high: boolean): void {
    this.mcu.gpio[pin].setInputValue(high);
  }

  /** Feed a byte into UART0 RX (for sketches reading Serial1). */
  feedUart(byte: number): void {
    this.mcu.uart[0].feedByte(byte);
  }

  // --- Analog input (ADC) ---

  /**
   * Set an ADC channel's raw 12-bit conversion result (0..4095). Channels 0..3
   * are GPIO 26..29; channel 4 is the internal temperature sensor. Used by
   * potentiometer/analog wiring.
   */
  setAdcChannel(channel: number, value12bit: number): void {
    if (channel < 0 || channel >= this.mcu.adc.channelValues.length) return;
    this.mcu.adc.channelValues[channel] = Math.max(0, Math.min(4095, Math.round(value12bit)));
  }

  // --- I2C (master) ---

  /**
   * Get (creating on first use) the I2C router for a peripheral (0 = i2c0,
   * 1 = i2c1). Device controllers are constructed with `bridge.asTwi()` and then
   * registered via `bridge.addDevice(addr, controller)`. A device must be bound
   * to the single bus its SDA/SCL pins select, because a stateful controller can
   * only report completion to one peripheral.
   */
  ensureI2CBridge(busIndex = 0): Rp2040I2CBridge {
    if (!this.mcu.i2c[busIndex]) {
      throw new Error(`RP2040 has no I2C peripheral ${busIndex}`);
    }
    let bridge = this.i2cBridges[busIndex];
    if (!bridge) {
      bridge = new Rp2040I2CBridge(this.mcu.i2c[busIndex]);
      this.i2cBridges[busIndex] = bridge;
    }
    return bridge;
  }

  /** Convenience: attach an I2C slave at a 7-bit address on the given bus. */
  attachI2CDevice(address: number, handler: TWIEventHandler, busIndex = 0): void {
    this.ensureI2CBridge(busIndex).addDevice(address, handler);
  }

  // --- SPI (master) ---

  /**
   * Install a byte handler on an SPI peripheral (0 = spi0, 1 = spi1). The
   * handler receives each MOSI byte and returns the MISO byte to clock back
   * (0 for write-only devices like a TFT).
   */
  attachSpiHandler(handler: (mosi: number) => number, busIndex = 0): void {
    const spi = this.mcu.spi[busIndex];
    if (!spi) throw new Error(`RP2040 has no SPI peripheral ${busIndex}`);
    spi.onTransmit = (value: number) => spi.completeTransmit(handler(value) & 0xff);
  }

  // --- Simulation clock (for protocol timing in sims) ---

  /** Current simulated time in nanoseconds. */
  get nanos(): number {
    return this.sim.clock.nanos;
  }

  /** Create a one-shot alarm on the simulation clock (call schedule() to arm). */
  createAlarm(callback: () => void): Rp2040Alarm {
    return this.sim.clock.createAlarm(callback);
  }

  stop(): void {
    this.stopped = true;
    this.sim.stop();
  }
}
