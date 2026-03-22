// ESP32 GPIO Peripheral Emulation
// GPIO base: 0x3FF44000
import type { PeripheralHandler } from "../memory/memory-bus.js";

// Register offsets
const GPIO_BT_SELECT_REG = 0x00;
const GPIO_OUT_REG = 0x04;            // Output value (GPIO 0-31)
const GPIO_OUT_W1TS_REG = 0x08;       // Write 1 to set output bits
const GPIO_OUT_W1TC_REG = 0x0c;       // Write 1 to clear output bits
const GPIO_OUT1_REG = 0x10;           // Output value (GPIO 32-39)
const GPIO_OUT1_W1TS_REG = 0x14;
const GPIO_OUT1_W1TC_REG = 0x18;
const GPIO_ENABLE_REG = 0x20;         // Output enable (GPIO 0-31)
const GPIO_ENABLE_W1TS_REG = 0x24;
const GPIO_ENABLE_W1TC_REG = 0x28;
const GPIO_ENABLE1_REG = 0x2c;        // Output enable (GPIO 32-39)
const GPIO_ENABLE1_W1TS_REG = 0x30;
const GPIO_ENABLE1_W1TC_REG = 0x34;
const GPIO_STRAP_REG = 0x38;          // Bootstrap pin values
const GPIO_IN_REG = 0x3c;             // Input value (GPIO 0-31)
const GPIO_IN1_REG = 0x40;            // Input value (GPIO 32-39)
const GPIO_STATUS_REG = 0x44;         // Interrupt status
const GPIO_STATUS_W1TS_REG = 0x48;
const GPIO_STATUS_W1TC_REG = 0x4c;
const GPIO_FUNC_IN_SEL_CFG_BASE = 0x130; // 256 function input selection regs
const GPIO_FUNC_OUT_SEL_CFG_BASE = 0x530; // 40 GPIO output selection regs
const GPIO_PIN_BASE = 0x88;           // Per-pin config (40 pins × 4 bytes)

export class ESP32GPIO implements PeripheralHandler {
  // Callbacks
  onPinChange?: (pin: number, high: boolean) => void;

  // GPIO 0-31
  private outputValue = 0;
  private outputEnable = 0;
  private inputValue = 0;
  private interruptStatus = 0;

  // GPIO 32-39
  private outputValue1 = 0;
  private outputEnable1 = 0;
  private inputValue1 = 0;

  // Per-pin config (40 pins)
  private readonly pinConfig = new Uint32Array(40);

  // Function input/output selection
  private readonly funcInSel = new Uint32Array(256);
  private readonly funcOutSel = new Uint32Array(40);

  // Previous output for change detection
  private prevOutput = 0;
  private prevOutput1 = 0;

  read32(offset: number): number {
    // Per-pin config registers
    if (offset >= GPIO_PIN_BASE && offset < GPIO_PIN_BASE + 40 * 4) {
      return this.pinConfig[(offset - GPIO_PIN_BASE) >> 2];
    }

    // Function input selection
    if (offset >= GPIO_FUNC_IN_SEL_CFG_BASE && offset < GPIO_FUNC_IN_SEL_CFG_BASE + 256 * 4) {
      return this.funcInSel[(offset - GPIO_FUNC_IN_SEL_CFG_BASE) >> 2];
    }

    // Function output selection
    if (offset >= GPIO_FUNC_OUT_SEL_CFG_BASE && offset < GPIO_FUNC_OUT_SEL_CFG_BASE + 40 * 4) {
      return this.funcOutSel[(offset - GPIO_FUNC_OUT_SEL_CFG_BASE) >> 2];
    }

    switch (offset) {
      case GPIO_OUT_REG: return this.outputValue;
      case GPIO_OUT1_REG: return this.outputValue1;
      case GPIO_ENABLE_REG: return this.outputEnable;
      case GPIO_ENABLE1_REG: return this.outputEnable1;
      case GPIO_IN_REG: return (this.inputValue & ~this.outputEnable) | (this.outputValue & this.outputEnable);
      case GPIO_IN1_REG: return (this.inputValue1 & ~this.outputEnable1) | (this.outputValue1 & this.outputEnable1);
      case GPIO_STATUS_REG: return this.interruptStatus;
      case GPIO_STRAP_REG: return 0x13; // Default bootstrap values
      default: return 0;
    }
  }

