// STM32 general-purpose timer (TIMx) — modern G0/F0/F3/F7/L4/G4 layout.
//
// Models the counting / update-event behavior firmware relies on: when CEN is
// set, the prescaler divides the system clock and CNT counts up to ARR, wrapping
// and setting the UIF update flag (and asserting the update IRQ when UIE is set).
// Also exposes a PWM duty helper (CCRx/(ARR+1)) for channels enabled in CCER, so
// LED-fade / servo firmware can be observed without modeling the full output path.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const CR1 = 0x00; // CEN bit0
const DIER = 0x0c; // UIE bit0
const SR = 0x10; // UIF bit0
const CCER = 0x20; // CCxE enable: ch1 bit0, ch2 bit4, ch3 bit8, ch4 bit12
const CNT = 0x24;
const PSC = 0x28;
const ARR = 0x2c;
const CCR1 = 0x34;
const CCR2 = 0x38;
const CCR3 = 0x3c;
const CCR4 = 0x40;

const CR1_CEN = 1 << 0;
const DIER_UIE = 1 << 0;
const SR_UIF = 1 << 0;

const CCR_OFFSET: Record<1 | 2 | 3 | 4, number> = {
  1: CCR1,
  2: CCR2,
  3: CCR3,
  4: CCR4,
};
const CCER_ENABLE_SHIFT: Record<1 | 2 | 3 | 4, number> = {
  1: 0,
  2: 4,
  3: 8,
  4: 12,
};

export class STM32TimG0 extends RegisterPeripheral {
  /** Prescaler remainder carried between ticks (fractional clocks). */
  private psFrac = 0;

  constructor(
    name: string,
    base: number,
    size: number,
    private readonly irq: number | null = null,
  ) {
    super(name, base, size);
  }

  tick(cycles: number): void {
    if ((this.readReg(CR1, 4) & CR1_CEN) === 0) return;
    const div = (this.readReg(PSC, 4) & 0xffff) + 1;
    const arr = this.readReg(ARR, 4) & 0xffff;
    const pool = this.psFrac + cycles;
    const ticks = Math.floor(pool / div);
    this.psFrac = pool - ticks * div;
    if (ticks === 0) return;

    let cnt = this.readReg(CNT, 4) & 0xffff;
    const span = arr + 1; // ARR is inclusive; CNT wraps after reaching ARR
    let wrapped = false;
    for (let i = 0; i < ticks; i++) {
      cnt++;
      if (cnt > arr) {
        cnt = 0;
        wrapped = true;
      }
    }
    // span==0 (ARR=0) means every tick is an update event.
    if (span <= 1 && ticks > 0) wrapped = true;
    this.writeReg(CNT, 4, cnt & 0xffff);
    if (wrapped) this.writeReg(SR, 4, this.readReg(SR, 4) | SR_UIF);
  }

  /** Current counter value (CNT). */
  counter(): number {
    return this.readReg(CNT, 4) & 0xffff;
  }

  /**
   * PWM duty for a channel as CCRx/(ARR+1), clamped to 0..1, or 0 when that
   * channel's output is not enabled in CCER.
   */
  pwmDuty(channel: 1 | 2 | 3 | 4): number {
    const ccer = this.readReg(CCER, 4);
    const enabled = (ccer >>> CCER_ENABLE_SHIFT[channel]) & 1;
    if (!enabled) return 0;
    const arr = this.readReg(ARR, 4) & 0xffff;
    const period = arr + 1;
    if (period <= 0) return 0;
    const ccr = this.readReg(CCR_OFFSET[channel], 4) & 0xffff;
    const duty = ccr / period;
    if (duty <= 0) return 0;
    if (duty >= 1) return 1;
    return duty;
  }

  pendingIRQ(): number | null {
    if (this.irq == null) return null;
    const uif = this.readReg(SR, 4) & SR_UIF;
    const uie = this.readReg(DIER, 4) & DIER_UIE;
    return uif && uie ? this.irq : null;
  }

  reset(): void {
    super.reset();
    this.psFrac = 0;
  }
}
