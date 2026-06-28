# STM32 in the browser frontend + Phase 5 peripherals

This wires the in-browser STM32 cores (Phase 3 CortexM0Host, Phase 4b unicorn.js
`UnicornArmHost`) into the React simulator, and adds the Phase 5 peripheral
breadth that component wiring needs.

## Compile → pick core → run (the server path, closed)

```
source ──build API──▶ firmware.bin (ststm32)  +  simCore  ──▶ createStm32Runner ──▶ STM32Runner
                       (app/api/.../build)        (pickSimCore)   (lib/sim/)            .execute() loop
```

- `pickSimCore(board)` (`lib/sim/sim-core.ts`) → `avr8js | cortex-m0 | unicorn-arm | null`;
  returned as `simCore` in the build response.
- `useSimulation` branches on `simCore`: for `cortex-m0`/`unicorn-arm` it decodes the
  base64 `.bin`, calls `createStm32Runner`, bridges `onSerialByte` → the serial monitor,
  and starts the runner — before the old "compile-only" fallback.
- `createStm32Runner` (`lib/sim/create-stm32-runner.ts`) selects the engine:
  - **cortex-m0** → `CortexM0Host` + `STM32G0_MODELS` + the G0 SVD (full peripheral set,
    real NVIC/SysTick from rp2040js → interrupt-driven HAL works).
  - **unicorn-arm** → `UnicornArmHost` (asm.js, lazily code-split) + `STM32F1_MODELS` +
    the F1 SVD (full Thumb-2; see the NVIC caveat below).

## One runner, two cores

`STM32Runner` now takes a `hostFactory` so it drives either core behind the
`McuCoreHost` interface (`cycles/loadFlash/reset/step/runBatch`). It gained an
AVR-shaped real-time `execute()/stop()/resume()` loop (batch + wall-clock
throttle) so `useSimulation`'s start/pause/resume effects treat it like
`AVRRunner`. GPIO/USART access is duck-typed so the F1 and G0 model flavors both
work. `SimRunner = AVRRunnerLike | STM32Runner` + `isStm32Runner` thread the union
through `SimulationPanel` / `DiagramCanvas` / `SimulationControls` / wiring.

## Component wiring

