# Roadmap — Full In-Browser Compile Chain (AVR + RP2040 + STM32)

Status: **Roadmap** (forward-looking). Branch: `full-local`.
Spike done: [phase1-avr-wasm-spike.md](./phase1-avr-wasm-spike.md). Build recipe: [build-clang-wasm.md](./build-clang-wasm.md).

## Goal

Move firmware **compilation** from the server into the browser, so SparkBench can compile **and**
simulate entirely client-side — no build server, optionally offline. Targets from the outset:
**AVR** (Uno/Nano/Mega), **RP2040** (Pico), **STM32 F4 / H7** (and other Cortex-M).

## The decision: one multi-target clang.wasm

The four boards collapse to **two ISA families** — and a single clang binary covers both:

| Board | ISA | clang backend | Linker | Browser sim (exists) |
|---|---|---|---|---|
| Uno/Nano/Mega | AVR 8-bit | `AVR` | `avr-ld` (lld AVR weak) | avr8js (`lib/avr-runner.ts`) |
| RP2040 (Pico) | ARM Cortex-M0+ | `ARM` | `ld.lld` ✅ | rp2040js (`lib/rp2040-runner.ts`) |
| STM32F4 | ARM Cortex-M4 | `ARM` | `ld.lld` ✅ | unicorn-arm (`lib/mcu/unicorn-arm-host.ts`) |
| STM32H7 | ARM Cortex-M7 | `ARM` | `ld.lld` ✅ | unicorn-arm |

**One `clang.wasm` built with `LLVM_TARGETS_TO_BUILD=WebAssembly;ARM;AVR` compiles for all of them.**
This is clang's defining advantage over GCC for multi-arch: GCC would mean porting 2–3 separate
toolchains to WASM (avr-gcc + arm-none-eabi-gcc), each a hard build. clang ships the lot in one
artifact, and clang-in-browser is already **proven working** (see the spike). Size is dominated by the
frontend/optimizer, not the backends, so adding AVR+ARM barely changes it (~60–80 MB uncompressed;
Wasmer reports ~30 MB compressed; cached once).

Trade-off accepted: clang output is **not bit-identical to avr-gcc**. The server gcc build stays
authoritative; in-browser clang is a **fast preview** until parity is validated per core.

## What we already have

| Building block | Where | Role |
|---|---|---|
| clang runs in-browser (proven) | `app/avr-wasm-test/page.tsx` + `@wasmer/sdk` | Phase 1 spike — compiles+links C→wasm client-side |
| avr8js / rp2040js / unicorn-arm sims | `lib/avr-runner.ts`, `lib/rp2040-runner.ts`, `lib/mcu/unicorn-arm-host.ts` | Stable load targets (hex/uf2/bin) for compiler output |
| WASI-SDK `clang++ → wasm32` | `lib/sim/verilog-chip-builder.ts` | Precedent: codebase already drives clang→wasm |
| Package manager + CAS | [package-manager-plan.md](./package-manager-plan.md) | Ships pinned deps + precompiled cores/libc to whatever compiler runs |
| Hermetic server build | build route + `lib/sandbox.ts` | The **fallback** every phase preserves |

## The invariant that makes this safe

> The **lockfile schema, CAS keys, and simulator load APIs** (`AVRRunner.loadHex`, `RP2040Runner`
> UF2, the STM32 `.bin` loaders) stay stable across every phase.

The compiler's only job is "sketch + locked deps → `hex`/`uf2`/`bin`", so the compile backend can move
server → browser **without touching the package manager or the simulators**. Each phase swaps the
backend behind a fixed contract and keeps the server build as a fallback.

---

## Phases (re-sequenced: ARM trio first, AVR second)

### Phase 0 — Hermetic server build *(foundation — package-manager-plan.md)*
Reproducible, vendored, portable deps feeding the existing PlatformIO build via `lib_extra_dirs`.
Establishes the lockfile + CAS contracts. **Independently valuable; prerequisite for all below.**

### Phase 1 — Clang-in-browser spike ✅ DONE
Proven: a real clang runs in-browser via `@wasmer/sdk` (cross-origin isolated, compiles+links C→wasm).
Finding: the off-the-shelf Wasmer `clang/clang` is **WebAssembly-target-only** (no ARM/AVR backend).
See [phase1-avr-wasm-spike.md](./phase1-avr-wasm-spike.md).

