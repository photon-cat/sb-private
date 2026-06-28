# Raspberry Pi Pico (RP2040) Support

SparkBench emulates the RP2040 the same way Wokwi does — on **rp2040js**, the
open-source dual-Cortex-M0+ emulator by Wokwi (the RP2040 counterpart to avr8js).
`lib/rp2040-runner.ts` wraps it the way `AVRRunner` wraps avr8js.

## What's built

- **`RP2040Runner`** (`lib/rp2040-runner.ts`) — loads UF2 (`lib/rp2040/load-flash.ts`,
  a self-contained UF2 parser) or Intel HEX, steps the core, and exposes:
  - `runCycles(n)` / `runMs(ms)` — cycle-bounded headless execution (default 125 MHz, configurable)
  - `gpioState(n)` / `gpioHigh(n)` / `watchGpio(n, cb)` / `setGpioInput(n, v)` — GPIO bridge
  - serial capture from **both** UART0 (`Serial1`) and **USB CDC** (`Serial`, the
    Arduino-Pico default) via `onSerialByte`
  - `feedUart(byte)` — inject UART RX
- **Bootrom** vendored at `lib/rp2040/bootrom.ts` (rp2040js B1 ROM).
- **Board registry** — `wokwi-pi-pico` / `sb-rp2040` registered in
  `MCU_REGISTRY` with a new `rp2040` pin style; `mapRp2040Pin()` maps `GP0..GP29`.
- **Tests** — `lib/__tests__/rp2040-runner.test.ts` runs a real PlatformIO-compiled
  RP2040 UF2 (committed fixture `pico_blink.uf2`): verifies flash load, instruction
  execution, cycle scaling with clock, and the GPIO/serial API.

## Capability assessment (Wokwi's rp2040js)

Verified directly on this machine:
- rp2040js executes real RP2040 machine code **fast** — ~50M simulated cycles in
  ~0.5s wall time, loaded from a UF2 we compiled.
- The dual core, flash/XIP, SIO/GPIO, UART, and USB DPRAM are modeled. Wokwi's
  online examples (Arduino blink, LCD1602, MicroPython REPL) run on this same engine.

**Compatibility finding:** the firmware's Arduino core matters.
- The **earlephilhower arduino-pico** core (what Wokwi targets) is the supported path.
- The **mbed-based** `raspberrypi`/`pico` PlatformIO core spins during clock init
  waiting for the **USB PLL lock**, which this rp2040js build logs as an
  *unimplemented peripheral* (`PLL_USB`). So an mbed-core sketch loads and executes
  but never reaches `loop()`. This is an rp2040js peripheral-coverage gap, not a
  SparkBench bug — confirmed by observing the core stuck in a 2-instruction spin and
  GPIO25 never leaving its reset (unconfigured) state.

## Remaining work (blocked in this sandbox)

To finish the end-to-end Arduino-Pico blink/serial demo:
1. Build firmware with the **earlephilhower** core
   (`platform = https://github.com/maxgerhardt/platform-raspberrypi.git`,
   `board_build.core = earlephilhower`). The core clone (pico-sdk + FreeRTOS
   submodules, hundreds of MB) failed here with `fetch-pack: unexpected disconnect`
   — a network/size limit of this environment, not a code issue.
2. Add the RP2040 build path to `firmware-builder` (board `pico`, earlephilhower core,
   output UF2) and an RP2040 branch in the scenario runner + component wiring
   (GPIO via `mapRp2040Pin` → `runner.gpio[n]`), mirroring the AVR path.
3. A `pico-blink` scenario (`expect-pin`-style on GP25, serial over USB CDC).

Once the core builds, the runner already in place will run it unchanged.
