# Differential Testing Harness (Phase 1)

A golden-trace differential-testing harness that validates SparkBench's production
MCU models against independent reference oracles — and a continuous accuracy ratchet
in CI. Already found a real, latent bug in avr8js (see below).

## Why

The CPU model's results are easy to get right; the **flags** and **timing** are where
emulators silently drift. An independent oracle, run over identical firmware, surfaces
exactly those bugs.

## Architecture (`lib/verify/`)

```
firmware ─┬─▶ production model (avr8js)  ──▶ trace (PC, R0–31, SREG, SP, cycles)
          └─▶ reference oracle           ──▶ trace
   diffTraces() → first divergence, field-level report
```

- `trace.ts` — `CpuState` + SREG formatting.
- `avr8js-tracer.ts` — `traceAvr8js(hex, {maxSteps})`: runs avr8js one instruction at a
  time, capturing architectural state.
- `diff.ts` — `diffTraces(a, b)`: first divergence with per-field detail; `formatDivergence()`.
- `oracle.ts` — `ReferenceOracle` interface (RTL via Verilator, or simavr).
- **ALU oracle** (`alu-reference.ts` + `avr8js-alu-probe.ts`) — an independent
  arithmetic/logic + flag implementation straight from the AVR Instruction Set Manual,
  swept exhaustively (256×256) against avr8js. No external toolchain; genuinely
  independent.

Tests: `lib/__tests__/verify-harness.test.ts`, `lib/__tests__/verify-alu.test.ts`.

## ⭐ Bug found: avr8js half-carry uses bit 0 instead of bit 3

The exhaustive ALU sweep immediately found a real bug. avr8js computes the half-carry
(H) flag as:

```js
sreg |= 1 & ((d & r) | (r & ~R) | (~R & d)) ? 0x20 : 0;
//      ^^^ masks BIT 0 — half-carry must come from BIT 3 (use `8 &` or `>>3`)
```

The half-carry *expression* is correct, but it's extracted at **bit 0** instead of
**bit 3**. So avr8js's H equals the carry out of bit 0, not the true half-carry.

- **Concrete:** `ADD(0x08,0x08)=0x10` has a carry out of bit 3 → real AVR sets **H=1**;
  avr8js reports **H=0**. `ADD(1,1)` → avr8js **H=1**, hardware **H=0**.
- **Scope:** pervasive — every instruction computing H: ADD, ADC, SUB, SUBI, SBC, SBCI,
  CP, CPC, CPI, NEG (`node_modules/avr8js/dist/.../cpu/instruction.js`, the `0x20` lines).
- **Why latent:** the result and all other flags (C/Z/N/V/S) are correct; AVR has no
  BCD/DAA instruction, so compiled C essentially never reads H. Practical impact on
  SparkBench: ~nil — but it's a genuine accuracy bug worth an **upstream avr8js report/PR**
  (fix: mask bit 3 instead of bit 0).

The test suite **characterizes** this precisely: it asserts avr8js matches the datasheet
on result + all flags *except* H across all 65 536 operand pairs, and pins H to the buggy
bit-0 behavior — so it stays green now and will **fail (alert us) if avr8js ever fixes
it**.

## Whole-program oracle: simavr (Phase 1b)

The ALU oracle covers instruction semantics in isolation; **simavr** (the de-facto C
AVR ISS) validates avr8js over a *whole program's* execution.

- `lib/verify/simavr/tracer.c` — a minimal simavr front-end that loads a raw ATmega328
  flash image and prints a per-instruction trace (`PC R0..R31 SREG SP`). Builds against a
  simavr checkout via `lib/verify/simavr/build.sh` (bypasses libelf/avr-gcc by loading a
  raw flash binary + hand-generating the two config headers).
- simavr is a **dev-time generator**: it produces a committed **golden-trace fixture**
  (`lib/__tests__/fixtures/blink.simavr-trace.txt`); CI diffs avr8js against the fixture
  with **no simavr build** (`lib/verify/simavr-oracle.ts` + `verify-simavr.test.ts`).

**Result:** avr8js and simavr agree **exactly** (PC, R0–31, SP, SREG-except-H) for the
**entire 173-instruction peripheral-free init** of a real blink firmware. The first
divergence is `IN r18, TCNT0` — a Timer0 counter read (avr8js=0, simavr=2): a benign
cycle-timing difference in a hardware counter, not an instruction bug (PC + SP stay
locked; only the read-value register differs). This validates the full instruction mix
the C runtime uses (LDS/STS/LDI/OUT/CALL/RET/branches/pointer ops) against the reference.

### Second fix surfaced: SRAM size / RAMEND

The reset SP differed — avr8js=0x20FF vs simavr=0x08FF. avr8js defaults to a larger SRAM,
so `AVRRunner` gave the ATmega328P the wrong RAMEND/stack top. **Fixed**: `AVRRunner` /
`AVRDebugRunner` now construct the CPU with `2048` bytes of SRAM (RAMEND 0x08FF), matching
real hardware. Guarded by a test in `verify-simavr.test.ts`.

## Optional: RTL oracle (deferred)

`jeras/rp8` (SystemVerilog AVR → Verilator → WASM, reusing `verilog-chip-builder.ts`)
would give true gate-level independence. Deferred: its pipelined data-bus protocol makes a
*correct* testbench high-effort, a third-party RTL reimplementation has its own quirks
(disagreements need triage), and simavr already provides the authoritative whole-program
oracle. A worthwhile later cross-check, not a priority.

## Status

✅ Harness framework + ALU oracle (exhaustive 256×256) + simavr whole-program oracle — CI (328 tests).
✅ Found + characterized the avr8js half-carry (H) bug.
✅ Found + fixed the AVRRunner SRAM-size / RAMEND fidelity bug.
◻ RTL (rp8) oracle — optional future cross-check.
