import { describe, it, expect } from "vitest";
import { I2CMode, GPIOPinState, type RPI2C } from "rp2040js";
import type { TWIEventHandler } from "avr8js";
import { Rp2040I2CBridge } from "../rp2040-i2c-bridge";
import { Rp2040ServoSimulator, Rp2040EncoderSimulator } from "../rp2040-sims";
import { mapRp2040Adc } from "../pin-mapping";
import { SSD1306Controller } from "../ssd1306-controller";
import type { RP2040Runner } from "../rp2040-runner";

// ── ADC pin mapping ──────────────────────────────────────────────────────────

describe("mapRp2040Adc", () => {
  it("maps GP26-29 to ADC channels 0-3", () => {
    expect(mapRp2040Adc("GP26")).toBe(0);
    expect(mapRp2040Adc("GP27")).toBe(1);
    expect(mapRp2040Adc("28")).toBe(2);
    expect(mapRp2040Adc("GPIO29")).toBe(3);
  });

  it("accepts Arduino analog aliases A0-A3", () => {
    expect(mapRp2040Adc("A0")).toBe(0);
    expect(mapRp2040Adc("A3")).toBe(3);
  });

  it("returns null for non-ADC pins", () => {
    expect(mapRp2040Adc("GP15")).toBeNull();
    expect(mapRp2040Adc("GP25")).toBeNull();
    expect(mapRp2040Adc("A4")).toBeNull();
    expect(mapRp2040Adc("VCC")).toBeNull();
  });
});

// ── I2C bridge ───────────────────────────────────────────────────────────────

/** A fake RPI2C that records completions and lets tests fire master callbacks. */
function makeFakeI2C() {
  const calls: Array<[string, ...unknown[]]> = [];
  const fake = {
    onStart: (() => {}) as (repeatedStart: boolean) => void,
    onConnect: (() => {}) as (address: number, mode: I2CMode) => void,
    onWriteByte: (() => {}) as (value: number) => void,
    onReadByte: (() => {}) as (ack: boolean) => void,
    onStop: (() => {}) as () => void,
    completeStart: () => calls.push(["completeStart"]),
    completeConnect: (ack: boolean) => calls.push(["completeConnect", ack]),
    completeWrite: (ack: boolean) => calls.push(["completeWrite", ack]),
    completeRead: (v: number) => calls.push(["completeRead", v]),
    completeStop: () => calls.push(["completeStop"]),
  };
  return { fake, calls };
}

/** A recording TWIEventHandler that echoes completions through a supplied bridge. */
function makeRecordingDevice(bridge: Rp2040I2CBridge) {
  const events: Array<[string, ...unknown[]]> = [];
  const device: TWIEventHandler = {
    start: () => events.push(["start"]),
    stop: () => {
      events.push(["stop"]);
      bridge.completeStop();
    },
    connectToSlave: (addr: number, write: boolean) => {
      events.push(["connect", addr, write]);
      bridge.completeConnect(true);
    },
    writeByte: (v: number) => {
      events.push(["write", v]);
      bridge.completeWrite(true);
    },
    readByte: (ack: boolean) => {
      events.push(["read", ack]);
      bridge.completeRead(0x42);
    },
  };
  return { device, events };
}

describe("Rp2040I2CBridge", () => {
  it("routes master traffic to a registered device and forwards completions", () => {
    const { fake, calls } = makeFakeI2C();
    const bridge = new Rp2040I2CBridge(fake as unknown as RPI2C);
    const { device, events } = makeRecordingDevice(bridge);
    bridge.addDevice(0x3c, device);

    fake.onConnect(0x3c, I2CMode.Write);
    fake.onWriteByte(0xab);
    fake.onStop();

    expect(events).toEqual([
      ["connect", 0x3c, true],
      ["write", 0xab],
      ["stop"],
    ]);
    expect(calls).toEqual([
      ["completeConnect", true],
      ["completeWrite", true],
      ["completeStop"],
    ]);
  });

  it("maps I2CMode.Read to a read (write=false) connect", () => {
    const { fake } = makeFakeI2C();
    const bridge = new Rp2040I2CBridge(fake as unknown as RPI2C);
    const { device, events } = makeRecordingDevice(bridge);
    bridge.addDevice(0x68, device);

    fake.onConnect(0x68, I2CMode.Read);
    fake.onReadByte(true);

    expect(events).toEqual([
      ["connect", 0x68, false],
      ["read", true],
    ]);
  });

  it("NACKs an unknown address without touching any device", () => {
    const { fake, calls } = makeFakeI2C();
    const bridge = new Rp2040I2CBridge(fake as unknown as RPI2C);
    const { device, events } = makeRecordingDevice(bridge);
    bridge.addDevice(0x3c, device);

    fake.onConnect(0x50, I2CMode.Write); // not registered
    fake.onWriteByte(0x01); // no active device → bridge NACKs
    fake.onStop();

    expect(events).toEqual([]); // device never engaged
    expect(calls).toEqual([
      ["completeConnect", false],
      ["completeWrite", false],
      ["completeStop"],
    ]);
  });

  it("drives a real SSD1306 controller end-to-end through the bridge", () => {
    const { fake, calls } = makeFakeI2C();
    const bridge = new Rp2040I2CBridge(fake as unknown as RPI2C);
    const oled = new SSD1306Controller(bridge.asTwi(), 0x3c);
    bridge.addDevice(0x3c, oled);

    fake.onStart(false);
    fake.onConnect(0x3c, I2CMode.Write);
    fake.onWriteByte(0x00); // control byte: command stream
    fake.onWriteByte(0xaf); // display ON
    fake.onStop();

    // The real controller acknowledged the matched address and each command.
    expect(calls).toContainEqual(["completeStart"]);
    expect(calls).toContainEqual(["completeConnect", true]);
    expect(calls.filter((c) => c[0] === "completeWrite")).toEqual([
      ["completeWrite", true],
      ["completeWrite", true],
    ]);
    expect(calls).toContainEqual(["completeStop"]);
  });
});

