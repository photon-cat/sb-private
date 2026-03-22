// ESP32 Timer Group Peripheral
// TIMG0 base: 0x3FF5F000, TIMG1 base: 0x3FF60000
import type { PeripheralHandler } from "../memory/memory-bus.js";

// Timer register offsets (per timer within group)
const TIMG_T0CONFIG_REG = 0x00;
const TIMG_T0LO_REG = 0x04;
const TIMG_T0HI_REG = 0x08;
const TIMG_T0UPDATE_REG = 0x0c;
const TIMG_T0ALARMLO_REG = 0x10;
const TIMG_T0ALARMHI_REG = 0x14;
const TIMG_T0LOADLO_REG = 0x18;
const TIMG_T0LOADHI_REG = 0x1c;
const TIMG_T0LOAD_REG = 0x20;

// Timer 1 starts at offset 0x24
const TIMG_T1_OFFSET = 0x24;

// Watchdog timer
const TIMG_WDTCONFIG0_REG = 0x48;
const TIMG_WDTCONFIG1_REG = 0x4c;
const TIMG_WDTFEED_REG = 0x60;
const TIMG_WDTWPROTECT_REG = 0x64;

// RTC calibration registers
const TIMG_RTCCALICFG_REG = 0x68;
const TIMG_RTCCALICFG1_REG = 0x6c;

// Config bits
const TIMG_T_EN = 1 << 31;
const TIMG_T_INCREASE = 1 << 30;
const TIMG_T_AUTORELOAD = 1 << 29;
const TIMG_T_ALARM_EN = 1 << 10;

interface TimerState {
  config: number;
  counterLo: number;
  counterHi: number;
  alarmLo: number;
  alarmHi: number;
  loadLo: number;
  loadHi: number;
  // Latched values (written on UPDATE)
  latchLo: number;
  latchHi: number;
}

export class ESP32TimerGroup implements PeripheralHandler {
  private timers: [TimerState, TimerState];
  private wdtConfig0 = 0;
  private wdtConfig1 = 0;
  private wdtProtect = 0x50d83aa1; // Default locked

  // RTC calibration state
  private rtcCalCfg = 0;        // TIMG_RTCCALICFG_REG
  private rtcCalResult = 0;     // TIMG_RTCCALICFG1_REG

  // CPU cycles per tick (for clock divider)
  private cpuSpeed: number;

  onAlarm?: (timer: number) => void;

  constructor(cpuSpeed: number = 240e6) {
    this.cpuSpeed = cpuSpeed;
    this.timers = [
      this.makeTimer(),
      this.makeTimer(),
    ];
  }

  private makeTimer(): TimerState {
    return {
      config: TIMG_T_EN | TIMG_T_INCREASE | (1 << 13), // divider=2 default
      counterLo: 0, counterHi: 0,
      alarmLo: 0, alarmHi: 0,
      loadLo: 0, loadHi: 0,
      latchLo: 0, latchHi: 0,
    };
  }

  // Call this periodically to advance timers based on CPU cycles
  tick(cpuCycles: number): void {
    for (let i = 0; i < 2; i++) {
      const t = this.timers[i];
      if (!(t.config & TIMG_T_EN)) continue;

      // Get divider from config bits 28:13
      const divider = ((t.config >> 13) & 0xffff) || 1;
      const ticks = Math.floor(cpuCycles / divider);

      if (t.config & TIMG_T_INCREASE) {
        // Count up
        const low = t.counterLo >>> 0;
        const newLow = low + ticks;
        t.counterLo = newLow | 0;
        if (newLow > 0xffffffff) {
          t.counterHi = (t.counterHi + Math.floor(newLow / 0x100000000)) | 0;
        }
      }

      // Check alarm
      if (t.config & TIMG_T_ALARM_EN) {
        if (t.counterHi >= t.alarmHi && (t.counterLo >>> 0) >= (t.alarmLo >>> 0)) {
          if (this.onAlarm) this.onAlarm(i);
          if (t.config & TIMG_T_AUTORELOAD) {
            t.counterLo = t.loadLo;
            t.counterHi = t.loadHi;
          }
          t.config &= ~TIMG_T_ALARM_EN; // Clear alarm after trigger
        }
      }
    }
  }

