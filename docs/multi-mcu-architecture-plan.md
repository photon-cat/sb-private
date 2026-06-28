# Multi-MCU Simulation Architecture Plan

## Goal

Make SparkBench the **most extensible** hardware simulator while staying **accurate**
across the common microcontroller families — starting with the full STM32 lineup —
without drowning in per-chip hand-written emulator code.

The strategy is a deliberate split:

- **Production models** — fast, browser-native simulators users actually run.
- **Reference oracles** — slower, independent, accurate models (RTL via Verilator,
  or a mature C ISS) used in CI to *validate* the production models and find their bugs.

"RTL + TS, both" is not a compromise — RTL and a borrowed DBT core are *infrastructure*
that keep the shipped TS layer small and let the MCU family stay correct.

## Principles

1. **Don't hand-write CPU cores per chip.** Reuse one proven engine per ISA family.
   The decoder is the trap — accuracy holes + per-variant maintenance.
2. **Peripherals are data, not code.** ST reuses IP blocks across the family and ships
   CMSIS-SVD for every part. Model each IP block once; add an MCU by adding data.
3. **Every production model has an oracle.** Differential testing against RTL/ISS is a
   continuous accuracy ratchet, not a one-time check.
4. **One runner interface.** AVR, RP2040, STM32, future cores all expose the same shape
   so the scenario runner, wiring, and UI don't care which MCU is underneath.
5. **Match Wokwi where it helps** (avr8js, rp2040js, custom-chip ABI) for ecosystem
   alignment; exceed it where we can (test-native assertions, local Verilog, RTL oracles).

---

## Current state (baseline — already built)

| Capability | Status | Files |
|---|---|---|
| AVR core + peripherals | ✅ avr8js, configurable clock | `lib/avr-runner.ts`, `lib/avr-debug-runner.ts` |
| RP2040 core | ✅ rp2040js wrapper, UF2/HEX load, GPIO/UART/USB | `lib/rp2040-runner.ts`, `lib/rp2040/` |
| Custom-chip C ABI (full Wokwi) | ✅ pins/watch/timers/I2C/SPI/UART/framebuffer | `lib/chip-runtime.ts` |
| Verilog/SV chips → WASM | ✅ Verilator → WASI-SDK → runtime | `lib/sim/verilog-chip-builder.ts` |
| Scenario runner + assertions | ✅ serial/pin/display, JSON/JUnit | `lib/scenario-runner.ts`, `scripts/sparkbench-test.ts` |
| MCU registry / board metadata | ✅ AVR/ESP32/STM32/RP2040 entries | `lib/diagram-parser.ts` (`MCU_REGISTRY`) |
| Firmware build (PlatformIO) | ✅ AVR; ⚠️ RP2040 blocked (core clone) | `lib/sim/firmware-builder.ts` |
| Toolchains present | Verilator 5.048, WASI-SDK, PlatformIO-AVR, wokwi-cli | (ngspice, earlephilhower core absent) |
| STM32 hand-rolled scaffold | ⚠️ **to retire** (F103-only Thumb-2, ~1100 LOC) | `stm32webemu/` |

The STM32 scaffold is the avr8js pattern applied to STM32 — it won't extend to the
family and should be replaced by the architecture below.

---

