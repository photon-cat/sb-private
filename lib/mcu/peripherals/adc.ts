// STM32 ADC — F1 flavor (ADCv1: SR/CR1/CR2 control, SQRx sequence, single DR).
// Distinct from the modern G0 ADC (ADEN/ADSTART/CHSELR/ISR). Models the polling
// flow HAL drives: power on (ADON), trigger a regular conversion (a second ADON
// write or SWSTART), poll EOC, read DR. Channel sample values are injected from
// the simulated analog world via setChannel().

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const SR = 0x00; // EOC bit1, STRT bit4
const CR1 = 0x04; // EOCIE bit5
const CR2 = 0x08; // ADON bit0, SWSTART bit22
const SQR3 = 0x34; // SQ1 bits 4:0 (first conversion in the regular sequence)
const DR = 0x4c; // converted data (read clears EOC)

const SR_EOC = 1 << 1;
const SR_STRT = 1 << 4;
const CR1_EOCIE = 1 << 5;
const CR2_ADON = 1 << 0;
const CR2_SWSTART = 1 << 22;

const CHANNEL_COUNT = 18; // ADC1 channels 0..17 (16=temp, 17=Vrefint)

export class STM32AdcF1 extends RegisterPeripheral {
  private readonly samples = new Uint16Array(CHANNEL_COUNT);
  /** True once ADON has powered the converter (first ADON write). */
  private powered = false;

  constructor(
    name: string,
    base: number,
    size: number,
    private readonly irq: number | null = null,
  ) {
    super(name, base, size);
  }

  /** Inject a 12-bit (0..4095) sample for a channel from the analog world. */
  setChannel(ch: number, value12bit: number): void {
    if (ch < 0 || ch >= CHANNEL_COUNT) return;
    this.samples[ch] = Math.max(0, Math.min(0xfff, value12bit | 0));
  }

  read(offset: number, width: AccessWidth): number {
    if (offset === DR) {
      // Reading the data register returns the latest sample and clears EOC.
      const v = this.samples[this.selectedChannel()] ?? 0;
      this.writeReg(SR, 4, this.readReg(SR, 4) & ~SR_EOC);
      return v;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === CR2) {
      const v = value >>> 0;
      // First ADON only wakes the converter; a second ADON (or SWSTART) starts
      // a regular conversion. This model completes it immediately.
      const startedByAdon = (v & CR2_ADON) !== 0 && this.powered;
      if (v & CR2_ADON) this.powered = true;
      const started = startedByAdon || (v & CR2_SWSTART) !== 0;
      // SWSTART self-clears once the conversion starts.
      this.writeReg(CR2, 4, v & ~CR2_SWSTART);
      if (started) this.writeReg(SR, 4, this.readReg(SR, 4) | SR_EOC | SR_STRT);
      return;
    }
    this.writeReg(offset, width, value);
  }

  /** First channel in the regular sequence (SQR3 SQ1). */
  private selectedChannel(): number {
    return this.readReg(SQR3, 4) & 0x1f;
  }

  pendingIRQ(): number | null {
    if (this.irq == null) return null;
    const eoc = this.readReg(SR, 4) & SR_EOC;
    const eocie = this.readReg(CR1, 4) & CR1_EOCIE;
    return eoc && eocie ? this.irq : null;
  }

  reset(): void {
    super.reset();
    this.samples.fill(0);
    this.powered = false;
  }
}
