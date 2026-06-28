# STM32 M3–M7 (Phase 4) — QEMU ARM backend + the Unicorn-WASM decision

Phase 4 extends coverage from the M0+ tier (C0/G0/L0, on the rp2040js-derived
core) to the **ARMv7-M** parts — F1/F4/F7/H7/G4 — which need full **Thumb-2**
(plus FPU/DSP on M4/M7). Hand-writing that decoder is the trap the plan rejects,
so the engine must be borrowed.

## What was decided (and why)

The plan's target was **Unicorn-WASM** (QEMU's ARM CPU compiled to WebAssembly)
as the in-browser production core. Scouting this environment:

- ❌ No `@unicorn-engine/unicorn` / `unicorn.js` npm package.
- ❌ No Emscripten toolchain to build Unicorn → WASM from source.
- ✅ **Native `qemu-system-arm` 11.0 is installed** — the *same* QEMU ARM core,
  with real Cortex-M3/M4 machines (`lm3s6965evb`, `mps2-an385`, and even
  `b-l475e-iot01a` = STM32L4 M4).

So the **production in-browser Unicorn-WASM core is deferred** (it's a vendoring/
build task, not a design question) and Phase 4 delivers the other half now: the
**native QEMU ARM backend + oracle**, which is:

1. a heavyweight **execution backend** for M3–M7 firmware on CI/desktop, and
2. the **ARM-semantics oracle** for the differential harness — the ARMv7-M analog
   of simavr-for-AVR (Phase 1b).

When a Unicorn/QEMU WASM build is vendored, it drops in behind the same
`CortexM0Host`-shaped seam; the peripheral framework + SVD platform are unchanged.

## Delivered — `lib/mcu/qemu/qemu-arm-runner.ts`

- `qemuArmAvailable()` — probe; tests skip cleanly when QEMU is absent.
- `runQemuArm(elf, {machine, cpu, timeoutMs})` — runs an ARM Cortex-M ELF
  headless and captures semihosting output (QEMU routes it to stderr).

**Proof it runs what the M0+ core can't:** `fixtures/qemu-arm/firmware.c` is a
Cortex-M4 program using `mla` (multiply-accumulate) and `udiv` — **Thumb-2-only**
instructions absent from ARMv6-M (the M0+). On QEMU it computes and prints
`M4=47/6` (`7*6+5=47`, `47/7=6`); `qemu-arm.test.ts` asserts it. The same opcodes
would fault/misdecode on the rp2040js M0 core — which is exactly why M3–M7 needs
this backend.

## How this composes with the rest

| Tier | Chips | Core | Status |
|---|---|---|---|
| ARMv6-M (M0/M0+) | C0/G0/L0 | rp2040js core (`CortexM0Host`) | ✅ in-browser, Phase 3 |
| ARMv7-M (M3/M4/M7) | F1/F4/F7/H7/G4 | **native QEMU** (this) | ✅ CI/desktop backend + oracle |
| ARMv7-M, in-browser | same | **unicorn.js** (`UnicornArmHost`) | ✅ Phase 4b — see [unicorn-arm-core.md](./unicorn-arm-core.md) |

The differential harness can now diff a future in-browser ARM core against this
QEMU oracle the same way avr8js is diffed against simavr.

## Next

1. **Vendor a Unicorn/QEMU WASM build** → wrap as an in-browser M3–M7 core behind
   the runner interface (the production piece this defers).
2. **Wire QEMU into the differential harness** (`lib/verify/`) as the ARM oracle —
   lockstep PC/reg diff against the in-browser core once it exists.
3. Map QEMU's STM32 board peripherals ↔ our SVD models, or run our framework's
   peripherals against the QEMU core via its IO callbacks.

> Related: [multi-mcu-architecture-plan.md](./multi-mcu-architecture-plan.md),
> [stm32-m0-core.md](./stm32-m0-core.md), [differential-testing.md](./differential-testing.md).
