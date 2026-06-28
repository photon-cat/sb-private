# stm32webemu

STM32F103 (ARM Cortex-M3 / Thumb-2) emulator for the browser, built to plug
into SparkBench alongside `avr8js` (Arduino Uno) and `espwebemu` (ESP32).

## Status: Slice 1 — scaffold

What works:

- Memory bus (flash, SRAM, MMIO) matching the STM32F103C8 map
- Cortex-M3 reset semantics (SP + reset vector from flash @ 0x00000000)
- Thumb-2 decoder covering the common blinky-class instructions:
  MOV/MOVS, CMP, ADDS/SUBS, ADD/SUB reg, data-proc reg (ANDS/ORRS/…),
  LDR literal, LDR/STR (reg, imm5), LDRH/STRH, LDRB/STRB, stack LDR/STR,
  PUSH/POP, CBZ/CBNZ, B<cond>, B.N, BX, BLX, BL (T1 32-bit), ADD Rd SP/PC, BKPT, NOP hints
- GPIO peripheral with BSRR / BRR / ODR semantics and an `onOdrChange`
  observer (ready to drive SparkBench LEDs)
- RCC peripheral stub that reports clock-ready bits so Arduino core init
  doesn’t spin forever
- SysTick timer that decrements per executed cycle
- `Stm32Runner` facade that wires the above together and steps up to N cycles
- Vitest coverage for reset, decoder basics, GPIO semantics, and a runner
  smoke test that toggles PC13 via memory-mapped BSRR

## What’s missing (Slice 2)

- Most 32-bit Thumb-2 encodings (MOV.W / MOVW / MOVT, T3 data-proc, LDR.W / STR.W,
  LDM/STM, TBB/TBH, UDIV/SDIV, multiply, bitfield ops)
- MSR/MRS, CPSIE/CPSID, SVC, exception entry/exit (NVIC integration)
- IT block consumption (state is tracked but not applied to conditional execution)
- Integration with SparkBench `hooks/useSimulation.ts` — currently the STM32
  board flows through the same compile-only download path as ESP32 in
  `app/api/projects/[id]/build/route.ts`

## Running tests

```bash
cd stm32webemu
../node_modules/.bin/vitest run
```

(or install local deps with `npm install` inside `stm32webemu/`).

## Design notes

- The decoder is intentionally hand-rolled instead of table-driven so each
  instruction class is easy to cross-reference against ARMv7-M ARM sections
  A6/A7. Dispatch ordering matters: see the comment in `stepThumb()` about
  the `0x1800` add/sub-reg class overlapping the generic shift-imm window.
- The memory bus is permissive (unmapped reads return 0, unmapped writes are
  dropped) to avoid bus faults during early bring-up. This will tighten once
  the NVIC / fault path lands.
- GPIO/RCC are intentionally minimal — enough for Arduino core + STM32duino
  `digitalWrite` + `delay` to reach steady state, not full register-accurate.
