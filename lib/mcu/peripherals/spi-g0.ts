// STM32 SPI (G0/F0/F3/F7/L4 layout) — minimal master model: TX capture with the
// status flags HAL polls. HAL_SPI_Transmit waits for TXE before each DR write
// and for FTLVL-empty + BSY-clear at the end; with TXE permanently ready and the
// FIFO/BSY reported idle, transmits complete and bytes are captured.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const SR = 0x08; // RXNE(0), TXE(1), BSY(7), FTLVL(12:11), FRLVL(10:9)
const DR = 0x0c;

const SR_RXNE = 1 << 0;
const SR_TXE = 1 << 1;

export class STM32SpiG0 extends RegisterPeripheral {
  /** Called with each byte clocked out on MOSI. */
  onByteTransmit?: (byte: number) => void;
  private lastRx = 0xff;

  read(offset: number, width: AccessWidth): number {
    if (offset === DR) {
      this.writeReg(SR, 4, this.readReg(SR, 4) & ~SR_RXNE);
      return this.lastRx;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === DR) {
      this.onByteTransmit?.(value & 0xff);
      // Full-duplex: a received byte appears (idle MISO reads 0xFF here).
      this.lastRx = 0xff;
      this.writeReg(SR, 4, (this.readReg(SR, 4) | SR_TXE | SR_RXNE) & ~(1 << 7));
      return;
    }
    this.writeReg(offset, width, value);
  }

  reset(): void {
    super.reset();
    this.lastRx = 0xff;
    this.writeReg(SR, 4, SR_TXE); // transmitter empty, not busy
  }
}
