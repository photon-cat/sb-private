// Peripheral model interface for the SVD-driven MCU framework.
//
// Each peripheral models one memory-mapped IP block (USART, TIMx, GPIO, RCC, …).
// Instances are placed at addresses taken from the device's CMSIS-SVD, so the
// same model is reused across every MCU that embeds that IP block.

export type AccessWidth = 1 | 2 | 4;

export interface Peripheral {
  /** Instance name from the SVD, e.g. "USART1", "GPIOA". */
  readonly name: string;
  /** Base address of this instance's register block. */
  readonly base: number;
  /** Size of the register window in bytes (default 0x400). */
  readonly size: number;
  /** Read `width` bytes at `offset` (relative to base). */
  read(offset: number, width: AccessWidth): number;
  /** Write `width` bytes at `offset` (relative to base). */
  write(offset: number, width: AccessWidth, value: number): void;
  /** Advance peripheral time by `cycles` system clocks (timers, baud, etc.). */
  tick?(cycles: number): void;
  /** Reset to power-on state. */
  reset?(): void;
  /**
   * Pending interrupt request: return the device's IRQ number when this
   * peripheral is asserting an interrupt the NVIC should latch, else null.
   */
  pendingIRQ?(): number | null;
}

/** Base class with a backing register array and width-aware access helpers. */
export abstract class RegisterPeripheral implements Peripheral {
  readonly size: number;
  protected readonly regs: Uint8Array;

  constructor(
    readonly name: string,
    readonly base: number,
    size = 0x400,
  ) {
    this.size = size;
    this.regs = new Uint8Array(size);
  }

  /** Default register-array read; override `read` for side-effecting registers. */
  read(offset: number, width: AccessWidth): number {
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    this.writeReg(offset, width, value);
  }

  protected readReg(offset: number, width: AccessWidth): number {
    let v = 0;
    for (let i = 0; i < width; i++) v |= this.regs[offset + i] << (8 * i);
    return v >>> 0;
  }

  protected writeReg(offset: number, width: AccessWidth, value: number): void {
    for (let i = 0; i < width; i++) this.regs[offset + i] = (value >>> (8 * i)) & 0xff;
  }

  reset(): void {
    this.regs.fill(0);
  }
}
