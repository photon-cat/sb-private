import { AVRIOPort, AVRUSART, AVRTWI, AVRADC, AVRSPI, CPU } from "avr8js";

export interface PinInfo {
  port: "portB" | "portC" | "portD";
  pin: number; // 0-7 within port
}

/** Common interface for AVRRunner and AVRDebugRunner — what wiring/sims need. */
export interface AVRRunnerLike {
  readonly cpu: CPU;
  readonly portB: AVRIOPort;
  readonly portC: AVRIOPort;
  readonly portD: AVRIOPort;
  readonly usart: AVRUSART;
  readonly twi: AVRTWI;
  readonly adc: AVRADC;
  readonly spi: AVRSPI;
  readonly speed: number;
  /** Real-time execution loop (the UI driver). Optional: the debug runner steps manually. */
  execute?(callback?: (cpu: CPU) => void): void;
  stop(): void;
  resume?(): void;
}

/**
 * Map Arduino Uno pin names to avr8js port + pin number.
 *
 * Digital: D0-D7 = portD 0-7, D8-D13 = portB 0-5
 * Analog:  A0-A5 = portC 0-5
 */
export function mapArduinoPin(pinName: string): PinInfo | null {
  // Clean up the pin name (remove suffixes like ".1", ".l", ".r")
  const clean = pinName.replace(/\.\d+$/, "").replace(/\.[lr]$/, "");

  // Digital pins: plain numbers or "D" prefix
  const digitalMatch = clean.match(/^D?(\d+)$/);
  if (digitalMatch) {
    const num = parseInt(digitalMatch[1], 10);
    if (num >= 0 && num <= 7) return { port: "portD", pin: num };
    if (num >= 8 && num <= 13) return { port: "portB", pin: num - 8 };
    return null;
  }

  // Analog pins
  const analogMatch = clean.match(/^A(\d+)$/);
  if (analogMatch) {
    const num = parseInt(analogMatch[1], 10);
    if (num >= 0 && num <= 5) return { port: "portC", pin: num };
    return null;
  }

  return null;
}

/**
 * Map ATmega328P port-style pin names to avr8js port + pin number.
 *
 * PD0-PD7 = portD 0-7, PB0-PB7 = portB 0-7, PC0-PC6 = portC 0-6
 */
export function mapAtmega328Pin(pinName: string): PinInfo | null {
  const clean = pinName.replace(/\.\d+$/, "").replace(/\.[lr]$/, "");
  const match = clean.match(/^P([BCD])(\d)$/);
  if (!match) return null;
  const [, portLetter, pinNum] = match;
  const pin = parseInt(pinNum, 10);
  if (portLetter === "D" && pin <= 7) return { port: "portD", pin };
  if (portLetter === "B" && pin <= 7) return { port: "portB", pin };
  if (portLetter === "C" && pin <= 6) return { port: "portC", pin };
  return null;
}

/** Get the AVRIOPort instance from a runner given a port name. */
export function getPort(runner: AVRRunnerLike, portName: PinInfo["port"]): AVRIOPort {
  return runner[portName];
}

/** STM32 GPIO location: port name ("GPIOA"…) + pin index 0-15. */
export interface Stm32PinInfo {
  port: string;
  pin: number;
}

/**
 * Map an STM32 pin name to its GPIO port + pin. Accepts "PA5", "PC13", "PB12"
 * (optionally with .l/.r/.N suffixes). Port letters A–H. Returns null otherwise.
 */
export function mapSTM32Pin(pinName: string): Stm32PinInfo | null {
  const clean = pinName.replace(/\.\d+$/, "").replace(/\.[lr]$/, "");
  const m = clean.match(/^P([A-H])(\d{1,2})$/i);
  if (!m) return null;
  const pin = parseInt(m[2], 10);
  if (pin < 0 || pin > 15) return null;
  return { port: `GPIO${m[1].toUpperCase()}`, pin };
}

/**
 * Map a Raspberry Pi Pico pin name to an RP2040 GPIO index (0-29).
 * Accepts "GP5", "GPIO5", or a bare "5". Power/ground/system pins → null.
 */
export function mapRp2040Pin(pinName: string): number | null {
  const clean = pinName.replace(/\.\d+$/, "").replace(/\.[lr]$/, "");
  const m = clean.match(/^(?:GP|GPIO)?(\d+)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 29 ? n : null;
}

/**
 * Map a Raspberry Pi Pico pin name to an RP2040 ADC channel (0-3), or null if
 * the pin isn't ADC-capable. Channels 0..3 are GPIO 26..29 (ADC0..ADC3).
 * Accepts "GP26"/"GPIO26"/"26"/"A0".."A3" (Arduino-Pico analog aliases).
 */
export function mapRp2040Adc(pinName: string): number | null {
  const clean = pinName.replace(/\.\d+$/, "").replace(/\.[lr]$/, "");
  const a = clean.match(/^A([0-3])$/i);
  if (a) return parseInt(a[1], 10);
  const gp = mapRp2040Pin(clean);
  if (gp != null && gp >= 26 && gp <= 29) return gp - 26;
  return null;
}
