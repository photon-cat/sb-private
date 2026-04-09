# Importing Wokwi Projects into SparkBench

SparkBench is intentionally **diagram-format compatible** with Wokwi: a `diagram.json` file copied from Wokwi will load directly. Sketches and custom chips also use the same C APIs. This document explains what works out of the box, where SparkBench diverges, and how to translate the gaps.

## TL;DR — copy/paste workflow

For a typical Wokwi project:

1. Create `projects/<slug>/` and copy in `diagram.json`, `sketch.ino`, and any `*.chip.c` / `*.chip.json` pairs.
2. Open the project in SparkBench, hit Build & Run.
3. If a part isn't supported, check the divergence table below for an adapter or workaround.

For the official Wokwi CLI, also drop in a `wokwi.toml` and run `wokwi-cli .` — see [docs/local-dev.md](local-dev.md) and `scripts/oracle-test.ts` for cross-comparing both simulators on the same firmware.

## What is compatible

| Concept | Wokwi | SparkBench | Notes |
|---|---|---|---|
| `diagram.json` schema | v1 | v1 | Same fields: `version`, `parts`, `connections` |
| Connection format | `["partA:pin", "partB:pin", color, []]` | identical | Bend points (4th element) currently ignored by SparkBench wiring |
| Part type strings | `wokwi-arduino-uno`, `wokwi-led`, etc. | identical | All `wokwi-*` and `chip-*` prefixes accepted |
| Pin names | `uno:13`, `uno:A0`, `uno:GND.1`, `pot:SIG` | identical | `.1`, `.l`, `.r` suffixes stripped via the same rules |
| `sketch.ino` | Arduino C/C++ via avr-gcc | Arduino C/C++ via PlatformIO/avr-gcc | Same toolchain, same headers, same libraries |
| Custom chip C API | `wokwi-api.h` (`pin_init`, `pin_watch`, `pin_adc_read`, `pin_dac_write`, `attr_init`, `timer_*`) | same header, compiled by `wokwi-cli chip compile` | SparkBench *uses the official wokwi-cli compiler* — any chip that compiles for Wokwi compiles here |
| Custom chip pin layout | `<name>.chip.json` `{name, pins, controls?}` | identical schema (`lib/chip-json.ts`) | Pin order maps directly to the rendered DIP layout |
| Boards (AVR) | Uno, Nano, Mega, Leonardo, Pro Mini, ATmega328P bare | same set | Compiled via PlatformIO `atmelavr` platform |

## Verified examples

- **`projects/inverter-demo/`** — minimal 4-pin inverter chip. Demonstrates `pin_init`, `pin_watch`, `pin_write`. Headless test: `npx tsx scripts/test-chip.ts inverter-demo`.
- **`projects/cd4051-mux/`** — 8-channel analog multiplexer. Demonstrates `pin_adc_read`, `pin_dac_write`, `timer_init/timer_start`. The chip reads pot voltages and forwards them to the MCU's A0 ADC channel. Mirrors Wokwi project [343522915673702994](https://wokwi.com/projects/343522915673702994).

Both can be cross-validated against the official Wokwi simulator with `scripts/oracle-test.ts` once `WOKWI_CLI_TOKEN` is set.

## Known divergences

These are gaps where importing a Wokwi project will fail or partially work, plus the recommended workaround.

### 1. Display parts that aren't yet wired

| Part | Wokwi | SparkBench | Workaround |
|---|---|---|---|
| `wokwi-ssd1306` | full I2C/SPI rendering | I2C-only, full rendering (`lib/ssd1306-controller.ts`) | works as-is |
| `wokwi-lcd1602` / `wokwi-lcd2004` | full I2C/parallel rendering | **not implemented** | replace with `wokwi-ssd1306` for visual feedback, or use `Serial.print` for headless verification |
| `wokwi-neopixel-*` strips | full rendering | **not implemented** | use a custom chip that mimics the WS2812 protocol, or remove from diagram |
| `wokwi-7segment` | full rendering | digit logic only | typically works for shift-register driven displays |

### 2. Sensors with rich models

SparkBench implements DHT22, MPU6050, BMP180, DS18B20, NTC, HX711, motion sensor, clock generator, and pots. Other sensors (`wokwi-bh1750`, `wokwi-lis3dh`, `wokwi-bmp280`, `wokwi-soil-moisture`, etc.) currently have **no I2C model** — the part appears in the diagram but the bus stays silent. Workarounds:

- **Port the sensor** by adding a class to `lib/i2c-bus.ts` and registering it in `wire-components.ts`. Pattern: see `BMP180Controller` in `lib/bmp180-controller.ts`.
- **Replace with a custom chip** authored in C — write a `<sensor>.chip.c` that talks I2C via... (see next section).
- **Stub via Serial** — comment out the sensor and hard-code values in the sketch for testing.

### 3. I2C / SPI / UART from custom chips

The Wokwi C API exposes `i2c_init`, `spi_init`, `uart_init`. SparkBench's `chip-runtime.ts` currently **stubs** these — a custom chip that needs to act as an I2C peripheral or master will instantiate but its bus calls become no-ops. This affects ports of any sensor chip written in C.

