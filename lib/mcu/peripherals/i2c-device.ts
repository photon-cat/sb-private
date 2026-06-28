// I2C slave-device interface + a couple of stock devices, so firmware driving
// the STM32 I2C master actually gets responses (an unmodeled bus just NACKs).
//
// The protocol is byte-level: the master starts a write or read transfer to a
// 7-bit address; the device sees each byte and supplies bytes back. The common
// register-file pattern (write a register pointer, then read/write data) covers
// most sensors, displays, and EEPROMs.

export interface I2CDevice {
  /** 7-bit bus address. */
  readonly address: number;
  /** Master begins a write transfer to this device. */
  startWrite(): void;
  /** Master begins a read transfer from this device. */
  startRead(): void;
  /** Master sends one byte to the device. */
  writeByte(byte: number): void;
  /** Device returns the next byte to the master. */
  readByte(): number;
  /** Transfer terminated (STOP). */
  stop(): void;
}

/**
 * Register-file device: first written byte is the register pointer, subsequent
 * writes fill registers (auto-incrementing), reads return registers from the
 * pointer (auto-incrementing). Models the vast majority of I2C sensors.
 */
export class I2CRegisterDevice implements I2CDevice {
  protected readonly regs: Uint8Array;
  private ptr = 0;
  private expectPointer = true;

  constructor(
    readonly address: number,
    regCount = 256,
  ) {
    this.regs = new Uint8Array(regCount);
  }

  startWrite(): void {
    this.expectPointer = true;
  }

  startRead(): void {
    // Repeated-start read continues from the current pointer.
    this.expectPointer = false;
  }

  writeByte(byte: number): void {
    if (this.expectPointer) {
      this.ptr = byte % this.regs.length;
      this.expectPointer = false;
    } else {
      this.regs[this.ptr] = byte & 0xff;
      this.ptr = (this.ptr + 1) % this.regs.length;
    }
  }

  readByte(): number {
    const v = this.regs[this.ptr];
    this.ptr = (this.ptr + 1) % this.regs.length;
    return v;
  }

  stop(): void {
    this.expectPointer = true;
  }

  /** Seed a register value (sensor identity, measurement, etc.). */
  setReg(addr: number, value: number): void {
    this.regs[addr % this.regs.length] = value & 0xff;
  }
}

/** MPU6050 IMU: the WHO_AM_I register (0x75) reads 0x68 — the canonical probe. */
export class MPU6050 extends I2CRegisterDevice {
  constructor(address = 0x68) {
    super(address);
    this.setReg(0x75, 0x68); // WHO_AM_I
  }
}