// ── Servo (PWM pulse-width → angle) ──────────────────────────────────────────

/** Minimal RP2040Runner stand-in exposing the GPIO watch + nanos servo needs. */
function makeServoRunner() {
  let listener: ((s: GPIOPinState) => void) | null = null;
  const runner = {
    _nanos: 0,
    get nanos() {
      return this._nanos;
    },
    watchGpio(_pin: number, fn: (s: GPIOPinState) => void) {
      listener = fn;
      return () => {};
    },
    fire(state: GPIOPinState) {
      listener?.(state);
    },
  };
  return runner;
}

describe("Rp2040ServoSimulator", () => {
  it("converts a 1500µs HIGH pulse to ~93°", () => {
    const runner = makeServoRunner();
    const servo = new Rp2040ServoSimulator(runner as unknown as RP2040Runner, 16);
    let angle = -1;
    servo.onAngleChange = (a) => (angle = a);

    runner._nanos = 0;
    runner.fire(GPIOPinState.High);
    runner._nanos = 1_500_000; // 1500 µs later
    runner.fire(GPIOPinState.Low);

    expect(angle).toBe(93);
  });

  it("maps the pulse-width extremes to 0° and 180°", () => {
    const runner = makeServoRunner();
    const servo = new Rp2040ServoSimulator(runner as unknown as RP2040Runner, 16);
    const seen: number[] = [];
    servo.onAngleChange = (a) => seen.push(a);

    runner._nanos = 0;
    runner.fire(GPIOPinState.High);
    runner._nanos = 544_000; // 544 µs → 0°
    runner.fire(GPIOPinState.Low);

    runner._nanos = 2_000_000;
    runner.fire(GPIOPinState.High);
    runner._nanos = 2_000_000 + 2_400_000; // 2400 µs → 180°
    runner.fire(GPIOPinState.Low);

    expect(seen).toEqual([0, 180]);
  });

  it("ignores out-of-range (non-servo) pulses", () => {
    const runner = makeServoRunner();
    const servo = new Rp2040ServoSimulator(runner as unknown as RP2040Runner, 16);
    let called = false;
    servo.onAngleChange = () => (called = true);

    runner._nanos = 0;
    runner.fire(GPIOPinState.High);
    runner._nanos = 5_000_000; // 5 ms — far outside servo range
    runner.fire(GPIOPinState.Low);

    expect(called).toBe(false);
  });
});

// ── Rotary encoder (quadrature) ──────────────────────────────────────────────

/** Stand-in runner recording driven inputs and running a single pending alarm. */
function makeEncoderRunner() {
  const driven: Array<[number, boolean]> = [];
  let pending: (() => void) | null = null;
  const runner = {
    setGpioInput(pin: number, high: boolean) {
      driven.push([pin, high]);
    },
    createAlarm(cb: () => void) {
      return {
        schedule() {
          pending = cb;
        },
        cancel() {
          pending = null;
        },
      };
    },
    flush() {
      let guard = 50;
      while (pending && guard-- > 0) {
        const fn = pending;
        pending = null;
        fn();
      }
    },
  };
  return { runner, driven };
}

describe("Rp2040EncoderSimulator", () => {
  it("idles CLK/DT/SW high and plays a CW quadrature sequence", () => {
    const { runner, driven } = makeEncoderRunner();
    const enc = new Rp2040EncoderSimulator(runner as unknown as RP2040Runner, 10, 11, 12);

    // Constructor drives the three idle-high inputs.
    expect(driven).toEqual([
      [10, true],
      [11, true],
      [12, true],
    ]);

    driven.length = 0;
    enc.stepCW();
    runner.flush();

    // CW: DT↓, CLK↓, DT↑, CLK↑  (dt=11, clk=10)
    expect(driven).toEqual([
      [11, false],
      [10, false],
      [11, true],
      [10, true],
    ]);
  });

  it("plays the reversed sequence for CCW", () => {
    const { runner, driven } = makeEncoderRunner();
    const enc = new Rp2040EncoderSimulator(runner as unknown as RP2040Runner, 10, 11, null);
    driven.length = 0;

    enc.stepCCW();
    runner.flush();

    // CCW: CLK↓, DT↓, CLK↑, DT↑
    expect(driven).toEqual([
      [10, false],
      [11, false],
      [10, true],
      [11, true],
    ]);
  });

  it("drives SW low on press and high on release", () => {
    const { runner, driven } = makeEncoderRunner();
    const enc = new Rp2040EncoderSimulator(runner as unknown as RP2040Runner, 10, 11, 12);
    driven.length = 0;

    enc.pressButton();
    enc.releaseButton();

    expect(driven).toEqual([
      [12, false],
      [12, true],
    ]);
  });
});
