// RP2040 timing-based component simulators — the rp2040js counterparts of
// servo-sim.ts and encoder-sim.ts. The AVR versions reach into avr8js port
// objects and cpu.cycles; these use RP2040Runner's GPIO watch/drive API and the
// simulation clock (nanos + one-shot alarms) instead.

import { GPIOPinState } from "rp2040js";
import type { RP2040Runner } from "./rp2040-runner";

const MIN_PULSE_US = 544; // Arduino Servo default → 0°
const MAX_PULSE_US = 2400; // Arduino Servo default → 180°

/**
 * Servo simulator. The Arduino Servo library (and arduino-pico's RP2040 PWM
 * backend) produce a ~50 Hz pulse whose HIGH width encodes the angle. We watch
 * the signal pin and measure the HIGH pulse width via the simulation clock.
 */
export class Rp2040ServoSimulator {
  private riseNanos = -1; // -1 = no rising edge seen yet
  private lastAngle = -1;
  private unsub: (() => void) | null = null;

  onAngleChange: ((angle: number) => void) | null = null;

  constructor(
    private readonly runner: RP2040Runner,
    gp: number,
  ) {
    this.unsub = runner.watchGpio(gp, (state) => {
      if (state === GPIOPinState.High) {
        this.riseNanos = runner.nanos;
      } else if (this.riseNanos >= 0) {
        const pulseUs = (runner.nanos - this.riseNanos) / 1000;
        this.riseNanos = -1;
        // Only process plausible servo pulses (400-2600 µs).
        if (pulseUs >= 400 && pulseUs <= 2600) {
          const clamped = Math.max(MIN_PULSE_US, Math.min(MAX_PULSE_US, pulseUs));
          const angle = Math.round(((clamped - MIN_PULSE_US) / (MAX_PULSE_US - MIN_PULSE_US)) * 180);
          if (angle !== this.lastAngle) {
            this.lastAngle = angle;
            this.onAngleChange?.(angle);
          }
        }
      }
    });
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
  }
}

// Nanoseconds between quadrature transitions. Kept small (50 µs) so all four
// transitions of one step complete within the scenario runner's per-step cycle
// budget even at 125 MHz (4 × 50 µs ≈ 25 000 cycles < the 40 000 it advances),
// while still leaving the firmware ample time to sample each edge.
const STEP_NANOS = 50_000;

/**
 * KY-040 rotary encoder simulator. Idles with CLK and DT pulled HIGH and plays
 * out a quadrature sequence on stepCW()/stepCCW(), spacing transitions over the
 * simulation clock so the firmware can sample the intermediate states.
 */
export class Rp2040EncoderSimulator {
  private stepping = false;

  constructor(
    private readonly runner: RP2040Runner,
    private readonly clk: number,
    private readonly dt: number,
    private readonly sw: number | null,
  ) {
    runner.setGpioInput(clk, true);
    runner.setGpioInput(dt, true);
    if (sw != null) runner.setGpioInput(sw, true);
  }

  stepCW(): void {
    this.generateStep(true);
  }

  stepCCW(): void {
    this.generateStep(false);
  }

  pressButton(): void {
    if (this.sw != null) this.runner.setGpioInput(this.sw, false);
  }

  releaseButton(): void {
    if (this.sw != null) this.runner.setGpioInput(this.sw, true);
  }

  private generateStep(clockwise: boolean): void {
    if (this.stepping) return; // ignore overlapping steps
    this.stepping = true;

    // CW:  DT↓, CLK↓, DT↑, CLK↑  (CLK rises while DT HIGH → CW)
    // CCW: CLK↓, DT↓, CLK↑, DT↑  (CLK rises while DT LOW  → CCW)
    const transitions: [number, boolean][] = clockwise
      ? [
          [this.dt, false],
          [this.clk, false],
          [this.dt, true],
          [this.clk, true],
        ]
      : [
          [this.clk, false],
          [this.dt, false],
          [this.clk, true],
          [this.dt, true],
        ];

    let idx = 0;
    const alarm = this.runner.createAlarm(() => {
      if (idx >= transitions.length) {
        this.stepping = false;
        return;
      }
      const [pin, value] = transitions[idx++];
      this.runner.setGpioInput(pin, value);
      alarm.schedule(STEP_NANOS);
    });
    alarm.schedule(STEP_NANOS);
  }

  dispose(): void {
    // Alarms are one-shot and self-terminating; nothing persistent to clean up.
  }
}
