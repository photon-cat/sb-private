// STM32 I2C master (I2Cv2 IP: G0/F0/F3/F7/L4/H7…) — the register/flag state
// machine HAL drives in polling mode, plus a slave-device bus so real sensor
// drivers get answers. This is the peripheral the stress harness found firmware
// spinning on (HAL_I2C polls TXIS/RXNE/TC/STOPF that an unmodeled bus never sets).
//
// Master flow HAL uses (e.g. HAL_I2C_Mem_Read):
//   CR2 = SADD|NBYTES|RD_WRN|START (+AUTOEND or SOFTEND) → hardware addresses the
//   slave; TXIS asks for each TX byte, RXNE offers each RX byte, TC marks a
//   SOFTEND transfer done (for repeated start), STOPF marks an AUTOEND done. A
//   missing slave sets NACKF so the driver errors out instead of hanging.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";
import type { I2CDevice } from "./i2c-device";

const CR2 = 0x04;
const ISR = 0x18;
const ICR = 0x1c;
const RXDR = 0x24;
const TXDR = 0x28;

const CR2_RD_WRN = 1 << 10;
const CR2_START = 1 << 13;
const CR2_STOP = 1 << 14;
const CR2_AUTOEND = 1 << 25;

const ISR_TXE = 1 << 0;
const ISR_TXIS = 1 << 1;
const ISR_RXNE = 1 << 2;
const ISR_NACKF = 1 << 4;
const ISR_STOPF = 1 << 5;
const ISR_TC = 1 << 6;
const ISR_BUSY = 1 << 15;

export class STM32I2CG0 extends RegisterPeripheral {
  private readonly devices = new Map<number, I2CDevice>();
  private active: I2CDevice | null = null;
  private remaining = 0;
  private autoend = false;
  private reading = false;
  private rxShadow = 0;

  /** Attach a slave device on this bus (keyed by its 7-bit address). */
  attach(device: I2CDevice): void {
    this.devices.set(device.address, device);
  }

  read(offset: number, width: AccessWidth): number {
    if (offset === RXDR) {
      const v = this.rxShadow;
      this.consumeRxByte();
      return v;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === CR2) {
      this.writeReg(CR2, 4, value);
      if (value & CR2_START) this.beginTransfer(value >>> 0);
      if (value & CR2_STOP) this.stopTransfer();
      return;
    }
    if (offset === TXDR) {
      this.txByte(value & 0xff);
      return;
    }
    if (offset === ICR) {
      // Write-1-to-clear: NACKF(4), STOPF(5), ADDR(3) etc.
      this.setIsr(this.isr() & ~(value >>> 0));
      return;
    }
    this.writeReg(offset, width, value);
  }

  private beginTransfer(cr2: number): void {
    const addr = (cr2 >>> 1) & 0x7f; // SADD[7:1] holds the 7-bit address
    this.remaining = (cr2 >>> 16) & 0xff; // NBYTES
    this.autoend = (cr2 & CR2_AUTOEND) !== 0;
    this.reading = (cr2 & CR2_RD_WRN) !== 0;
    // Hardware self-clears START.
    this.writeReg(CR2, 4, cr2 & ~CR2_START);

    const dev = this.devices.get(addr);
    if (!dev) {
      // No slave acknowledges → NACK + STOP, so HAL returns an error.
      this.active = null;
      this.setIsr((this.isr() | ISR_NACKF | ISR_STOPF) & ~ISR_BUSY);
      return;
    }
    this.active = dev;
    if (this.reading) {
      dev.startRead();
      this.prefetchRxByte();
    } else {
      dev.startWrite();
      // Transmitter ready for the first byte.
      this.setIsr((this.isr() | ISR_TXIS | ISR_TXE) & ~ISR_NACKF);
    }
  }

  private txByte(byte: number): void {
    if (!this.active) return;
    this.active.writeByte(byte);
    if (this.remaining > 0) this.remaining--;
    if (this.remaining > 0) {
      this.setIsr(this.isr() | ISR_TXIS | ISR_TXE);
    } else {
      this.setIsr(this.isr() & ~ISR_TXIS);
      this.endPhase();
    }
  }

  private prefetchRxByte(): void {
    if (!this.active || this.remaining === 0) {
      this.endPhase();
      return;
    }
    this.rxShadow = this.active.readByte();
    this.setIsr(this.isr() | ISR_RXNE);
  }

  private consumeRxByte(): void {
    if (this.remaining > 0) this.remaining--;
    if (this.remaining > 0 && this.active) {
      this.rxShadow = this.active.readByte();
      this.setIsr(this.isr() | ISR_RXNE);
    } else {
      this.setIsr(this.isr() & ~ISR_RXNE);
      this.endPhase();
    }
  }

  private endPhase(): void {
    // SOFTEND (no AUTOEND) → TC, so HAL can issue a repeated start; AUTOEND →
    // STOPF, ending the transfer.
    if (this.autoend) {
      this.setIsr((this.isr() | ISR_STOPF) & ~ISR_BUSY);
      this.active?.stop();
      this.active = null;
    } else {
      this.setIsr(this.isr() | ISR_TC);
    }
  }

  private stopTransfer(): void {
    this.active?.stop();
    this.active = null;
    this.setIsr((this.isr() | ISR_STOPF) & ~ISR_BUSY);
  }

  private isr(): number {
    return this.readReg(ISR, 4);
  }
  private setIsr(v: number): void {
    this.writeReg(ISR, 4, v >>> 0);
  }

  reset(): void {
    super.reset();
    this.active = null;
    this.remaining = 0;
    this.rxShadow = 0;
    this.setIsr(ISR_TXE); // transmitter empty, bus idle
  }
}
