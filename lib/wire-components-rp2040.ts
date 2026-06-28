// RP2040 component wiring — the rp2040js counterpart of wire-components.ts and
// wire-components-stm32.ts.
//
// RP2040Runner exposes a flat GPIO API (gpioHigh / setGpioInput / watchGpio)
// keyed by pin number (GP0..GP29), plus ADC (setAdcChannel), I2C (ensureI2CBridge)
// and SPI (attachSpiHandler). This produces the SAME WiredComponent map the UI
// and the scenario runner bind to, so the render/event/assert layers are
// identical across AVR, STM32 and RP2040.
//
// Covered: LED, buzzer, pushbutton (GPIO); potentiometer/slide-pot (ADC); servo
// (PWM pulse width); SSD1306, LCD1602/2004, MPU6050, BMP180 (I2C); ILI9341 (SPI);
// KY-040 rotary encoder. Reuses the avr8js device controllers unchanged via the
// I2C bridge. Other parts fall through as un-driven (still rendered).

import { GPIOPinState } from "rp2040js";
import type { RP2040Runner } from "./rp2040-runner";
import {
  type Diagram,
  findComponentPins,
  findMCUs,
} from "./diagram-parser";
import { mapRp2040Pin, mapRp2040Adc } from "./pin-mapping";
import { findPartConnections, type WiredComponent, type WireResult } from "./wire-components";
import { Rp2040ServoSimulator, Rp2040EncoderSimulator } from "./rp2040-sims";
import { SSD1306Controller } from "./ssd1306-controller";
import { LCD1602Controller } from "./lcd1602-controller";
import { MPU6050Controller } from "./mpu6050-sim";
import { BMP180Controller } from "./bmp180-sim";
import { ILI9341Controller } from "./ili9341-controller";

/**
 * Wire diagram components to an RP2040 runner. Returns the same shape as
 * wireComponents(); i2cBus is omitted (RP2040 I2C devices attach via the runner's
 * own bridge, not the AVR I2CBus path).
 */
export function wireComponentsRp2040(
  runner: RP2040Runner,
  diagram: Diagram,
  mcuId?: string,
): Pick<WireResult, "wired"> {
  let resolvedMcuId = mcuId;
  if (!resolvedMcuId) {
    const target = findMCUs(diagram).find((m) => m.simulatable) ?? findMCUs(diagram)[0];
    resolvedMcuId = target?.id;
  }

  const pinMap = findComponentPins(diagram, resolvedMcuId);
  const wired = new Map<string, WiredComponent>();

  // --- Pin-attached parts (GPIO / ADC / PWM) ---
  for (const part of diagram.parts) {
    const mcuPin = pinMap.get(part.id);
    const gp = mcuPin != null ? mapRp2040Pin(mcuPin) : null;
    const wc: WiredComponent = { part };

    if (part.type === "wokwi-led" || part.type === "wokwi-buzzer") {
      if (gp == null) {
        wired.set(part.id, wc);
        continue;
      }
      const emit = (high: boolean) => wc.onStateChange?.(high);
      emit(runner.gpioHigh(gp));
      runner.watchGpio(gp, (state) => emit(state === GPIOPinState.High));
    } else if (part.type === "wokwi-pushbutton") {
      if (gp == null) {
        wired.set(part.id, wc);
        continue;
      }
      // INPUT_PULLUP: idle HIGH, pressed pulls LOW.
      runner.setGpioInput(gp, true);
      wc.setPressed = (pressed: boolean) => runner.setGpioInput(gp, !pressed);
    } else if (part.type === "wokwi-servo") {
      if (gp == null) {
        wired.set(part.id, wc);
        continue;
      }
      const servo = new Rp2040ServoSimulator(runner, gp);
      servo.onAngleChange = (angle) => wc.onAngleChange?.(angle);
      wc.cleanup = () => servo.dispose();
    } else if (
      part.type === "wokwi-potentiometer" ||
      part.type === "wokwi-slide-potentiometer"
    ) {
      const channel = mcuPin != null ? mapRp2040Adc(mcuPin) : null;
      if (channel == null) {
        wired.set(part.id, wc);
        continue;
      }
      const initial = parseInt(part.attrs.value || "0", 10);
      const toRaw = (v: number) => Math.round((Math.max(0, Math.min(1023, v)) / 1023) * 4095);
      runner.setAdcChannel(channel, toRaw(initial));
      wc.setValue = (value: number) => runner.setAdcChannel(channel, toRaw(value));
    }

    wired.set(part.id, wc);
  }

  // --- I2C devices (reuse the avr8js TWIEventHandler controllers via the bridge) ---
  wireI2CDevices(runner, diagram, resolvedMcuId, wired);

  // --- SPI TFT (ILI9341) ---
  wireILI9341(runner, diagram, resolvedMcuId, wired);

  // --- Rotary encoders ---
  wireEncoders(runner, diagram, resolvedMcuId, wired);

  return { wired };
}

/**
 * Resolve which RP2040 peripheral instance (0/1) a device's named pin selects,
 * from the GP pin it connects to. The pin mux interleaves the two instances in
 * fixed-size GP groups: I2C alternates every 2 pins (I2C0 GP0/1/4/5…, I2C1
 * GP2/3/6/7…) and SPI every 8 pins (SPI0 GP2/6/18/22, SPI1 GP10/14/26). So the
 * instance is floor(gp / groupSize) % 2. Falls back to bus 0.
 */
