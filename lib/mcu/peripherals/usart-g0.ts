// STM32 USART (modern ISR/TDR/RDR layout: G0/F0/F3/F7/L4/G4…).
//
// The post-F1 USART splits the F1 SR/DR into separate ISR (status), RDR (read
// data), TDR (transmit data), and adds an ICR to clear flags. Same TX-capture /
// RX-feed behavior and TXE/TC/RXNE flags firmware polls, plus RXNE/TC IRQ.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const CR1 = 0x00; // UE(0), RE(2), TE(3), RXNEIE(5), TCIE(6)
const ISR = 0x1c; // RXNE(5), TC(6), TXE(7), TEACK(21), REACK(22)
const ICR = 0x20; // write-1-to-clear (TCCF bit6, etc.)
const RDR = 0x24;
const TDR = 0x28;

const ISR_RXNE = 1 << 5;
const ISR_TC = 1 << 6;
const ISR_TXE = 1 << 7;
const ISR_TEACK = 1 << 21; // transmit-enable acknowledge
const ISR_REACK = 1 << 22; // receive-enable acknowledge
const CR1_UE = 1 << 0;
const CR1_RE = 1 << 2;
const CR1_TE = 1 << 3;
const CR1_RXNEIE = 1 << 5;
const CR1_TCIE = 1 << 6;

export class STM32UsartG0 extends RegisterPeripheral {
  private rxQueue: number[] = [];
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
    if (offset === RDR) {
      const byte = this.rxQueue.shift() ?? 0;
      if (this.rxQueue.length === 0) {
        this.writeReg(ISR, 4, this.readReg(ISR, 4) & ~ISR_RXNE);
      }
      return byte;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === TDR) {
      this.onByteTransmit?.(value & 0xff);
      this.writeReg(ISR, 4, this.readReg(ISR, 4) | ISR_TXE | ISR_TC);
      return;
    }
    if (offset === ICR) {
      // Write-1-to-clear status flags (firmware clears TC via TCCF=bit6).
      this.writeReg(ISR, 4, this.readReg(ISR, 4) & ~(value >>> 0));
      return;
    }
    if (offset === CR1) {
      this.writeReg(CR1, 4, value);
      // HAL_UART_Init spins on TEACK/REACK after enabling the USART; mirror the
      // TE/RE enables into their acknowledge flags so init completes.
      let isr = this.readReg(ISR, 4);
      const en = (value & CR1_UE) !== 0;
      isr = en && value & CR1_TE ? isr | ISR_TEACK : isr & ~ISR_TEACK;
      isr = en && value & CR1_RE ? isr | ISR_REACK : isr & ~ISR_REACK;
      this.writeReg(ISR, 4, isr);
      return;
    }
    this.writeReg(offset, width, value);
  }

  feedByte(byte: number): void {
    this.rxQueue.push(byte & 0xff);
    this.writeReg(ISR, 4, this.readReg(ISR, 4) | ISR_RXNE);
  }

  pendingIRQ(): number | null {
    if (this.irq == null) return null;
    const isr = this.readReg(ISR, 4);
    const cr1 = this.readReg(CR1, 4);
    const rxne = isr & ISR_RXNE && cr1 & CR1_RXNEIE;
    const tc = isr & ISR_TC && cr1 & CR1_TCIE;
    return rxne || tc ? this.irq : null;
  }

  reset(): void {
    super.reset();
    this.rxQueue = [];
    // Power-on: TXE + TC asserted (transmitter empty).
    this.writeReg(ISR, 4, ISR_TXE | ISR_TC);
  }
}
