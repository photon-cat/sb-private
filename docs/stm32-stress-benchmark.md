# STM32 M0+ Emulator — Stress Test & Benchmark

"Pull in real STM32 HAL projects, try to break the M0+ emulator, and benchmark
it." This records what broke, what was fixed, and how fast it runs.

## Method

Six **real STM32Cube HAL** firmwares were compiled for `nucleo_g071rb` (Cortex-M0+)
with the actual `arm-none-eabi-gcc` (PlatformIO `ststm32`), each driving a
different subsystem through the full HAL — clock tree + GPIO/UART/SPI/I2C/TIM/ADC.
Sources + committed `.bin`s live in `lib/__tests__/fixtures/stm32-corpus/`
(`build.sh` regenerates them). They run on `STM32Runner` with a diagnostic
observer (`CortexM0Host.onUnmapped`) that records every access to a peripheral no
model handles — the precise signal for "what's missing". Hangs are symbolized to
HAL functions with `addr2line`. Harness: `lib/mcu/stress/`.

The M0+ **core itself never broke** — it's rp2040js's engine, validated against
real Pico firmware. Every failure was an **unmodeled peripheral**, exactly as the
architecture predicted.

## What broke, and the fixes

Findings surfaced in waves — fix the first wall, the next one appears.

| # | Symptom (real HAL function it hung in) | Root cause | Resolution |
|---|---|---|---|
| 1 | **All 5** clock-config firmwares spun in `HAL_RCC_ClockConfig` (~38k reads of `FLASH@0x40022000`) | FLASH `ACR` latency readback unmodeled → reads 0, never matches | Added `STM32FlashG0` (ACR storage) |
| 2 | Next: spin on `RCC->CFGR` after FLASH fixed | `SWS` (clock-switch status) didn't follow `SW` | `STM32RccG0` mirrors SW→SWS |
| 3 | `blink` stuck in `HAL_Delay`; all HAL timeouts infinite | host never advanced the rp2040 **clock**, so SysTick never fired | `CortexM0Host.step()` ticks the clock per cycle → SysTick + HAL timebase live |
| 4 | `uart` stuck in `UART_WaitOnFlagUntilTimeout` (`HAL_UART_Init`) | USART model didn't set `TEACK`/`REACK` enable-ack bits | `STM32UsartG0` reflects TE/RE→TEACK/REACK |
| 5 | `spi` stuck in `HAL_SPI_Transmit` (polling TXE) | SPI unmodeled | Added `STM32SpiG0` (minimal master: TXE ready, TX capture) |
| 6 | `i2c` spun in `I2C_IsErrorOccurred` (~187k reads of `I2C1`) | I2C unmodeled (addressing/ACK state machine) | Added `STM32I2CG0` (I2Cv2 master) + slave-device bus |

Fix #3 was the highest-leverage: advancing the clock makes SysTick fire **and**
makes every HAL `...UntilTimeout` poll actually time out instead of hanging — so
`tim`/`adc` now run to completion via their HAL timeouts even though TIM/ADC
behavior isn't modeled yet.

## Final scorecard

| Firmware | Result | Notes |
|---|---|---|
| `blink` | ✅ **works** | PA5 toggles via real `HAL_Delay` (SysTick) |
| `uart`  | ✅ **works** | transmits "UART-OK\n" over USART2 |
| `spi`   | ✅ **works** | SPI master init + transmit complete; reaches `main` |
| `tim`   | ◑ **runs** | reaches `main`; PWM config accepted but TIM output not yet modeled |
| `adc`   | ◑ **runs** | reaches `main` via HAL timeout; conversion value not modeled |
| `i2c`   | ✅ **works** | `HAL_I2C_Mem_Read` completes against an attached device |
| `imu`   | ✅ **works** | reads MPU6050 `WHO_AM_I`=0x68 over I2C, prints over UART |

All boot through `SystemClock_Config` and reach `main`; UART, I2C (with a
slave-device bus), and SPI TX are fully exercised end to end. The corpus is
pinned as `stm32-stress.test.ts` — when TIM/ADC get models, those flip too.

## Benchmark (single-threaded JS, this dev machine)

| Workload | Instr/sec | Note |
|---|---|---|
| Peak compute kernel (`add`/`sub`/`bne`) | **~24.7M ips** | decode/execute ceiling |
| Warm hot loop (`HAL_Delay`/`HAL_GetTick`) | **~17M ips** | JIT-warm, tight |
| Init-heavy mixed HAL code | **~5.6–7.4M ips** | clock setup, driver init |

A Cortex-M0+ averages ~1.3–2 cycles/instruction, so peak ≈ **30–40M effective
cycles/sec**. Versus a real STM32G0 (≤64 MHz): the emulator runs at roughly
**half real-time during heavy init and faster-than-real-time for low/idle clocks**
— comfortably interactive for functional simulation. (These are functional, not
cycle-accurate, figures; the QEMU oracle is the accuracy ratchet — Phase 4.)

## Prioritized next models (Phase 5)

From the access logs, ranked by how often real HAL hits them (I2C now done):

1. **TIM** (CR1/CNT/CCR/SR) — PWM duty + counter readback for output fidelity.
2. **ADC** (ADRDY/EOC + a data source) — real conversion values.
3. **SPI depth** — RX data source for full-duplex display/sensor reads.
4. **DMA / EXTI / SYSCFG** — appear once display/sensor drivers use IT/DMA paths.

> Related: [stm32-m0-core.md](./stm32-m0-core.md),
> [svd-peripheral-framework.md](./svd-peripheral-framework.md),
> [multi-mcu-architecture-plan.md](./multi-mcu-architecture-plan.md).
