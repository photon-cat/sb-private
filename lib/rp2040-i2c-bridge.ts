// RP2040 I2C bridge — the rp2040js counterpart of lib/i2c-bus.ts.
//
// The device controllers (SSD1306Controller, LCD1602Controller,
// MPU6050Controller, BMP180Controller) are written against avr8js's
// TWIEventHandler interface: the firmware is the I2C master, and each controller
// reacts to start/connect/write/read/stop events and reports completion by
// calling back into a `twi.complete*()` surface.
//
// rp2040js models I2C the other way around — RPI2C exposes master-side callbacks
// (onStart/onConnect/onWriteByte/onReadByte/onStop) and its own complete*()
// methods. This bridge wires those callbacks to the controllers and presents the
// `twi.complete*()` surface the controllers expect, so the SAME controllers run
// unchanged on AVR and RP2040.

import { I2CMode, type RPI2C } from "rp2040js";
import type { AVRTWI, TWIEventHandler } from "avr8js";

/**
 * The subset of AVRTWI the device controllers actually call. The bridge
 * implements it and forwards each completion to the underlying RPI2C.
 */
interface I2CCompletion {
  completeStart(): void;
  completeConnect(ack: boolean): void;
  completeWrite(ack: boolean): void;
  completeRead(value: number): void;
  completeStop(): void;
}

/**
 * Routes one rp2040js I2C peripheral's master traffic to TWIEventHandler devices
 * keyed by 7-bit address. Mirrors lib/i2c-bus.ts (the AVR I2CBus router).
 */
export class Rp2040I2CBridge implements I2CCompletion {
  private devices = new Map<number, TWIEventHandler>();
  private activeDevice: TWIEventHandler | null = null;

  constructor(private readonly i2c: RPI2C) {
    i2c.onStart = () => this.i2c.completeStart();
    i2c.onConnect = (address, mode) => this.onConnect(address, mode);
    i2c.onWriteByte = (value) => this.onWriteByte(value);
    i2c.onReadByte = (ack) => this.onReadByte(ack);
    i2c.onStop = () => this.onStop();
  }

  /** Register a slave device at a 7-bit address. */
  addDevice(address: number, handler: TWIEventHandler): void {
    this.devices.set(address, handler);
  }

  /** True if any device is registered (so callers can skip empty buses). */
  get hasDevices(): boolean {
    return this.devices.size > 0;
  }

  // --- RPI2C master callbacks ---

  private onConnect(address: number, mode: I2CMode): void {
    const device = this.devices.get(address);
    if (device) {
      this.activeDevice = device;
      device.connectToSlave(address, mode === I2CMode.Write);
    } else {
      this.activeDevice = null;
      this.i2c.completeConnect(false);
    }
  }

  private onWriteByte(value: number): void {
    if (this.activeDevice) this.activeDevice.writeByte(value);
    else this.i2c.completeWrite(false);
  }

  private onReadByte(ack: boolean): void {
    if (this.activeDevice) this.activeDevice.readByte(ack);
    else this.i2c.completeRead(0xff);
  }

  private onStop(): void {
    if (this.activeDevice) {
      this.activeDevice.stop();
      this.activeDevice = null;
    } else {
      this.i2c.completeStop();
    }
  }

  // --- I2CCompletion: the `twi` surface controllers call into ---

  completeStart(): void {
    this.i2c.completeStart();
  }
  completeConnect(ack: boolean): void {
    this.i2c.completeConnect(ack);
  }
  completeWrite(ack: boolean): void {
    this.i2c.completeWrite(ack);
  }
  completeRead(value: number): void {
    this.i2c.completeRead(value);
  }
  completeStop(): void {
    this.i2c.completeStop();
  }

  /**
   * The controllers are typed to receive an AVRTWI. They only ever call the
   * completion methods above, so the bridge is a safe stand-in. This cast keeps
   * the controllers reusable across AVR and RP2040 without widening their
   * constructor signatures.
   */
  asTwi(): AVRTWI {
    return this as unknown as AVRTWI;
  }
}