## Target architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  SparkBench UI / scenario runner / wiring                              │
│     depends only on the common MCURunner interface                     │
├──────────────────────────────────────────────────────────────────────┤
│  Board / package layer    pins → ports, clock source (per-board file)  │
├──────────────────────────────────────────────────────────────────────┤
│  Platform layer           per-MCU map from CMSIS-SVD:                   │
│                           memory regions, peripheral instances+bases,  │
│                           IRQ numbers, register/bitfield defs           │
├──────────────────────────────────────────────────────────────────────┤
│  Peripheral framework     MMIO bus + IP models (modeled ONCE):         │
│                           NVIC, RCC, GPIO, USART, TIMx, SPI, I2C, ADC,  │
│                           DMA, FLASH/EXTI/SYSCFG …                      │
├──────────────────────────────────────────────────────────────────────┤
│  CPU core layer (per ISA, one engine each):                            │
│    AVR  → avr8js          M0/M0+ → rp2040js core                       │
│    M3/M4/M7/M33 → Unicorn-WASM (QEMU ARM)                              │
│    (future) RISC-V → Verilated open core (runs, not just oracle)       │
├──────────────────────────────────────────────────────────────────────┤
│  Verification (CI only):  differential harness — lockstep run +        │
│    state diff vs oracle (AVR RTL via Verilator, simavr ISS, QEMU)      │
└──────────────────────────────────────────────────────────────────────┘
```

### A. Common runner interface (`MCURunner`)

Extract what the scenario runner / wiring actually need into one interface so MCUs are
interchangeable. `AVRRunner` and `RP2040Runner` already implement most of it.

```ts
interface MCURunner {
  readonly clockHz: number;
  loadFirmware(image: Uint8Array | string): void;
  runCycles(n: number): void;
  runMs(ms: number): void;
  readonly cycles: number;
  // digital IO
  pinState(pin: PinRef): boolean;
  setPinInput(pin: PinRef, high: boolean): void;
  watchPin(pin: PinRef, cb: (high: boolean) => void): () => void;
  // serial
  onSerialByte?: (byte: number) => void;
  feedSerial(byte: number): void;
  // analog / buses exposed per-capability (ADC channel, I2C/SPI taps)
  stop(): void;
}
```

The scenario runner and `wire-components` are refactored to consume `MCURunner`, so
`expect-pin`, `set-control`, displays, and custom chips work on any MCU.

### B. SVD-driven peripheral framework (`lib/mcu/`)

The extensibility primitive. CPU-core-agnostic.

- **MMIO bus** — peripherals register `[base, size)`; dispatch `read32/write32` and a
  `tick(cycles)`; raise IRQs through the NVIC.
- **Peripheral model interface** — `read(offset)`, `write(offset, value)`,
  `tick(cycles)`, `reset()`, exposes IRQ lines + DMA requests.
- **SVD loader** — parse CMSIS-SVD → `{ memoryMap, peripherals: [{name, base, type}], irqs }`.
  We don't model from SVD blindly; SVD gives the *map + register layout*, and we attach
  hand-written *behavior* models keyed by IP block type.
- **IP models** — one per reused STM32 block. Minimum to boot+blink+print: **NVIC, RCC
  (clock tree + ready flags), GPIO, USART**. Then **TIMx, SPI, I2C, ADC, DMA, EXTI**.

Adding a new STM32 = drop in its SVD + a board file; new code only if it has an
unmodeled IP block (rare, due to IP reuse).

### C. Core integration

- **M0/M0+:** wrap rp2040js's Cortex-M0(+) core standalone (it's separable from the RP2040
  SoC). Covers STM32 C0/G0/L0 (M0+) and F0 (M0). Retire `stm32webemu`'s decoder.
- **M3–M7/M33:** integrate **Unicorn Engine → WASM** (QEMU's ARM CPU). Hand-rolling
  M4/M7 (Thumb-2 + FPU + DSP) accurately is infeasible; borrow the proven decoder and
  spend effort on peripherals. Architecturally consistent with our Verilator→WASM/WASI work.
- Both sit behind `MCURunner`; the peripheral framework + SVD platform are shared.

### D. Differential-testing harness (`lib/verify/`) — the accuracy ratchet

Run identical firmware on the production model and an independent oracle, stepping in
lockstep, diffing architectural state (PC, registers, flags, cycles, memory writes,
pin states). First divergence = a bug in the production model.

```
test firmware ─┬─▶ production model (avr8js / rp2040js core)
               └─▶ oracle ─┬─ RTL core (Verilator→WASM)  → instruction semantics + cycles
                           ├─ simavr (C ISS → WASM)      → AVR peripherals
                           └─ QEMU/Unicorn               → ARM instruction semantics
   → state diff each step → report first divergence