function resolveBus(
  diagram: Diagram,
  partId: string,
  mcuId: string | undefined,
  pinNames: string[],
  groupSize: 2 | 8,
): number {
  const conns = findPartConnections(diagram, partId);
  for (const pinName of pinNames) {
    for (const ref of conns.get(pinName) ?? []) {
      const [refPart, refPin] = ref.split(":");
      if (refPart !== mcuId) continue;
      const gp = mapRp2040Pin(refPin);
      if (gp != null) return Math.floor(gp / groupSize) % 2;
    }
  }
  return 0;
}

function wireI2CDevices(
  runner: RP2040Runner,
  diagram: Diagram,
  mcuId: string | undefined,
  wired: Map<string, WiredComponent>,
) {
  for (const part of diagram.parts) {
    const bus = resolveBus(diagram, part.id, mcuId, ["SDA", "SDA.1"], 2);

    if (part.type === "wokwi-ssd1306") {
      const bridge = runner.ensureI2CBridge(bus);
      const addr = parseInt(part.attrs.address || "0x3c", 16);
      const controller = new SSD1306Controller(bridge.asTwi(), addr);
      bridge.addDevice(addr, controller);
      wired.set(part.id, { part, ssd1306: controller, cleanup: () => controller.dispose() });
    } else if (part.type === "wokwi-lcd1602" || part.type === "wokwi-lcd2004") {
      const bridge = runner.ensureI2CBridge(bus);
      const addr = parseInt(part.attrs.address || "0x27", 16);
      const controller = new LCD1602Controller(bridge.asTwi(), addr);
      bridge.addDevice(addr, controller);
      wired.set(part.id, { part, lcd1602: controller, cleanup: () => controller.dispose() });
    } else if (part.type === "wokwi-mpu6050") {
      const bridge = runner.ensureI2CBridge(bus);
      const addr = 0x68;
      const controller = new MPU6050Controller(bridge.asTwi());
      bridge.addDevice(addr, controller);
      wired.set(part.id, {
        part,
        setAccel: (x, y, z) => controller.setAccel(x, y, z),
        setGyro: (x, y, z) => controller.setGyro(x, y, z),
      });
    } else if (part.type === "wokwi-bmp180") {
      const bridge = runner.ensureI2CBridge(bus);
      const addr = parseInt(part.attrs.address || "0x77", 16);
      const controller = new BMP180Controller(bridge.asTwi(), addr);
      bridge.addDevice(addr, controller);
      controller.setTemperature(parseFloat(part.attrs.temperature || "24"));
      controller.setPressure(parseFloat(part.attrs.pressure || "101325"));
      wired.set(part.id, {
        part,
        setTemperature: (c: number) => controller.setTemperature(c),
        setPressure: (p: number) => controller.setPressure(p),
      });
    }
  }
}

/**
 * Wire wokwi-ili9341 SPI TFT displays. The RP2040 is SPI master; the controller
 * decodes the byte stream gated by CS (active low) and classified by DC
 * (command when low). Write-only, so the handler returns 0 for MISO.
 */
function wireILI9341(
  runner: RP2040Runner,
  diagram: Diagram,
  mcuId: string | undefined,
  wired: Map<string, WiredComponent>,
) {
  for (const part of diagram.parts) {
    if (part.type !== "wokwi-ili9341") continue;

    const conns = findPartConnections(diagram, part.id);
    const resolveGp = (...pinNames: string[]): number | null => {
      for (const pinName of pinNames) {
        for (const ref of conns.get(pinName) ?? []) {
          const [refPart, refPin] = ref.split(":");
          if (refPart === mcuId) {
            const gp = mapRp2040Pin(refPin);
            if (gp != null) return gp;
          }
        }
      }
      return null;
    };

    const dcPin = resolveGp("DC", "D/C", "DC.1");
    if (dcPin == null) continue; // DC is required to classify command vs data
    const csPin = resolveGp("CS");
    const bus = resolveBus(diagram, part.id, mcuId, ["SCK", "SCL"], 8);

    const width = parseInt(part.attrs.width || "240", 10);
    const height = parseInt(part.attrs.height || "320", 10);
    const controller = new ILI9341Controller(width, height);

    runner.attachSpiHandler((mosi) => {
      const selected = csPin == null ? true : !runner.gpioHigh(csPin); // CS active low
      if (!selected) return 0;
      const isCommand = !runner.gpioHigh(dcPin); // DC low = command
      controller.processByte(mosi, isCommand);
      return 0;
    }, bus);

    const wc = wired.get(part.id) ?? { part };
    wc.ili9341 = controller;
    wired.set(part.id, wc);
  }
}

function wireEncoders(
  runner: RP2040Runner,
  diagram: Diagram,
  mcuId: string | undefined,
  wired: Map<string, WiredComponent>,
) {
  for (const part of diagram.parts) {
    if (part.type !== "wokwi-ky-040") continue;

    const conns = findPartConnections(diagram, part.id);
    const resolveGp = (pinName: string): number | null => {
      for (const ref of conns.get(pinName) ?? []) {
        const [refPart, refPin] = ref.split(":");
        if (refPart === mcuId) {
          const gp = mapRp2040Pin(refPin);
          if (gp != null) return gp;
        }
      }
      return null;
    };

    const clk = resolveGp("CLK");
    const dt = resolveGp("DT");
    if (clk == null || dt == null) continue;
    const sw = resolveGp("SW");

    const encoder = new Rp2040EncoderSimulator(runner, clk, dt, sw);
    wired.set(part.id, {
      part,
      stepCW: () => encoder.stepCW(),
      stepCCW: () => encoder.stepCCW(),
      pressEncoderButton: () => encoder.pressButton(),
      releaseEncoderButton: () => encoder.releaseButton(),
      cleanup: () => encoder.dispose(),
    });
  }
}
