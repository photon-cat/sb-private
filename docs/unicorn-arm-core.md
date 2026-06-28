# In-browser ARMv7-M core (Phase 4b) — unicorn.js

Phase 4 delivered the **native QEMU** backend for STM32 M3–M7 (a desktop/CI engine
and ARM oracle). Phase 4b delivers the piece that was deferred: an **in-browser**
ARMv7-M core that runs full Thumb-2 with **no native process** — so STM32 F1/F4/
F7/H7/G4 firmware can simulate in the browser the same way AVR/RP2040/STM32-M0 do.

## What it is

The vendored engine is [**unicorn.js**](https://github.com/AlexAltea/unicorn.js):
the Unicorn Engine ARM CPU (QEMU-derived TCG) cross-compiled to **asm.js**. It is
self-contained pure JavaScript — no `.wasm`/`.mem` sidecar, no Emscripten needed at
runtime — so it loads in Node *and* the browser. `uc.version()` reports `256`
(Unicorn v1.0).

- Vendored bundle: `vendor/unicorn-arm/unicorn-arm.bundle.cjs` (~2.3 MB; the
  upstream `dist/unicorn-arm.min.js` + `src/libelf-integers.js` + a CJS footer).
- Loader + typed surface: `lib/mcu/unicorn/load-unicorn-arm.ts`.
- Host: `lib/mcu/unicorn-arm-host.ts` (`UnicornArmHost`).

> Why unicorn.js and not a fresh Emscripten/WASM build of QEMU? This environment
> has no `emcc` and no published Unicorn/QEMU **WASM** npm package. unicorn.js is a
> prebuilt, CDN-hosted asm.js port of the very same engine — fetchable and working
> today. A modern WASM build can drop in behind the same `UnicornArmHost` seam later.

## It runs what the M0+ core cannot

`UnicornArmHost` presents the **same seam** as `CortexM0Host`
(`loadFlash` / `reset` / `run` / `pc` / `sp`) against the **same** STM32 memory map,
and bridges the peripheral region to the **same** `MMIOBus`:

| Hook | Action |
|---|---|
| `HOOK_MEM_WRITE` over the peripheral window | `bus.write(addr, width, value)` |
| `HOOK_MEM_READ` over the peripheral window | `value = bus.read(...)`, then `mem_write` so the load returns it |

The proof fixture (`lib/__tests__/fixtures/unicorn-arm/firmware.bin`, a bare-metal
Cortex-M3 image) uses `mla` and `udiv` — **Thumb-2-only** ops absent from ARMv6-M,
i.e. impossible on the rp2040js M0+ core. `UnicornArmHost` runs it through the
vector-table reset, computes `7*6+5=47` and `47/7=6`, stores them to SRAM, writes
`'A'` to a USART MMIO address (forwarded to a bus peripheral) and reads it back
(bus value substituted). Covered by `lib/__tests__/unicorn-arm-host.test.ts`.

## Speed

Measured in-process (Node, asm.js), tight Thumb-2 loop:

| Core | Engine | ~ips | In-browser? |
|---|---|---|---|
| ARMv6-M (M0+) | rp2040js (native JS) | ~24.7 M | ✅ |
| **ARMv7-M** | **unicorn.js (asm.js)** | **~8–12 M** | ✅ (this) |
| ARMv7-M | native qemu-system-arm | hundreds of M | ❌ (separate process) |

~8–12 M ips is roughly a third of the hand-written rp2040js M0 core but runs the
**full** Thumb-2/DSP ISA. More than fast enough for interactive simulation of
real firmware (a 72 MHz F103 second of wall-clock is many seconds of sim, but
typical sketches are I/O-bound, not compute-bound).

## Known limitation — interrupts / SysTick

Unicorn v1.0 does not model the Cortex-M **NVIC** exception entry, so peripheral
IRQs are **not yet vectored** into firmware here, and SysTick-interrupt-driven HAL
timebases (e.g. Arduino `delay()` on STM32duino) will busy-wait. Polling-style and
compute firmware run correctly today. Vectoring options (newest tracked work):

1. A `HOOK_INTR` + manual exception-stack-frame push driven from `bus.pendingIRQs()`
   (model the M-profile exception entry in the host), or
2. swap the asm.js engine for a modern Unicorn 2 / QEMU **WASM** build that models
   M-profile exceptions natively — drops in behind `UnicornArmHost` unchanged.

## Server compile path

`pickSimCore(board)` (`lib/sim/sim-core.ts`) maps a compiled board to its
in-browser core — `avr8js` / `cortex-m0` / `unicorn-arm` / `null`. The build API
(`app/api/projects/[id]/build/route.ts`) returns `simCore` alongside the firmware,
and `useSimulation` now branches on it to build an `STM32Runner` (via
`createStm32Runner`) backed by `UnicornArmHost` (F1) or `CortexM0Host` (G0), bridge
serial, and drive it with `STM32Runner.execute()`. Components wire through
`wireComponentsStm32` + `mapSTM32Pin`. Proven headless: real F103 firmware toggles
an LED on PC13 via unicorn.js through the UI wiring path
(`stm32-frontend-integration.test.ts`), and **verified live in a real browser**
(`e2e/stm32-simulation.spec.ts`: the PC13 LED blinks in-canvas from real
server-compiled F103 firmware). See
[stm32-frontend-and-phase5.md](./stm32-frontend-and-phase5.md) for the four
browser-only bugs that run surfaced (asm.js bundling, `require("fs")` leakage,
the unmapped Cortex-M System Control Space, and the board-id default). Remaining:
richer component wiring and NVIC vectoring (below).

> Browser loading note: the asm.js core is **not** bundled — it is served from
> `public/vendor/unicorn-arm/unicorn-arm.bundle.js` and fetched + evaluated at
> runtime (its Node-environment branch references `fs`/`path`, which no browser
> bundler can resolve). Node/vitest still `require()` the copy under `vendor/`.
> The runtime `eval` needs `script-src 'unsafe-eval'` if a strict CSP is added.

> Related: [stm32-m3-m7-qemu.md](./stm32-m3-m7-qemu.md),
> [stm32-m0-core.md](./stm32-m0-core.md),
> [multi-mcu-architecture-plan.md](./multi-mcu-architecture-plan.md).