### Phase 2 — Build the multi-target clang.wasm  ← **the real blocker artifact**
Build clang + lld to WASIX with `LLVM_TARGETS_TO_BUILD=WebAssembly;ARM;AVR`, MinSizeRel, packaged for
`@wasmer/sdk`. CI job (hours), recipe in [build-clang-wasm.md](./build-clang-wasm.md). Done when
`clang -print-targets` in the browser lists `arm` and `avr`. The test page already detects this and
exercises the targets with no code change.

### Phase 3 — ARM trio in-browser (RP2040, STM32F4, H7)  ← cleanest path
clang `--target=arm-none-eabi -mcpu=cortex-m0plus|m4|m7` + **`ld.lld`** → full compile **and** link in
the browser (lld's ARM/Cortex-M support is production-grade — no binutils needed). Ship newlib +
CMSIS/Pico-SDK/STM32-HAL precompiled archives via CAS. Wire output into `rp2040-runner` (UF2) and
`unicorn-arm-host` (`.bin`). Three boards land together because they share the toolchain.

### Phase 4 — AVR in-browser (the outlier)
clang `--target=avr -mmcu=atmega328p` codegen is fine, but **`lld` AVR relocation support is weak** →
plan for `avr-ld` (binutils) compiled to WASM as the linker. Ship precompiled `avr-libc` + Arduino AVR
core via CAS. Wire `hex` into `AVRRunner.loadHex`. Validate the Arduino AVR core actually compiles
under clang (least-tested combination).

### Phase 5 — Precompiled cores + libc via CAS (cross-cutting)
For every arch, ship the core/libc/startup as precompiled `.a` archives keyed by `(arch×board-config)`
in the package-manager CAS, so the browser compiles only the user's translation unit and **links**.
Folds into Phases 3–4 per arch; called out separately because it's the size/speed lever.

### Phase 6 — Fully offline PWA
Cache CAS archives + the clang.wasm in IndexedDB / a service worker; compile + simulate with zero
server. Server reduces to storage/CDN + export. The literal "fully local MCU toolchain in the browser."

---

## Phase dependency graph

```
Phase 0 (lockfile + CAS + hermetic build)
        │
        ▼
Phase 1 (clang-in-browser spike) ✅ ──► Phase 2 (build clang.wasm: WebAssembly;ARM;AVR)
                                              │
                          ┌───────────────────┴───────────────────┐
                          ▼                                        ▼
              Phase 3 (ARM trio: RP2040,                Phase 4 (AVR: clang codegen +
              STM32F4/H7 — clang + ld.lld)              avr-ld; validate Arduino core)
                          │                                        │
                          └───────────────► Phase 5 (precompiled cores/libc in CAS) ◄┘
                                                     │
                                                     ▼
                                            Phase 6 (offline PWA, zero server)
```

## Risks / open questions

- **AVR linker (Phase 4)** is the residual wall. clang AVR codegen works, but `lld` AVR may not
  relocate cleanly → `avr-ld` to WASM. ARM links cleanly with `ld.lld`, so Phase 3 is low-risk and
  ships value even if Phase 4 stalls.
- **Core compatibility under clang** — ARM (CMSIS, Pico SDK, STM32 HAL) is well-trodden with clang;
  the **Arduino AVR core under clang** is the least-tested and must be validated in Phase 4.
- **Bundle size** — ~30 MB compressed (Wasmer's target), cached once; precompiled cores mean the
  browser only ever compiles one small file. Acceptable only with Phase 6 caching.
- **License** — LLVM is Apache-2.0-with-LLVM-exception (fine); `avr-ld`/binutils is **GPL** → same
  review as the already-flagged unicorn-arm bundle before shipping.
- **Output parity** — keep the server gcc build authoritative; in-browser clang is a fast preview
  until validated per arch.

## Decision rule

Proceed phase-by-phase. **Do not start Phase 2 (the LLVM build) until Phase 0 ships.** Phase 0 is
independently valuable; Phases 2–6 are an optional, reversible bet on stable contracts. Within the
bet, **do ARM (Phase 3) before AVR (Phase 4)** — it's the cleaner linker path and covers three of the
four boards.