  write32(offset: number, value: number): void {
    // Per-pin config
    if (offset >= GPIO_PIN_BASE && offset < GPIO_PIN_BASE + 40 * 4) {
      this.pinConfig[(offset - GPIO_PIN_BASE) >> 2] = value;
      return;
    }

    // Function input selection
    if (offset >= GPIO_FUNC_IN_SEL_CFG_BASE && offset < GPIO_FUNC_IN_SEL_CFG_BASE + 256 * 4) {
      this.funcInSel[(offset - GPIO_FUNC_IN_SEL_CFG_BASE) >> 2] = value;
      return;
    }

    // Function output selection
    if (offset >= GPIO_FUNC_OUT_SEL_CFG_BASE && offset < GPIO_FUNC_OUT_SEL_CFG_BASE + 40 * 4) {
      this.funcOutSel[(offset - GPIO_FUNC_OUT_SEL_CFG_BASE) >> 2] = value;
      return;
    }

    switch (offset) {
      case GPIO_OUT_REG:
        this.outputValue = value;
        this.notifyChanges();
        break;
      case GPIO_OUT_W1TS_REG:
        this.outputValue |= value;
        this.notifyChanges();
        break;
      case GPIO_OUT_W1TC_REG:
        this.outputValue &= ~value;
        this.notifyChanges();
        break;
      case GPIO_OUT1_REG:
        this.outputValue1 = value & 0xff;
        this.notifyChanges1();
        break;
      case GPIO_OUT1_W1TS_REG:
        this.outputValue1 |= value & 0xff;
        this.notifyChanges1();
        break;
      case GPIO_OUT1_W1TC_REG:
        this.outputValue1 &= ~(value & 0xff);
        this.notifyChanges1();
        break;
      case GPIO_ENABLE_REG:
        this.outputEnable = value;
        break;
      case GPIO_ENABLE_W1TS_REG:
        this.outputEnable |= value;
        break;
      case GPIO_ENABLE_W1TC_REG:
        this.outputEnable &= ~value;
        break;
      case GPIO_ENABLE1_REG:
        this.outputEnable1 = value & 0xff;
        break;
      case GPIO_ENABLE1_W1TS_REG:
        this.outputEnable1 |= value & 0xff;
        break;
      case GPIO_ENABLE1_W1TC_REG:
        this.outputEnable1 &= ~(value & 0xff);
        break;
      case GPIO_STATUS_W1TC_REG:
        this.interruptStatus &= ~value;
        break;
      case GPIO_STATUS_W1TS_REG:
        this.interruptStatus |= value;
        break;
    }
  }

  // External input: set a pin high or low (for buttons, sensors, etc.)
  setInputPin(pin: number, high: boolean): void {
    if (pin < 32) {
      if (high) this.inputValue |= (1 << pin);
      else this.inputValue &= ~(1 << pin);
    } else if (pin < 40) {
      const bit = pin - 32;
      if (high) this.inputValue1 |= (1 << bit);
      else this.inputValue1 &= ~(1 << bit);
    }
  }

  // Read current output state of a pin
  getOutputPin(pin: number): boolean {
    if (pin < 32) {
      return ((this.outputValue >>> pin) & 1) === 1;
    } else if (pin < 40) {
      return ((this.outputValue1 >>> (pin - 32)) & 1) === 1;
    }
    return false;
  }

  private notifyChanges(): void {
    if (!this.onPinChange) return;
    const changed = this.outputValue ^ this.prevOutput;
    if (changed === 0) return;
    this.prevOutput = this.outputValue;
    for (let pin = 0; pin < 32; pin++) {
      if ((changed >>> pin) & 1) {
        this.onPinChange(pin, ((this.outputValue >>> pin) & 1) === 1);
      }
    }
  }

  private notifyChanges1(): void {
    if (!this.onPinChange) return;
    const changed = this.outputValue1 ^ this.prevOutput1;
    if (changed === 0) return;
    this.prevOutput1 = this.outputValue1;
    for (let bit = 0; bit < 8; bit++) {
      if ((changed >>> bit) & 1) {
        this.onPinChange(32 + bit, ((this.outputValue1 >>> bit) & 1) === 1);
      }
    }
  }
}
