// STM32 ADC — modern G0/F0/L0 layout (ADEN/ADSTART control, ISR/IER flags, a
// single DR result register and a CHSELR channel-select). Models the polling
// flow firmware uses: enable (ADEN), start (ADSTART), poll EOC, read DR. Channel
// sample values are injected from the simulated analog world via setChannel().

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const ISR = 0x00; // ADRDY bit0, EOC bit2
const IER = 0x04; // EOCIE bit2
const CR = 0x08; // ADEN bit0, ADSTART bit2
const CHSELR = 0x28;
const DR = 0x40; // converted data (read)

const ISR_ADRDY = 1 << 0;
const ISR_EOC = 1 << 2;
const IER_EOCIE = 1 << 2;
const CR_ADEN = 1 << 0;
const CR_ADSTART = 1 << 2;

const CHANNEL_COUNT = 19; // G0 ADC: channels 0..18 (incl. Vrefint/temp/Vbat)

export class STM32AdcG0 extends RegisterPeripheral {
  private readonly samples = new Uint16Array(CHANNEL_COUNT);

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
      const ch = this.selectedChannel();
      this.writeReg(ISR, 4, this.readReg(ISR, 4) | ISR_EOC | ISR_ADRDY);
      return this.samples[ch] ?? 0;
    }
    return this.readReg(offset, width);
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === CR) {
      this.writeReg(CR, 4, value);
      if (value & CR_ADEN) {
        this.writeReg(ISR, 4, this.readReg(ISR, 4) | ISR_ADRDY);
      }
      if (value & CR_ADSTART) {
        // A conversion completes immediately in this model: EOC (and ADRDY) set.
        this.writeReg(ISR, 4, this.readReg(ISR, 4) | ISR_EOC | ISR_ADRDY);
        // ADSTART self-clears once the (single) conversion finishes.
        this.writeReg(CR, 4, this.readReg(CR, 4) & ~CR_ADSTART);
      }
      return;
    }
    this.writeReg(offset, width, value);
  }

  /** Lowest-numbered channel selected in CHSELR, else 0. */
  private selectedChannel(): number {
    const sel = this.readReg(CHSELR, 4);
    if (sel === 0) return 0;
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      if ((sel >>> ch) & 1) return ch;
    }
    return 0;
  }

  pendingIRQ(): number | null {
    if (this.irq == null) return null;
    const eoc = this.readReg(ISR, 4) & ISR_EOC;
    const eocie = this.readReg(IER, 4) & IER_EOCIE;
    return eoc && eocie ? this.irq : null;
  }

  reset(): void {
    super.reset();
    this.samples.fill(0);
  }
}