**Roadmap**: bridge `i2c_init` to a virtual bus that connects to the MCU's `AVRTWI`, mirroring how `BMP180Controller` registers itself. Tracked separately.

### 4. Connection bend points and labels

`diagram.json` connections may include a 4th element with manhattan bend coordinates (`[..., color, [["v", 64], ["h", -32], ...]]`). SparkBench currently ignores these in simulation — wires are drawn straight in the canvas. The simulation is unaffected; only the visual layout differs.

### 5. `tiny:*` and other orphaned references

Some Wokwi projects (often remixes from ATtiny → Uno) have leftover connections referencing parts that no longer exist (`tiny:PA0`, `nano-2:D2`). SparkBench's wiring code silently drops unresolved refs — the sim runs fine, but a few wires "go nowhere". Run `lib/diagram-parser` validation or just remove the dead refs from the JSON.

### 6. ESP32 / Raspberry Pi Pico

| Board family | Wokwi | SparkBench |
|---|---|---|
| `esp32-*` (S3, C3, etc.) | full Renode-based sim | **compile only** — firmware builds and can be downloaded, but no in-browser simulation. Use the standalone `espwebemu` tool or flash via Web Serial. |
| `pi-pico`, `pi-pico-w` | Renode | not supported — diagram loads, sim refuses to start |
| `attiny85` | full | partial — toolchain available, AVR core simulated, but ATtiny-specific peripherals are not modeled |

For ESP32 projects, the typical port path is: import the diagram, build the firmware, download the `.bin` from the Build button, flash with Web Serial.

### 7. Chip controls and runtime UI knobs

`<name>.chip.json` may declare `controls: [{id, label, type, min, max, step}]`. Wokwi renders these as draggable sliders/dials in the simulation pane. SparkBench currently:

- **parses and stores** the controls (`lib/chip-json.ts`)
- **exposes them at runtime** via `CustomChipRuntime.setAttr(name, value)`
- **does not yet render them in the UI** — you can drive controls programmatically from a scenario file or test, but there's no slider widget. Tracked.

## Translation strategy: how to import any Wokwi project

When you copy a Wokwi project that uses unsupported parts, choose one of three strategies:

### Strategy A — Direct copy (works for ~70% of projects)

If the project uses only AVR boards + supported parts (LED, pots, buttons, switches, resistors, SSD1306, DHT22, MPU6050, BMP180, servo, NTC, HX711, ky-040, motion sensor, 74HC595, 74HC165, custom chips), just copy the files and run.

### Strategy B — Custom chip adapter

For an unsupported sensor or display, write a small custom chip in C that wraps the missing behavior. This is the cleanest path because the chip is **authored once** and reusable across projects, and it uses the official Wokwi C API so it's portable back to wokwi.com.

```c
// Example: a fake light sensor returning a value driven by a control knob.
#include "wokwi-api.h"
#include <stdlib.h>

typedef struct { pin_t out; uint32_t lux_attr; } sensor_t;

static void on_tick(void *user_data) {
  sensor_t *s = (sensor_t *)user_data;
  float lux = (float)attr_read(s->lux_attr);
  pin_dac_write(s->out, (lux / 1000.0f) * 5.0f);
}

void chip_init(void) {
  sensor_t *s = malloc(sizeof(sensor_t));
  s->out = pin_init("OUT", ANALOG);
  s->lux_attr = attr_init("lux", 250);
  const timer_config_t cfg = { .user_data = s, .callback = on_tick };
  timer_t t = timer_init(&cfg);
  timer_start(t, 10000, true);
}
```

### Strategy C — Native peripheral

For sensors that are used in many projects (LIS3DH, BMP280, ADS1115), it's worth adding native I2C support in `lib/wire-components.ts` and a controller in `lib/<sensor>-controller.ts`. This is faster at runtime than a WASM chip and avoids the WASI overhead. Pattern:

1. Implement `I2CDevice` interface (see `lib/ssd1306-controller.ts`)
2. Register in `wire-components.ts` next to the existing sensor branches
3. Add a test in `lib/__tests__/<sensor>-sim.test.ts`

## Cross-validation with Wokwi (oracle testing)

`scripts/oracle-test.ts` runs the *same* compiled firmware on both SparkBench's avr8js and the official `wokwi-cli`, captures serial from each, and diffs them line by line. This is how you confirm that SparkBench's simulation is faithful for a given project, and it's also how to identify divergences when a port misbehaves.

```bash
export WOKWI_CLI_TOKEN=...   # free token from https://wokwi.com/dashboard/ci
npx tsx scripts/oracle-test.ts cd4051-mux --timeout 5000
```

Currently the oracle script handles digital + analog projects; adding support for chips would just need passing `chipConfigs` into both branches (the SparkBench side already has `runScenarioAsync`).

## Filing gaps

When you find a Wokwi project that doesn't import cleanly, please open an issue with:

- Link to the original Wokwi project
- The failing part type(s)
- A minimal `diagram.json` reproducing the gap

This is the input we use to prioritize Strategy B (chip adapters) vs Strategy C (native peripherals).
