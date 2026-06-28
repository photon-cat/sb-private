# STM32 M0/M0+ on the rp2040js Core (Phase 3)

Phase 3 attaches a **real ARM Cortex-M0+ core** to the Phase-2 SVD peripheral
framework, so genuine compiled STM32 firmware runs headless. It delivers the
plan's central bet — *don't hand-write the CPU core* — by reusing rp2040js's
proven M0+ engine for the STM32 C0/G0/L0 families.

## Why reuse the rp2040js core

The Cortex-M0+ core, its **NVIC, SysTick, and SCB are ARM IP** — identical
silicon on an STM32G0 and on the RP2040. rp2040js already implements that core
(`CortexM0Core`) plus the PPB block (`RPPPB`: NVIC + SysTick + SCB + VTOR),
validated against real Raspberry Pi Pico firmware. Hand-writing a Thumb decoder +
NVIC is exactly the accuracy trap the architecture plan warns about, so we borrow
it and only swap the **memory bus**.

## The integration seam — `lib/mcu/cortex-m0-host.ts`

`CortexM0Core` touches its SoC through just six methods (`readUint{32,16,8}`,
`writeUint{32,16,8}`) plus `logger`/`onBreak`. Everything else (interrupt state,
exception entry/return, SysTick) lives on the core and the PPB.

rp2040js gates deep imports behind its package `exports` map, so `CortexM0Core`
can't be imported directly. `CortexM0Host` instead instantiates a full `RP2040`
purely to obtain a **wired core + PPB + clock**, then overrides its load/store
methods to an STM32 memory map:

| Region | Address | Handler |
|---|---|---|
| Flash (+ boot alias) | `0x08000000` / `0x00000000` | internal `flash` array (read-only) |
| SRAM | `0x20000000` | internal `sram` array |
| Cortex PPB (NVIC/SysTick/SCB/VTOR) | `0xE000Exxx` | delegated to `rp2040.ppb` |
| Peripherals (APB/AHB/IOPORT) | `0x40000000`–`0x5FFFFFFF` | Phase-2 `MMIOBus` |

The RP2040's own peripherals (UART/PIO/SIO/USB) are simply never addressed by
STM32 firmware. Peripheral IRQs raised on the bus are **level-synced into the
core's real NVIC** each step (`setInterrupt(irq, true/false)`), so exception
entry/return is the genuine ARM behavior, not a reimplementation.

## New IP models for the modern register flavor

The F1 models (CRL/CRH GPIO, SR/DR USART) don't fit post-F1 parts. Phase 3 adds
the register layout shared across **G0/C0/L0/F0/F3/F7/L4/G4** (and most M4/M7):

- `peripherals/gpio-g0.ts` — `STM32GpioG0` (MODER/IDR/ODR/BSRR/BRR, on the IOPORT
  bus at `0x50000000`).
- `peripherals/rcc-g0.ts` — `STM32RccG0` (G0 CR bit positions, IOPENR/APBENR;
  oscillator-enable → ready-flag mirroring kept first-class).
- `peripherals/usart-g0.ts` — `STM32UsartG0` (split ISR/RDR/TDR/ICR; TXE/TC/RXNE;
  RXNE/TC IRQ).

These are registered in `STM32G0_MODELS` (keyed by SVD group), proving the
extensibility claim: **a new family = its SVD + a model registry**, no core code.

## The runner — `lib/stm32-runner.ts`

`STM32Runner(firmware, svdXml, opts)` mirrors `AVRRunner`/`RP2040Runner`:
`buildPlatform()` → `MMIOBus`, `CortexM0Host` runs Thumb, and every USART's TX is
bridged to `onSerialByte`. It exposes `runCycles/runMs`, `pinState/setPinInput/
watchPin`, `feedSerial`, and `clockHz` (default 16 MHz HSI16) — the shape the
scenario runner consumes (formalized in Phase 0's `MCURunner`).

## Acceptance (verified)

`fixtures/stm32g0/firmware.c` is a bare-metal G0 sketch compiled by the **real
arm-none-eabi-gcc** (`build.sh`); the raw `firmware.bin` is committed so CI needs
no toolchain. `stm32-runner.test.ts` runs it on the M0+ core and asserts:

1. **Boot** — SP/PC load from the flash vector table (`0x20008000` / reset).
2. **GPIO** — `RCC.IOPENR` + `GPIOA.MODER`/`BSRR` drive **PA5 high** (read back
   via the model; observed through `watchPin`).
3. **USART** — `USART1` transmits **"HI"**.
4. **Interrupt** — `feedSerial('A')` raises RXNE → the bus surfaces IRQ 27 → the
   **borrowed NVIC vectors** to `USART1_IRQHandler`, which echoes `'B'` (A+1).

Plus `mcu-cortex-m0-host.test.ts` covers the host seam in isolation (reset
vector, SRAM stores, peripheral routing, level-synced IRQ delivery). 10 new
tests; full suite 355.

## Limits & next

- **No cycle-accurate timing.** Instruction execution is functional; SysTick runs
  off rp2040js's clock but peripheral baud/timers are instantaneous (as in the F1
  models). Fine for functional scenarios; a QEMU oracle (below) is the accuracy
  ratchet.
- **Oracle not yet wired.** Phase 3's plan calls for QEMU validation of the ARM
  semantics; the harness hook exists (`lib/verify/`) but a QEMU/Unicorn ARM oracle
  is Phase 4 work.
- **Real Arduino-G0 sketches** need the wider peripheral set (TIMx/SPI/I2C/ADC/
  EXTI) — Phase 5 breadth. The core + framework are ready for them.

> Related: [multi-mcu-architecture-plan.md](./multi-mcu-architecture-plan.md),
> [svd-peripheral-framework.md](./svd-peripheral-framework.md),
> [rp2040-pico.md](./rp2040-pico.md).
