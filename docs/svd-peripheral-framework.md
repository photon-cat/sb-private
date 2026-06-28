# SVD-Driven Peripheral Framework (Phase 2)

The extensibility kernel for STM32 (and other Cortex-M MCU) support. It separates
**peripheral behavior** (hand-written IP-block models, reused across the family) from
**which instances exist and where** (data, from each MCU's CMSIS-SVD). Adding a new STM32
becomes "drop in its SVD + a board file" — no new core code unless it has an IP block
nobody has modeled yet.

CPU-core-agnostic: any Cortex-M engine (rp2040js core for M0/M0+, Unicorn-WASM for
M3–M7) drives the same bus.

## Layout (`lib/mcu/`)

| File | Role |
|---|---|
| `peripheral.ts` | `Peripheral` interface + `RegisterPeripheral` base (width-aware register array) |
| `mmio-bus.ts` | `MMIOBus` — routes loads/stores to the owning peripheral, aggregates IRQs |
| `svd.ts` | `parseSvd()` — CMSIS-SVD → device map (peripherals: name/group/base/size/interrupts/registers), resolving `derivedFrom` |
| `peripherals/nvic.ts` | `CortexMNvic` — enable/pending bitsets, `nextPending()` for the core to vector |
| `peripherals/rcc.ts` | `STM32RccF1` — clock control; mirrors oscillator-enable → ready flags so clock-init doesn't hang |
| `peripherals/gpio.ts` | `STM32GpioF1` — CRL/CRH/IDR/ODR/BSRR/BRR, output listeners + input drive |
| `peripherals/usart.ts` | `STM32UsartF1` — TX capture / RX feed, TXE/TC/RXNE flags, RXNE/TC IRQ |
| `platform.ts` | `buildPlatform(svdXml)` — assembles the bus from an SVD + an IP-model registry keyed by SVD group name |

## How a new MCU is added

```ts
import { buildPlatform } from "@/lib/mcu";
const plat = buildPlatform(readFileSync("STM32F103.svd", "utf-8"));
// plat.bus has GPIOA/B/C…, RCC, USART1… at their real addresses; plat.irqs maps names→numbers
```

The IP-model registry maps SVD `groupName` → a behavioral model:

```ts
STM32F1_MODELS = { GPIO: …STM32GpioF1, RCC: …STM32RccF1, USART: …STM32UsartF1 }
```

A new family that reuses these IP blocks needs only its SVD. A genuinely new block
(e.g. an STM32H7 DMA variant) needs one new model added to the registry.

## Accuracy notes (the parts that actually matter)

- **RCC ready flags** — modeled first-class. Firmware spins on HSIRDY/PLLRDY after
  enabling clocks; not setting them hangs the boot (the exact failure mode that stalled
  the mbed RP2040 core). `STM32RccF1` reflects each enable into its ready bit + SWS←SW.
- **NVIC** — enable/pending latching with `nextPending()`/`acknowledge()` so a core can
  vector; peripherals raise IRQs through `bus.pendingIRQs()`.
- **GPIO BSRR atomicity** and **USART status flags** — the registers firmware polls.

## Acceptance (verified)

`mcu-platform.test.ts` builds a platform from a real-addressed STM32 SVD fixture and
drives the boot sequence a real sketch performs — **through the MMIO bus**, with the CPU
core mocked (we issue the loads/stores it would):

1. RCC: enable GPIOA + USART1 clocks (APB2ENR).
2. GPIO: drive PA5 high via BSRR; read back via IDR.
3. USART: capture transmitted bytes → "HI".
4. USART RX → NVIC: feed a byte with RXNEIE; the bus surfaces the IRQ, the NVIC latches it.

Plus `mcu-svd.test.ts` (SVD parse incl. `derivedFrom`) and `mcu-peripherals.test.ts`
(per-model behavior). 17 tests; part of the 345-test suite.

## Next (Phase 3/4)

Attach a real Cortex-M core: route its peripheral-region loads/stores to `MMIOBus`
and drive its NVIC from `bus.pendingIRQs()`, then run real STM32 firmware.
- **M0/M0+** (G0/L0/C0/F0) → rp2040js Cortex-M0+ core. ✅ **Done** —
  `CortexM0Host` + `STM32Runner` run real GCC-compiled G0 firmware through this bus;
  the G0/C0/L0 IP models (MODER GPIO, ISR/TDR USART, G0 RCC) live in `STM32G0_MODELS`.
  See [stm32-m0-core.md](./stm32-m0-core.md).
- **M3–M7** (F1/F4/F7/H7/G4) → Unicorn-WASM (Phase 4).

See [multi-mcu-architecture-plan.md](./multi-mcu-architecture-plan.md).
