# Headless multi-MCU CLI + scenario path

The SparkBench CLI (`sparkbench simulate` / `sparkbench test`) and the YAML
scenario runner used to be **AVR-only** — they took an Intel HEX and built an
`AVRRunner`. They now run **AVR, STM32 (F1 via unicorn.js, G0 via CortexM0Host)
and RP2040 (rp2040js)** through one unified abstraction.

## The unification: `HeadlessMcu`

`lib/sim/headless-mcu.ts` defines one interface over the three runners and a
`createHeadlessMcu({ simCore, hex|bin, diagram, target, clockHz, chipConfigs })`
factory. Each adapter owns its core's quirks:

| | AVR (`avr8js`) | STM32 (`unicorn-arm`/`cortex-m0`) | RP2040 (`rp2040`) |
|---|---|---|---|
| runner | `AVRRunner` | `STM32Runner` | `RP2040Runner` |
| firmware | `.hex` | `.bin` | `.uf2` |
| serial out | `usart.onByteTransmit` | `onSerialByte` | `onSerialByte` (UART0 + USB CDC) |
| serial in | `usart.writeByte` | — (throws) | `feedUart` |
| pin read | `getPort().pinState` | `pinState(port,pin)` | `gpioState(pin)` |
| pin name | `13`/`A0`/`PB5` | `PC13` | `GP15`/`15` |
| wiring | `wireComponents` | `wireComponentsStm32` | `wireComponentsRp2040` |
| clock | 16 MHz | F1 72 / G0 16 MHz | 125 MHz |

`HeadlessMcu` exposes `runCycles/runMs/clockHz/cycles`, serial
(`serial/clearSerial/sendSerial/addSerialListener/injectSerial`), `pinHigh(name)`
and the shared `wired` component map.

## What routes through it

- **`createSimulation` (sync, AVR)** is unchanged for back-compat; **`createSimulationAsync`**
  (`lib/sim/simulation-runner.ts`) builds any core via `HeadlessMcu`.
  `sparkbench simulate` uses it.
- **`runScenario` (sync, AVR)** stays; **`runScenarioAsync`** accepts a
  `ScenarioFirmware` (a hex string *or* `{simCore, hex|bin}`) and runs any core.
  `executeStep` is MCU-agnostic (operates on a small `StepHost` slice), so every
  step type — `wait-serial`, `expect-serial`, `set-control`, `expect-display`,
  `expect-pin`, `send-serial`, `clear-serial` — works across all three.
- **`buildFirmware`** (`lib/sim/firmware-builder.ts`) now picks the PlatformIO
  platform/framework by board and returns `{hex, bin, simCore}` — reading
  `firmware.hex` (AVR), `firmware.bin` (STM32) or `firmware.uf2` (RP2040). AVR
  base libs are only seeded for AVR targets.
- **The web build route** (`app/api/.../build/route.ts`) compiles `pico` too
  (`raspberrypi`/arduino → `.uf2`) and returns `simCore: "rp2040"`.

## Verified

- **AVR** — `sparkbench test combo-safe` passes: serial waits, SSD1306 display
  assertions, rotary-encoder controls and a custom WASM chip, all at 16 MHz.
- **STM32 F1** — `sparkbench test stm32-blink` passes: `expect-pin PC13`
  HIGH→LOW→HIGH on the unicorn.js core @ 72 MHz.
- **RP2040** — `sparkbench test rp2040-blink` passes: `expect-pin GP15`
  HIGH→LOW→HIGH on rp2040js @ 125 MHz (real mbed-compiled sketch).
- Unit regression: `lib/__tests__/rp2040-headless.test.ts` (GP25 toggles +
  adapter wiring), `sim-core.test.ts` (RP2040 routing). Full suite: 402 pass.

## RP2040 I/O coverage

The RP2040 wiring (`lib/wire-components-rp2040.ts`) covers the full practical I/O
set (everything except Wi-Fi, which rp2040js doesn't model):

| Class | Parts | How |
|---|---|---|
| Digital out | LED, buzzer | `watchGpio` |
| Digital in | pushbutton | `setGpioInput` (pull-up) |
| Analog in | potentiometer, slide-pot | `setAdcChannel` (GP26-29 → ADC0-3, 12-bit) |
| PWM out | servo, tone/buzzer | PWM drives `gpio[n]`; `Rp2040ServoSimulator` measures pulse width |
| I2C | SSD1306, LCD1602/2004, MPU6050, BMP180 | `Rp2040I2CBridge` (RPI2C → avr8js `TWIEventHandler`) |
| SPI | ILI9341 TFT | `attachSpiHandler` (CS/DC gated) |
| Encoder | KY-040 | `Rp2040EncoderSimulator` (quadrature via clock alarms) |
| UART | Serial1 / UART0 | byte capture + `feedUart` RX |

The **I2C bridge is the key reuse**: the SSD1306/LCD1602/MPU6050/BMP180 controllers
are written against avr8js's `TWIEventHandler` (firmware = master, controller calls
`twi.complete*()`). `Rp2040I2CBridge` (`lib/rp2040-i2c-bridge.ts`) translates
rp2040js's RPI2C master callbacks the other direction, so the **same controllers
run unchanged on AVR and RP2040**. A device is bound to the single bus its SDA/SCL
pins select (I2C alternates every 2 GP pins, SPI every 8: `floor(gp/groupSize) % 2`).

Verified via the CLI with real mbed-compiled firmware:
- `sparkbench test rp2040-adc` — pot → `analogRead(GP26)` → LED threshold (analog path).
- `sparkbench test rp2040-i2c` — `Wire.endTransmission(0x3C)` ACKs through the bridge → LED.
Plus `lib/__tests__/rp2040-io.test.ts` (bridge routing against a real SSD1306
controller, servo pulse→angle, encoder quadrature, ADC pin mapping).

Not yet wired on RP2040: DHT22 one-wire and 74HC595/74HC165 shift registers
(bit-bang sims still AVR-coupled — a future port); Pico W Wi-Fi (CYW43, not in
rp2040js).

## The RP2040 clock-tick fix

The headline RP2040 bug: `RP2040Runner.runCycles` called `mcu.step()` in a loop
but **never advanced rp2040js's `SimulationClock`**. The 64-bit TIMER is driven by
that clock, so `sleep_ms()`/`busy_wait()` never returned — firmware spun forever
in clock init (PC pinned at `0x100098f8`) and no GPIO ever toggled. The existing
"capability test" only checked that cycles advanced, so it never caught this.

`runCycles` now mirrors rp2040js's `Simulator.execute()`: each instruction ticks
the clock by `cycles × (1e9 / clockHz)`, and WFI/WFE fast-forwards to the next
alarm. With that, real pico-sdk/mbed firmware boots and blinks.

## Known limits

- **RP2040 USB-CDC serial** isn't reliably captured headless (it needs USB host
  enumeration) — prefer `expect-pin` or UART for RP2040 scenarios.
- **STM32 `send-serial`** isn't supported yet (no USART RX feed on `STM32Runner`).
- **Browser RP2040 sim** isn't wired into `useSimulation` yet (the web build
  compiles `pico` and offers the `.uf2`; live in-browser RP2040 is a follow-up —
  `RP2040Runner` already runs in the browser).

> Related: [unicorn-arm-core.md](./unicorn-arm-core.md),
> [stm32-frontend-and-phase5.md](./stm32-frontend-and-phase5.md),
> [multi-mcu-architecture-plan.md](./multi-mcu-architecture-plan.md).