```

Oracles by layer:
- **RTL (Verilator→WASM)** — independent core/ISA + cycle reference (we already have the
  toolchain). Open Verilog/SV AVR core for AVR; open RISC-V core later.
- **simavr (C → WASM)** — mature AVR ISS, best for **peripheral** accuracy avr8js's RTL
  oracle can't cover.
- **Unicorn/QEMU** — ARM ISA reference for the STM32 cores.

Runs in CI as a torture-test corpus (instruction tests, compiler output, real sketches).

---

## Phased roadmap

Each phase is independently shippable and ordered by ROI / dependency.

### Phase 0 — Common runner interface (foundation)
- Define `MCURunner`; make `AVRRunner` + `RP2040Runner` implement it.
- Refactor `scenario-runner` + `wire-components` to consume `MCURunner` (AVR path unchanged in behavior).
- **Acceptance:** all existing scenarios still green through the interface.

### Phase 1 — Differential-testing harness (accuracy ratchet) ⭐ start here
- Scout a Verilator-clean, ISA-compatible open AVR core; Verilate → WASM.
- Build lockstep diff harness (avr8js vs RTL): PC/regs/SREG/cycles per step.
- Add simavr→WASM as the peripheral oracle.
- Torture corpus: instruction tests + a few compiled sketches; run in CI.
- **Acceptance:** harness runs N programs, reports divergences; ≥1 real avr8js
  discrepancy found/triaged (or clean bill across the corpus). Highest ROI, fully
  feasible now (reuses Verilator→WASM).

### Phase 2 — SVD-driven peripheral framework
- MMIO bus + peripheral interface + NVIC + RCC + GPIO + USART.
- SVD loader; ingest STM32F103 + STM32G0 SVDs → memory map + peripheral table.
- Unit tests: register read/write, IRQ delivery, RCC clock-ready flags, USART TX/RX.
- **Acceptance:** framework boots a trivial program that configures RCC, toggles a GPIO,
  prints over USART — core stubbed/mocked.

### Phase 3 — STM32 M0/M0+ on the rp2040js core ✅
- Extract rp2040js Cortex-M0(+) core behind `MCURunner`; attach the Phase-2 framework
  with a G0/C0/L0 SVD + board file. PlatformIO build path (STM32 G0, UF2/ELF/HEX).
- **Acceptance:** a real STM32G0 Arduino blink+serial sketch runs headless; scenario
  passes (`expect-pin` on a GPIO, serial assert). Validated against QEMU oracle.
- **Done:** `CortexM0Host` (`lib/mcu/cortex-m0-host.ts`) reuses rp2040js's `CortexM0Core`
  + `RPPPB` (NVIC/SysTick/SCB) and swaps the bus to an STM32 memory map backed by the
  Phase-2 `MMIOBus`. Added the modern G0/C0/L0 IP models (MODER GPIO, ISR/TDR USART,
  G0 RCC) in `STM32G0_MODELS`, a G0 SVD, and `STM32Runner`. A **real arm-none-eabi-gcc**
  bare-metal G0 firmware (committed `.bin`) boots, drives PA5 high, prints "HI", and a
  USART RX **interrupt vectors through the borrowed NVIC** (handler echoes byte+1) —
  6 acceptance + 4 host-seam tests. QEMU oracle still pending (Phase 4). See
  [stm32-m0-core.md](./stm32-m0-core.md).

### Phase 4 — STM32 M3–M7 via Unicorn ✅ (in-browser core + native oracle)
- Integrate a Unicorn ARM core behind the host seam; reuse the peripheral framework
  with F1/F4 SVDs. Build path for F103/F411.
- **Acceptance:** STM32F103 ("blue pill") and an F4 blink+serial run headless; scenarios pass.
- **Done (4a, native oracle):** native `qemu-system-arm` 11.0 is the M3–M7 backend +
  ARMv7-M differential oracle (`lib/mcu/qemu/qemu-arm-runner.ts`): a Cortex-M4 `mla`+`udiv`
  firmware runs via semihosting → `M4=47/6`.
- **Done (4b, in-browser core):** the Unicorn-WASM goal is met by vendoring **unicorn.js**
  (Unicorn v1.0 ARM cross-compiled to **asm.js** — pure JS, no native process, runs in the
  browser). `UnicornArmHost` (`lib/mcu/unicorn-arm-host.ts`) executes full Thumb-2, drives
  the STM32 memory map, and bridges the peripheral region to the same `MMIOBus` via Unicorn
  memory hooks. ~8–12 M ips. The build response now carries `simCore` (`lib/sim/sim-core.ts`)
  so the client picks the right engine. See [unicorn-arm-core.md](./unicorn-arm-core.md).
- **Remaining:** Cortex-M NVIC exception vectoring (Unicorn v1.0 lacks it — SysTick-IRQ HAL
  busy-waits today) and feeding STM32 `.bin` into the React `SimulationPanel` (UI wiring,
  no new core work). See [stm32-m3-m7-qemu.md](./stm32-m3-m7-qemu.md).

### Phase 5 — Breadth + polish ◑ (peripherals + frontend wiring done)
- Add DMA, TIMx (PWM), SPI, I2C, ADC, EXTI IP models → unlock displays/sensors on STM32.
- Add more SVDs/boards (F0/F3/F7/G4/H7/L4…) — mostly data.
- Component wiring for STM32 pin styles; UI board support.
- **Acceptance:** the existing component scenarios (LED, button, SSD1306, etc.) run on an
  STM32 target, not just AVR.
- **Done:** added TIM (PWM duty), ADC (analog values), EXTI (edge→IRQ) G0 models
  (`lib/mcu/peripherals/{tim,adc,exti}-g0.ts`, registered in `STM32G0_MODELS`); SPI/I2C
  already existed. Frontend wired end-to-end: `pickSimCore` → build response `simCore` →
  `createStm32Runner` (cortex-m0 / unicorn-arm) → `STM32Runner.execute()` real-time loop →
  `wireComponentsStm32` (LED/buzzer/button/pot) using `mapSTM32Pin`. STM32 boards flipped
  `simulatable: true`. Proven headless: real F103 firmware on **unicorn.js** toggles an LED
  on PC13 through the UI wiring path (`stm32-frontend-integration.test.ts`).
  See [stm32-frontend-and-phase5.md](./stm32-frontend-and-phase5.md).
- **Remaining:** richer component wiring (SSD1306/sensors over STM32 I2C), DMA model, more
  SVDs/boards, and a live in-browser verification (dev server + PlatformIO F103 compile).

### Phase 6 (optional) — Open RISC-V as a first-class core
- Verilate an open RISC-V core (e.g. picorv32/VexRiscv) → WASM and *run* it (not just
  diff). A differentiator Wokwi doesn't offer.
- **Acceptance:** a RISC-V blink runs; same `MCURunner` + peripheral framework.

### Cross-cutting — finish RP2040
- Resolve the earlephilhower-core build blocker (faster network / prebuilt UF2 / CI image)
  and wire the RP2040 build + scenario path (Task #40). The `RP2040Runner` is ready.

---

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| No Verilator-clean, accurate open AVR core | Phase 1 RTL oracle weaker | Lean on **simavr** (peripherals) + RTL for core only; pick the best-coverage Verilog core; scope RTL oracle to ISA/cycles |
| Unicorn→WASM integration effort/size | Phase 4 slips | Prototype early; fall back to extending the rp2040js core for M3 if needed; keep M0 path (Phase 3) shipping value meanwhile |
| STM32 accuracy = DMA + NVIC + clock tree (not ALU) | Subtle firmware bugs | Model NVIC/RCC/DMA first-class; validate with QEMU oracle + real sketches |
| Peripheral long tail per family | Endless modeling | IP reuse means ~15–20 models cover most; **Renode as a headless/CI backend** for exotic parts |
| Browser performance of Unicorn/RTL | Slow UX | Production = TS/Unicorn-WASM (fast); RTL/simavr/Renode are **CI-only oracles**, never the user path |
| Build toolchains heavy (pico/STM32 cores) | CI flakiness | Commit prebuilt firmware fixtures (as done for AVR/Verilog); cache toolchains in CI |

## Key decisions to lock

1. **M3–M7 core: Unicorn-WASM vs. extend rp2040js core.** Recommend Unicorn-WASM for
   accuracy/breadth; decide after a Phase-4 spike.
2. **Renode as headless backend?** Strong for the STM32 long tail + as an oracle; adds a
   .NET service dependency. Decide before Phase 5 breadth.
3. **simavr→WASM vs. native simavr in CI.** WASM keeps it in-process with the harness;
   native is simpler to build. Decide in Phase 1.

## Definition of done (the vision)

A new common STM32 is added by: dropping in its **SVD + a board file** (no new core
code, peripheral code only for genuinely new IP). Every shipped core is continuously
**diffed against an oracle in CI**. Users run fast in-browser; accuracy is guaranteed by
the reference models behind the scenes. Same `MCURunner` powers AVR, RP2040, STM32, and
(optionally) RISC-V.

> Related: [rp2040-pico.md](./rp2040-pico.md), [verilog-chips.md](./verilog-chips.md),
> [custom-chips.md](./custom-chips.md), [testing-plan.md](./testing-plan.md).
