// Maps a compiled board to the in-browser simulation core that can run it.
//
// The build server compiles for many boards; the browser then needs to pick the
// right pure-JS engine. Three exist today:
//   • avr8js       — ATmega (AVRRunner)
//   • cortex-m0    — ARMv6-M STM32 C0/G0/L0 (CortexM0Host, rp2040js core borrow)
//   • unicorn-arm  — ARMv7-M Thumb-2: STM32 F1/F4/F7/H7/G4 (UnicornArmHost, unicorn.js)
//   • rp2040       — Raspberry Pi Pico / RP2040 (RP2040Runner, full rp2040js chip)
//
// Boards with no in-browser core yet (ESP32) return null → compile-only.

export type SimCore = "avr8js" | "cortex-m0" | "unicorn-arm" | "rp2040";

const AVR_BOARDS = new Set([
  "uno", "nano", "mega", "atmega328p", "leonardo", "micro", "pro", "promini",
]);

/** RP2040 board id fragments → the full rp2040js RP2040Runner (not the STM32 M0 host). */
const RP2040_FRAGMENTS = ["pico", "rp2040"];

/** ARMv7-M STM32 board id fragments → need the Thumb-2 (unicorn.js) core. */
const ARMV7M_FRAGMENTS = ["f103", "f4", "f7", "h7", "g4", "blackpill", "bluepill"];

/** ARMv6-M STM32 board id fragments → run on the Cortex-M0+ core (CortexM0Host). */
const ARMV6M_FRAGMENTS = ["g0", "c0", "l0"];

/**
 * Pick the in-browser simulation core for a PlatformIO board id, or null if none
 * can run it yet (e.g. ESP32). Case-insensitive substring match for STM32 since
 * board ids vary (e.g. "genericSTM32F103C8", "bluepill_f103c8").
 */
export function pickSimCore(board: string): SimCore | null {
  const b = board.toLowerCase();
  if (AVR_BOARDS.has(b)) return "avr8js";
  if (RP2040_FRAGMENTS.some((f) => b.includes(f))) return "rp2040";
  if (ARMV7M_FRAGMENTS.some((f) => b.includes(f))) return "unicorn-arm";
  if (ARMV6M_FRAGMENTS.some((f) => b.includes(f))) return "cortex-m0";
  return null;
}
