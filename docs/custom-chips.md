# Wokwi Custom Chips — API Support

SparkBench runs **real Wokwi custom chip projects**: a `<name>.chip.json` + `<name>.chip.c`
pair, compiled to WASM by the official `wokwi-cli chip compile`, instantiated by
`lib/chip-runtime.ts` and bridged to the avr8js simulation. The WASM ABI is the
authoritative Wokwi one (camelCase import names like `pinInit`, `spiInit`; the C
`wokwi-api.h` maps snake_case → camelCase via `import_name` attributes).

## Supported API surface

| Group | Functions | Status |
|---|---|---|
| GPIO | `pin_init`, `pin_mode`, `pin_read`, `pin_write` | ✅ |
| Pin watch | `pin_watch`, `pin_watch_stop` (RISING/FALLING/BOTH) | ✅ |
| Analog | `pin_adc_read`, `pin_dac_write` (heuristic: pots, MCU ADC rails) | ✅ |
| Timers | `timer_init`, `timer_start`, `timer_start_ns`, `timer_stop` | ✅ |
| Time | `get_sim_nanos` | ✅ |
| Attributes | `attr_init`, `attr_init_float`, `attr_read`, `attr_read_float` | ✅ |
| String attrs | `attr_string_init`, `string_get_length`, `string_read` | ✅ |
| I2C | `i2c_init` (slave devices on the shared TWI bus) | ✅ |
| **SPI** | `spi_init`, `spi_start`, `spi_stop` (slave; bridged to `AVRSPI`) | ✅ |
| **UART** | `uart_init`, `uart_write` (bridged to MCU USART on D0/D1) | ✅ |
| **Framebuffer** | `framebuffer_init`, `buffer_read`, `buffer_write` | ✅ |
| printf | via WASI `fd_write` → simulation serial log | ✅ |
| Experimental MCU access | `_mcu_read_*`, `_symbol_resolve`, `_mcu_monitor_sp` | ⛔ stubbed |

## How the framework bridges work

- **SPI** — the AVR is master, the chip is a slave. `spi_start(buf, count)` arms the
  chip with its outgoing MISO bytes. When the MCU clocks a byte, `AVRSPI.onByte`
  fires; the armed chip returns its buffer byte as MISO and records the received
  MOSI. After `count` bytes the buffer (now holding received data) is written back
  to WASM memory and the chip's `done` callback fires. Handlers chain, so multiple
  SPI chips coexist as long as only one is CS-selected (armed) at a time. With no
  chip armed, avr8js's default completes the transfer (MISO 0).
- **UART** — bridged to the MCU hardware USART **only** when the chip's `rx`/`tx`
  pins are wired to the MCU serial pins (D1=TX/PD1, D0=RX/PD0). MCU transmit →
  chip `rx_data`; `uart_write` → MCU RX. The existing `onByteTransmit` is chained so
  serial capture keeps working. Chips wired elsewhere are registered but inert
  (software-serial bridging is future work).
- **Framebuffer** — `framebuffer_init` allocates an RGBA buffer of the chip's
  requested dimensions; `buffer_write`/`buffer_read` move pixels. Exposed via
  `CustomChipRuntime.getFramebuffer()` for display rendering.

## Displays & screenbuffer capture

Display content is exposed as an **RGBA framebuffer** that tests and the CLI can
read, for three kinds of display:

- **Custom chips** via `framebuffer_init` — `CustomChipRuntime.getFramebuffer()`.
  Dimensions come from the chip.json `display: { width, height }` (the simulator
  writes them into the `framebuffer_init` pointers per the Wokwi ABI). Pixels are
  RGBA, `width*height*4` bytes.
- **ILI9341** SPI TFT (`wokwi-ili9341`, `lib/ili9341-controller.ts`) — decodes the
  4-wire SPI stream (DC pin = command/data), handling CASET/PASET/RAMWR and
  RGB565→RGBA. Wired CS-gated onto `runner.spi`.
- **SSD1306 / LCD1602** — existing controllers, with PNG renderers in
  `lib/display-renderer.ts`.

Capture in tests via the `expect-display` scenario step:

```yaml
- expect-display: { part-id: tft, not-blank: true }
- expect-display: { part-id: tft, min-filled: 4 }          # ≥N non-black pixels
- expect-display: { part-id: tft, pixel: { x: 0, y: 0, rgba: [255, 0, 0, 255] } }
```

Capture to PNG via the CLI: `sparkbench simulate <proj> --screenshot-part <id>
--screenshot-time <ms> --screenshot-file out.png` — works for SSD1306, LCD1602,
ILI9341, and any custom-chip framebuffer.

## Verified end-to-end

Real wokwi-cli-compiled chips, run through the full compile → simulate pipeline:

- `projects/inverter-demo` — pin watch + write
- `projects/i2c-chip-demo` — I2C slave
- `projects/spi-chip-test` — SPI slave (proves bidirectional MISO/MOSI)
- `projects/uart-chip-test` — UART echo over hardware serial
- `projects/lcd-chip-test` — custom-chip 16×2 character LCD via framebuffer (screenbuffer asserted)
- `projects/ili9341-test` — ILI9341 SPI TFT, RGB565 pixels decoded and asserted

Fast unit coverage of the bridges (no toolchain) lives in
`lib/__tests__/chip-runtime.test.ts`.

## Not yet supported

- The experimental MCU-introspection API (`_mcu_read_memory`, etc.).
- Software-serial UART (chip UART wired to arbitrary GPIO rather than D0/D1).
- Software-serial UART (chip UART wired to arbitrary GPIO rather than D0/D1).

SystemVerilog/Verilog chips (`.chip.sv` / `.chip.v`) **are** supported via Verilator —
see [verilog-chips.md](./verilog-chips.md). VHDL is not.
