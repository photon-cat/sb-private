// STM32 GPIO port (F1-style register layout: CRL/CRH/IDR/ODR/BSRR/BRR).
// One model reused for every GPIO instance (GPIOA, GPIOB, …) — base address
// comes from the SVD.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const CRL = 0x00;
const CRH = 0x04;
const IDR = 0x08;
const ODR = 0x0c;
const BSRR = 0x10;
const BRR = 0x14;

export class STM32GpioF1 extends RegisterPeripheral {
  /** External input level per pin (0/1), driven by wiring. */
  private inputs = 0;
  /** Listeners notified when an output pin changes. */
  private listeners = new Set<(pin: number, high: boolean) => void>();

  read(offset: number, width: AccessWidth): number {
    if (offset === IDR) {
      // Input data: external inputs OR-ed with driven outputs (push-pull).
      return (this.inputs | this.readReg(ODR, 4)) & 0xffff;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === BSRR) {
      // Atomic set/reset: low 16 set bits, high 16 reset bits.
      const set = value & 0xffff;
      const reset = (value >>> 16) & 0xffff;
      let odr = this.readReg(ODR, 4);
      odr = (odr | set) & ~reset & 0xffff;
      this.setOdr(odr);
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
          const high = ((next >> pin) & 1) === 1;
          for (const l of this.listeners) l(pin, high);
        }
      }
    }
  }

  /** Logic level on an output pin (from ODR). */
  pinOutput(pin: number): boolean {
    return ((this.readReg(ODR, 4) >> pin) & 1) === 1;
  }

  /** Drive an external input level onto a pin. */
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
    this.writeReg(CRL, 4, 0x44444444);
    this.writeReg(CRH, 4, 0x44444444);
  }
}
