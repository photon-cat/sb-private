// STM32 USART (F1-style: SR/DR/BRR/CR1…). Models TX (capture) + RX (feed) and
// the status flags firmware polls (TXE/TC, RXNE), plus an optional RXNE/TC IRQ.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const SR = 0x00; // status: RXNE(5), TC(6), TXE(7)
const DR = 0x04; // data
const CR1 = 0x0c; // control: RXNEIE(5), TCIE(6), TE(3), RE(2), UE(13)

const SR_RXNE = 1 << 5;
const SR_TC = 1 << 6;
const SR_TXE = 1 << 7;
const CR1_RXNEIE = 1 << 5;
const CR1_TCIE = 1 << 6;

export class STM32UsartF1 extends RegisterPeripheral {
  private rxQueue: number[] = [];
  /** Called with each transmitted byte. */
  onByteTransmit?: (byte: number) => void;

  constructor(
    name: string,
    base: number,
    size: number,
    private readonly irq: number | null = null,
  ) {
    super(name, base, size);
  }

  read(offset: number, width: AccessWidth): number {
    if (offset === DR) {
      // Reading DR returns the next RX byte and clears RXNE.
      const byte = this.rxQueue.shift() ?? 0;
      if (this.rxQueue.length === 0) {
        this.writeReg(SR, 4, this.readReg(SR, 4) & ~SR_RXNE);
      }
      return byte;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === DR) {
      // Writing DR transmits a byte; TXE/TC stay asserted (instant TX).
      this.onByteTransmit?.(value & 0xff);
      this.writeReg(SR, 4, this.readReg(SR, 4) | SR_TXE | SR_TC);
      return;
    }
    this.writeReg(offset, width, value);
  }

  /** Feed a byte into the receiver (sets RXNE). */
  feedByte(byte: number): void {
    this.rxQueue.push(byte & 0xff);
    this.writeReg(SR, 4, this.readReg(SR, 4) | SR_RXNE);
  }

  pendingIRQ(): number | null {
    if (this.irq == null) return null;
    const sr = this.readReg(SR, 4);
    const cr1 = this.readReg(CR1, 4);
    const rxne = sr & SR_RXNE && cr1 & CR1_RXNEIE;
    const tc = sr & SR_TC && cr1 & CR1_TCIE;
    return rxne || tc ? this.irq : null;
  }

  reset(): void {
    super.reset();
    this.rxQueue = [];
    // Power-on: TXE + TC set (transmitter empty), per the reset value 0xC0.
    this.writeReg(SR, 4, SR_TXE | SR_TC);
  }
}
