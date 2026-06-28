// STM32 GPIO port (modern MODER-style layout, used by G0/C0/L0/F0/F3/F7/L4/G4…).
// Distinct from the F1 CRL/CRH model — this is the register flavor shared across
// the whole post-F1 STM32 lineup, so one model serves the M0+ families and most
// M4/M7 parts. Base address comes from the SVD (GPIO is on the IOPORT/AHB bus,
// e.g. 0x50000000 on G0).

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const MODER = 0x00; // 2 bits/pin: 00 input, 01 output, 10 alt, 11 analog
const OTYPER = 0x04;
const OSPEEDR = 0x08;
const PUPDR = 0x0c;
const IDR = 0x10;
const ODR = 0x14;
const BSRR = 0x18; // set (low 16) / reset (high 16)
const BRR = 0x28; // reset only

export class STM32GpioG0 extends RegisterPeripheral {
  private inputs = 0;
  private listeners = new Set<(pin: number, high: boolean) => void>();

  read(offset: number, width: AccessWidth): number {
    if (offset === IDR) {
      // Per pin: output mode reads back the driven ODR level; otherwise the
      // external input level. MODER holds 2 bits/pin (01 = output).
      const moder = this.readReg(MODER, 4);
      const odr = this.readReg(ODR, 4);
      let idr = 0;
      for (let pin = 0; pin < 16; pin++) {
        const isOutput = ((moder >>> (pin * 2)) & 0x3) === 0b01;
        const level = isOutput ? (odr >>> pin) & 1 : (this.inputs >>> pin) & 1;
        idr |= level << pin;
      }
      return idr & 0xffff;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === BSRR) {
      const set = value & 0xffff;
      const reset = (value >>> 16) & 0xffff;
      // RM: if both BSx and BRx are set for a pin, BS (set) has priority.
      this.setOdr((this.readReg(ODR, 4) | set) & ~(reset & ~set) & 0xffff);
      return;
    }
    if (offset === BRR) {
      this.setOdr(this.readReg(ODR, 4) & ~(value & 0xffff) & 0xffff);
      return;
    }
    if (offset === ODR) {
      this.setOdr(value & 0xffff);
      return;
    }
    this.writeReg(offset, width, value);
  }

  private setOdr(next: number): void {
    const prev = this.readReg(ODR, 4);
    this.writeReg(ODR, 4, next);
    if (prev !== next) {
      for (let pin = 0; pin < 16; pin++) {
        if (((prev ^ next) >> pin) & 1) {
          for (const l of this.listeners) l(pin, ((next >> pin) & 1) === 1);
        }
      }
    }
  }

  pinOutput(pin: number): boolean {
    return ((this.readReg(ODR, 4) >> pin) & 1) === 1;
  }

  setInput(pin: number, high: boolean): void {
    if (high) this.inputs |= 1 << pin;
    else this.inputs &= ~(1 << pin);
  }

  watch(cb: (pin: number, high: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  reset(): void {
    super.reset();
    this.inputs = 0;
    // Real reset values vary per port (SWD pins); 0 is fine for simulation since
    // firmware configures MODER before use.
  }
}
