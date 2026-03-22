// ESP32 I2C Peripheral Stub
// I2C0 base: 0x3FF53000, I2C1 base: 0x3FF67000
import type { PeripheralHandler } from "../memory/memory-bus.js";

// Minimal stub — returns sensible defaults, accepts writes silently
export class ESP32I2C implements PeripheralHandler {
  private ctrlReg = 0;
  private slaveAddr = 0;
  private timeoutReg = 0;
  private fifoConf = 0;

  // I2C device callbacks for connected peripherals
  onTransmit?: (addr: number, data: Uint8Array) => Uint8Array | null;

  read32(offset: number): number {
    switch (offset) {
      case 0x00: return this.ctrlReg;
      case 0x04: return 0; // Status: idle, no errors
      case 0x08: return this.timeoutReg;
      case 0x0c: return this.slaveAddr;
      case 0x18: return this.fifoConf;
      case 0x1c: return 0; // FIFO data — empty
      case 0x24: return 0x80000000; // Command done
      default: return 0;
    }
  }

  write32(offset: number, value: number): void {
    switch (offset) {
      case 0x00: this.ctrlReg = value; break;
      case 0x08: this.timeoutReg = value; break;
      case 0x0c: this.slaveAddr = value; break;
      case 0x18: this.fifoConf = value; break;
      case 0x1c: break; // FIFO write — store for later transmit
      default: break;
    }
  }
}
