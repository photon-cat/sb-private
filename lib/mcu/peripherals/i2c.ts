// STM32 I2C master — F1 flavor (I2Cv1 IP: CR1/CR2/DR/SR1/SR2). This is the older
// register/flag state machine than the modern I2Cv2 (G0/F0/F3/F7) model: a START
// sets SB, writing the address to DR sets ADDR (or AF if no slave acks), and the
// EVx flag-clear sequences HAL polls (read SR1 then write DR to clear SB; read
// SR1 then read SR2 to clear ADDR) are honored. A slave-device bus answers real
// sensor drivers; a missing slave NACKs (AF) so HAL errors out instead of hanging.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";
import type { I2CDevice } from "./i2c-device";

const CR1 = 0x00;
const DR = 0x10;
const SR1 = 0x14;
const SR2 = 0x18;

const CR1_PE = 1 << 0;
const CR1_START = 1 << 8;
const CR1_STOP = 1 << 9;

const SR1_SB = 1 << 0; // start bit sent
const SR1_ADDR = 1 << 1; // address sent/matched
const SR1_BTF = 1 << 2; // byte transfer finished
const SR1_RXNE = 1 << 6; // data register not empty (receive)
const SR1_TXE = 1 << 7; // data register empty (transmit)
const SR1_AF = 1 << 10; // acknowledge failure (NACK)

const SR2_MSL = 1 << 0; // master mode
const SR2_BUSY = 1 << 1; // bus busy
const SR2_TRA = 1 << 2; // transmitter (1) / receiver (0)

export class STM32I2CF1 extends RegisterPeripheral {
  private readonly devices = new Map<number, I2CDevice>();
  private active: I2CDevice | null = null;
  private reading = false;
  /** True between a START (SB set) and the address byte write. */
  private addrPhase = false;
  private rxShadow = 0;

  /** Attach a slave device on this bus (keyed by its 7-bit address). */
  attach(device: I2CDevice): void {
    this.devices.set(device.address, device);
  }

  read(offset: number, width: AccessWidth): number {
    if (offset === SR2) {
      const v = this.readReg(SR2, 4);
      // Reading SR2 after SR1 clears ADDR (the HAL EV6 clear sequence). For a
      // read transfer, reception begins now: prefetch the first byte.
      if (this.sr1() & SR1_ADDR) {
        this.setSr1(this.sr1() & ~SR1_ADDR);
        if (this.reading && this.active) {
          this.rxShadow = this.active.readByte();
          this.setSr1(this.sr1() | SR1_RXNE);
        }
      }
      return v;
    }
    if (offset === DR) {
      const v = this.rxShadow;
      if (this.reading && this.active) {
        // Keep a byte staged; HAL controls the count and issues NACK/STOP.
        this.rxShadow = this.active.readByte();
        this.setSr1((this.sr1() | SR1_RXNE) & ~SR1_BTF);
      } else {
        this.setSr1(this.sr1() & ~SR1_RXNE);
      }
      return v;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === CR1) {
      this.writeReg(CR1, 4, value);
      if (value & CR1_STOP) this.stopTransfer();
      // START generates a (repeated) start: SB set, master/busy asserted.
      if (value & CR1_START && value & CR1_PE) {
        this.setSr1(this.sr1() | SR1_SB);
        this.writeReg(SR2, 4, this.readReg(SR2, 4) | SR2_MSL | SR2_BUSY);
        this.addrPhase = true;
      }
      return;
    }
    if (offset === DR) {
      if (this.addrPhase) this.addressByte(value & 0xff);
      else this.txByte(value & 0xff);
      return;
    }
    if (offset === SR1) {
      // SR1 flags are read/clear-by-writing-0 (rc_w0); keep only bits still set.
      this.setSr1(this.sr1() & (value >>> 0));
      return;
    }
    this.writeReg(offset, width, value);
  }

  private addressByte(value: number): void {
    const addr = (value >>> 1) & 0x7f;
    this.reading = (value & 1) === 1;
    this.setSr1(this.sr1() & ~SR1_SB); // SB cleared by the address write
    this.addrPhase = false;

    const dev = this.devices.get(addr);
    if (!dev) {
      // No slave acknowledges → AF, so HAL returns an error.
      this.active = null;
      this.setSr1(this.sr1() | SR1_AF);
      return;
    }
    this.active = dev;
    if (this.reading) {
      this.writeReg(SR2, 4, this.readReg(SR2, 4) & ~SR2_TRA);
      dev.startRead();
    } else {
      this.writeReg(SR2, 4, this.readReg(SR2, 4) | SR2_TRA);
      dev.startWrite();
      this.setSr1(this.sr1() | SR1_TXE);
    }
    this.setSr1(this.sr1() | SR1_ADDR);
  }

  private txByte(byte: number): void {
    if (!this.active) return;
    this.active.writeByte(byte);
    // Transmitter empty + byte transfer finished, so HAL can write the next
    // byte or finish with a STOP.
    this.setSr1(this.sr1() | SR1_TXE | SR1_BTF);
  }

  private stopTransfer(): void {
    this.active?.stop();
    this.active = null;
    this.reading = false;
    this.addrPhase = false;
    this.writeReg(SR2, 4, this.readReg(SR2, 4) & ~(SR2_MSL | SR2_BUSY | SR2_TRA));
  }

  private sr1(): number {
    return this.readReg(SR1, 4);
  }
  private setSr1(v: number): void {
    this.writeReg(SR1, 4, v >>> 0);
  }

  reset(): void {
    super.reset();
    this.active = null;
    this.reading = false;
    this.addrPhase = false;
    this.rxShadow = 0;
  }
}
