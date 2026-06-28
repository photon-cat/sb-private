# SparkBench vs. Wokwi — STM32 (M0/M0+)

A like-for-like comparison on the chips Wokwi actually ships, plus where each
wins. Wokwi facts are from their public docs (May 2026); SparkBench numbers are
measured on this machine.

## Chip coverage

| | Wokwi | SparkBench |
|---|---|---|
| STM32 chips | **3, fixed**: STM32C031 (M0+), STM32L031 (M0+), STM32F103C8 (M3) | **SVD-driven**: any G0/C0/L0 (M0+) by dropping in an SVD + board file; M3–M7 via Unicorn (Phase 4) |
| How a new chip is added | Wokwi engineering builds it | data file (SVD) + IP-model registry |

Wokwi's two M0+ parts (C031, L031) are the **same core class** as our Phase-3
target. Their F103 is M3 — our Phase 4. So today we overlap exactly on the M0+
tier; our approach generalizes by data rather than per-chip code.

## IO / peripherals

| Peripheral | Wokwi | SparkBench (M0+) |
|---|---|---|
| GPIO | ✅ | ✅ MODER/IDR/ODR/BSRR, output+input, watchers |
| UART/USART | ✅ + logic-analyzer decode | ✅ TX capture, RX feed, TXE/TC/RXNE, **TEACK/REACK**, RXNE/TC IRQ |
| I2C | ✅ + decode | ✅ **I2Cv2 master + slave-device bus** (register devices, MPU6050); NACK on missing device |
| SPI | ✅ + decode | ◑ minimal master (TX capture, TXE) |
| TIM / PWM | ✅ | ◑ accepts config; output not yet modeled |
| ADC | ✅ | ◑ runs via HAL timeout; values not modeled |
| Logic analyzer (VCD) | ✅ PulseView export | ✗ (have programmatic assertions instead) |
| Visual components, wiring UX | ✅ mature | ✗ (headless/test-first today) |

**Validated end-to-end with real STM32Cube HAL firmware** (compiled by
`arm-none-eabi-gcc`): blink (HAL_Delay), UART transmit, SPI transmit, and an
**IMU-over-I2C → UART** project that reads MPU6050 `WHO_AM_I` = `0x68` and prints
`W=0x68` — with the no-device case correctly returning a HAL error, not hanging.

Where Wokwi leads today: SPI/TIM/ADC depth, the visual logic analyzer, and the
polished component/wiring UI. Where we lead: **data-driven chip breadth** (SVD,
not hand-built), **test-native assertions** (`expect-pin`, serial asserts,
attachable I2C devices in code), and an **oracle-backed accuracy ratchet**
(differential testing vs simavr/QEMU) that Wokwi doesn't expose.

## Speed

Wokwi publishes no STM32 throughput numbers and targets real-time interactive,
in-browser (WASM) simulation. SparkBench's M0+ path (rp2040js-derived core, the
same engine Wokwi uses for RP2040), measured here:

| Workload | Instr/sec |
|---|---|
| Peak compute kernel | **~24.7M ips** |
| Warm hot loop (HAL_Delay) | **~17M ips** |
| Init-heavy HAL (clock + driver init) | **~5.6–7.4M ips** |

A Cortex-M0+ averages ~1.3–2 cycles/instruction → **~30–40M effective cycles/s**
peak. That's faster-than-real-time for the C031/L031 clock range and ample for
interactive use. A true head-to-head against Wokwi's STM32 isn't possible
locally (`wokwi-cli` runs C custom-chips, not a headless STM32 throughput probe),
so this is our absolute number with that caveat stated, not a fabricated delta.

## Bottom line

On the M0+ tier we now run the **same real HAL firmware** Wokwi does, across
GPIO/UART/I2C, at multi-MIPS speed. Wokwi is ahead on peripheral depth and UX
polish; SparkBench is ahead on extensibility (add a chip = add data) and
verifiability (oracle differential testing). Closing the remaining IO gap is
peripheral modeling (SPI depth, TIM/ADC, DMA/EXTI) on an architecture already
proven to take them.

> Related: [stm32-stress-benchmark.md](./stm32-stress-benchmark.md),
> [stm32-m0-core.md](./stm32-m0-core.md).