`wireComponentsStm32` (`lib/wire-components-stm32.ts`) mirrors the AVR
`wireComponents`, producing the same `WiredComponent` map the UI binds to —
LED/buzzer (output watch), pushbutton (input pull-up), potentiometer (ADC) — via
`mapSTM32Pin("PC13") → {GPIOC, 13}` and the runner's `pinState/watchPin/
setPinInput/setAnalog`. `useSimulationWiring` branches to it for STM32 runners.

## Phase 5 peripherals (G0 flavor)

New models registered in `STM32G0_MODELS`:

| Model | File | Surface |
|---|---|---|
| `STM32TimG0` | `tim-g0.ts` | timer/PWM: `counter()`, `pwmDuty(ch)`, UIF/update IRQ |
| `STM32AdcG0` | `adc-g0.ts` | `setChannel(ch, v12)`, DR read + EOC, EOC IRQ |
| `STM32ExtiG0` | `exti-g0.ts` | `triggerLine(line, rising)`, RPR/FPR w1c, line→IRQ (5/6/7) |

SPI/I2C already existed. These run on the cortex-m0 (G0) path where the NVIC is
real, so EXTI/TIM/ADC interrupts vector correctly.

## Verified

**Headless** (`lib/__tests__/stm32-frontend-integration.test.ts`, jsdom): real
F103 firmware → `createStm32Runner("unicorn-arm")` → `wireComponentsStm32` → an
**LED on PC13 toggles** as unicorn.js executes the GPIO loop; `decodeFirmwareBin`
round-trips; the `execute()/stop()` loop advances cycles. Plus 13 Phase-5
peripheral unit tests. Full suite: 399 pass; project typechecks.

**Live in a real browser** (`e2e/stm32-simulation.spec.ts`, Playwright/Chromium):
the `stm32-blink` project compiles on the server (PlatformIO `ststm32` + the
Arduino framework → `simCore=unicorn-arm`, ~10 KB `.bin`), the 2.3 MB asm.js core
loads, and the **PC13 `<wokwi-led>` visibly toggles on/off** in the canvas with no
uncaught page errors. This exercises the whole path the headless test can't: Next
bundling, the static-asset core loader, the build API, and the React render.

### Bugs the live run surfaced (and fixed)

The browser path tripped over four issues invisible to jsdom/Node tests:

1. **Bundler choked on the asm.js core.** `await import("module")` (Node builtin)
   and a static `import()` of the 2.3 MB CJS bundle made webpack/Turbopack try to
   resolve Node builtins (`module`, `fs`, `path`) for the browser graph. Fix: the
   browser branch now **fetches the bundle as a static asset** (`public/vendor/
   unicorn-arm/…`) and `eval`s it in a sloppy `Function` scope — never bundled;
   the Node branch's `require` path is assembled at runtime so bundlers don't
   trace it.
2. **`require("fs")` reached the client** via `buildPlatformFromFile` in
   `platform.ts` (imported for the model registries). Moved to a Node-only
   `lib/mcu/platform-node.ts`.
3. **No System Control Space.** `UnicornArmHost` didn't map the Cortex-M PPB
   (`0xE0000000`), so the Arduino startup's writes to `SCB->VTOR`/SysTick faulted
   (`UC_ERR_WRITE_UNMAPPED`). Now mapped as plain RW memory.
4. **Board id defaulted to `uno`.** The MCU-detect effect read `mcuTarget` back
   from state right after dispatching it (stale), so an STM32 diagram built for
   AVR. Fixed to resolve the target locally (`WorkbenchProvider`).

## F1 (F103) peripheral parity

The F1 IO surface now matches the G0 set. `STM32F1_MODELS` registers GPIO, RCC,
USART (F1 flavor), AFIO + FLASH (passthrough), and:

| Group | Model | Notes |
|---|---|---|
| `EXTI` | `STM32ExtiF1` (`exti.ts`) | single `PR` (w1c), F1 line→vector map (EXTI0..4, EXTI9_5=23, EXTI15_10=40); `triggerLine`/`SWIER` |
| `I2C` | `STM32I2CF1` (`i2c.ts`) | I2Cv1 SB/ADDR/BTF/TxE/RxNE/AF state machine + slave bus; HAL EV5/EV6 clear sequences honored |
| `ADC` | `STM32AdcF1` (`adc.ts`) | ADCv1 ADON/SWSTART → EOC poll, `SQR3` channel select, `setChannel` injection, EOC IRQ |
| `SPI` | `STM32SpiG0` (reused) | SPIv1 SR/DR layout is family-generic |
| `TIM` | `STM32TimG0` (reused) | TIMx counting/PWM/UIF layout is family-generic |

The F1 SVD (`lib/sim/svd/stm32f1.ts`) declares the matching instances (AFIO,
EXTI, ADC1, SPI1/2, I2C1/2, TIM1–4, USART1–3, GPIOA–E). `STM32Runner.setAnalog`
and `attachI2CDevice` are duck-typed (`setChannel`/`attach`) so both the F1 and
G0 models work. Covered by `lib/__tests__/mcu-peripherals-f1.test.ts` (incl. a
full I2C write-then-read register round-trip); the F103/unicorn integration test
still passes with the expanded SVD.

## F1 HAL corpus (real-firmware proof)

`fixtures/stm32f1-corpus/` mirrors the G0 corpus for F103: each `m_*.c` is a real
STM32Cube HAL program compiled for `bluepill_f103c8` (`build.sh`), committed as a
`.bin`. `stm32f1-stress.test.ts` runs them on the unicorn ARMv7-M core with the
F1 models and asserts real behavior: PC13 blink, USART1 `UART-OK`, **HAL_ADC**
reads an injected channel-0 sample, **HAL_SPI_Transmit** clocks out every byte,
and **HAL_I2C_Mem_Read** reads an attached `MPU6050`'s WHO_AM_I (`0x68`) — with a
missing device yielding a HAL error, not a hang. Programs are `HAL_Delay`-free
(see the NVIC limit below).

### Bit-band support (unblocked real F1 HAL)

Real F1 HAL/CMSIS uses Cortex-M **bit-banding** (e.g. RCC flag ops), which the
unicorn host didn't map — firmware faulted (`WRITE_UNMAPPED`) the instant it
booted. `UnicornArmHost` now maps the peripheral (`0x42000000`) and SRAM
(`0x22000000`) bit-band aliases and bridges them: a bit-band access is a
**word-granular read-modify-write through the bus**, so register side effects
(e.g. RCC mirroring PLLON→PLLRDY) still run. This is what made the F1 HAL corpus
boot at all.

## Known limits / remaining

- **NVIC on unicorn-arm:** Unicorn v1.0 has no Cortex-M exception entry, so on the
  F1/unicorn path peripheral IRQs/SysTick-IRQ don't vector — STM32duino `delay()`
  and `HAL_Delay()` busy-wait (frozen `HAL_GetTick`). Polling drivers run (the
  corpus is `HAL_Delay`-free). The G0/cortex-m0 path has a real NVIC.
  (Task: vector NVIC in `UnicornArmHost`.)
- **Live browser run: done** (`e2e/stm32-simulation.spec.ts`). Needs the PlatformIO
  `ststm32` Arduino framework installed; the spec skips if the build can't compile.
- **EXTI auto-routing:** EXTI is driven via `triggerLine()` (tests/wiring) rather
  than auto-fired from GPIO input edges through AFIO `EXTICR` — same as the G0 path.
- Richer STM32 component wiring (I2C displays/sensors), a DMA model, and more
  SVDs/boards remain.

> Related: [unicorn-arm-core.md](./unicorn-arm-core.md),
> [stm32-m0-core.md](./stm32-m0-core.md),
> [multi-mcu-architecture-plan.md](./multi-mcu-architecture-plan.md).