  read32(offset: number): number {
    // Timer 0
    if (offset <= 0x20) return this.readTimer(0, offset);
    // Timer 1
    if (offset >= TIMG_T1_OFFSET && offset <= TIMG_T1_OFFSET + 0x20) {
      return this.readTimer(1, offset - TIMG_T1_OFFSET);
    }

    switch (offset) {
      case TIMG_WDTCONFIG0_REG: return this.wdtConfig0;
      case TIMG_WDTCONFIG1_REG: return this.wdtConfig1;
      case TIMG_WDTWPROTECT_REG: return this.wdtProtect;
      case TIMG_RTCCALICFG_REG:
        // Return with RDY bit (bit 15) set = calibration done
        return this.rtcCalCfg | (1 << 15);
      case TIMG_RTCCALICFG1_REG:
        return this.rtcCalResult;
      default: return 0;
    }
  }

  write32(offset: number, value: number): void {
    if (offset <= 0x20) { this.writeTimer(0, offset, value); return; }
    if (offset >= TIMG_T1_OFFSET && offset <= TIMG_T1_OFFSET + 0x20) {
      this.writeTimer(1, offset - TIMG_T1_OFFSET, value);
      return;
    }

    switch (offset) {
      case TIMG_WDTCONFIG0_REG:
        if (this.wdtProtect === 0) this.wdtConfig0 = value;
        break;
      case TIMG_WDTCONFIG1_REG:
        if (this.wdtProtect === 0) this.wdtConfig1 = value;
        break;
      case TIMG_WDTFEED_REG:
        // Feed (reset) watchdog — no-op in emulator
        break;
      case TIMG_WDTWPROTECT_REG:
        this.wdtProtect = value;
        break;
      case TIMG_RTCCALICFG_REG: {
        this.rtcCalCfg = value;
        // When START bit (bit 31) is set, compute calibration result
        if (value & (1 << 31)) {
          // Extract slowclk_cycles from bits 16:30 (15 bits)
          const slowclkCycles = (value >> 16) & 0x7fff;
          // RTC slow clock ~150kHz, XTAL 40MHz → ratio ≈ 266.67
          // Result = slowclk_cycles * (XTAL_freq / RTC_slow_freq)
          const ratio = 40e6 / 150e3; // ≈ 266.67
          // Result stored in bits 7:31 of RTCCALICFG1 (shifted left by 7)
          this.rtcCalResult = Math.round(slowclkCycles * ratio) << 7;
        }
        break;
      }
      case TIMG_RTCCALICFG1_REG:
        break;
    }
  }

  private readTimer(idx: number, offset: number): number {
    const t = this.timers[idx];
    switch (offset) {
      case TIMG_T0CONFIG_REG: return t.config;
      case TIMG_T0LO_REG: return t.latchLo;
      case TIMG_T0HI_REG: return t.latchHi;
      case TIMG_T0ALARMLO_REG: return t.alarmLo;
      case TIMG_T0ALARMHI_REG: return t.alarmHi;
      case TIMG_T0LOADLO_REG: return t.loadLo;
      case TIMG_T0LOADHI_REG: return t.loadHi;
      default: return 0;
    }
  }

  private writeTimer(idx: number, offset: number, value: number): void {
    const t = this.timers[idx];
    switch (offset) {
      case TIMG_T0CONFIG_REG: t.config = value; break;
      case TIMG_T0UPDATE_REG:
        // Latch current counter value for reading
        t.latchLo = t.counterLo;
        t.latchHi = t.counterHi;
        break;
      case TIMG_T0ALARMLO_REG: t.alarmLo = value; break;
      case TIMG_T0ALARMHI_REG: t.alarmHi = value; break;
      case TIMG_T0LOADLO_REG: t.loadLo = value; break;
      case TIMG_T0LOADHI_REG: t.loadHi = value; break;
      case TIMG_T0LOAD_REG:
        // Load counter from load registers
        t.counterLo = t.loadLo;
        t.counterHi = t.loadHi;
        break;
    }
  }
}
