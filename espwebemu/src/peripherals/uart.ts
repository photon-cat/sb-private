// ESP32 UART Peripheral Emulation
// UART0 base: 0x3FF40000, UART1: 0x3FF50000, UART2: 0x3FF6E000
import type { PeripheralHandler } from "../memory/memory-bus.js";

// Register offsets (relative to UART base)
const UART_FIFO_REG = 0x00;         // R/W FIFO data
const UART_INT_RAW_REG = 0x04;      // Interrupt raw status
const UART_INT_ST_REG = 0x08;       // Interrupt masked status
const UART_INT_ENA_REG = 0x0c;      // Interrupt enable
const UART_INT_CLR_REG = 0x10;      // Interrupt clear
const UART_CLKDIV_REG = 0x14;       // Clock divider
const UART_STATUS_REG = 0x1c;       // UART status (TX/RX FIFO counts)
const UART_CONF0_REG = 0x20;        // Configuration register 0
const UART_CONF1_REG = 0x24;        // Configuration register 1
const UART_MEM_CONF_REG = 0x58;     // Memory configuration
const UART_ID_REG = 0x78;           // UART ID register

// Status register bits
const UART_TXFIFO_CNT_S = 16;       // TX FIFO byte count shift
const UART_RXFIFO_CNT_S = 0;        // RX FIFO byte count shift

// Interrupt bits
const UART_TXFIFO_EMPTY_INT = 1 << 1;
const UART_RXFIFO_FULL_INT = 1 << 0;

export class ESP32UART implements PeripheralHandler {
  // Callbacks
  onByteTransmit?: (byte: number) => void;

  // RX FIFO — bytes received from external (e.g., serial input from user)
  private rxFifo: number[] = [];
  private readonly rxFifoSize = 128;

  // Registers
  private intRaw = 0;
  private intEna = 0;
  private conf0 = 0;
  private conf1 = 0;
  private clkdiv = 694; // Default for 115200 baud at 80MHz APB

  read32(offset: number): number {
    switch (offset) {
      case UART_FIFO_REG:
        // Read one byte from RX FIFO
        if (this.rxFifo.length > 0) {
          return this.rxFifo.shift()!;
        }
        return 0;

      case UART_INT_RAW_REG:
        return this.intRaw;

      case UART_INT_ST_REG:
        return this.intRaw & this.intEna;

      case UART_INT_ENA_REG:
        return this.intEna;

      case UART_CLKDIV_REG:
        return this.clkdiv;

      case UART_STATUS_REG:
        // TX FIFO always empty (we transmit instantly), RX FIFO count
        return (0 << UART_TXFIFO_CNT_S) | (this.rxFifo.length << UART_RXFIFO_CNT_S);

      case UART_CONF0_REG:
        return this.conf0;

      case UART_CONF1_REG:
        return this.conf1;

      case UART_MEM_CONF_REG:
        return 0x88; // Default memory allocation

      case UART_ID_REG:
        return 0x0500; // UART version

      default:
        return 0;
    }
  }

  write32(offset: number, value: number): void {
    switch (offset) {
      case UART_FIFO_REG:
        // Write to TX FIFO — transmit immediately
        if (this.onByteTransmit) {
          this.onByteTransmit(value & 0xff);
        }
        break;

      case UART_INT_ENA_REG:
        this.intEna = value;
        break;

      case UART_INT_CLR_REG:
        this.intRaw &= ~value;
        break;

      case UART_CLKDIV_REG:
        this.clkdiv = value;
        break;

      case UART_CONF0_REG:
        this.conf0 = value;
        break;

      case UART_CONF1_REG:
        this.conf1 = value;
        break;
    }
  }

  // Feed bytes into the RX FIFO (from external input)
  feedByte(byte: number): void {
    if (this.rxFifo.length < this.rxFifoSize) {
      this.rxFifo.push(byte & 0xff);
      this.intRaw |= UART_RXFIFO_FULL_INT;
    }
  }

  feedString(str: string): void {
    for (let i = 0; i < str.length; i++) {
      this.feedByte(str.charCodeAt(i));
    }
  }
}
