# SparkBench MCP — User Guide

Drive a SparkBench hardware simulation from your AI assistant. Connect once, then
ask in plain English to compile firmware, run the simulation, read pins and serial,
screenshot displays, twiddle knobs and buttons, and even cross-check against the
official Wokwi simulator — your assistant calls the right tools for you.

> This is the **user** guide. For the full tool/parameter reference and internals,
> see [mcp.md](./mcp.md).

## What you can do

- **Run a project**: compile and start the sim, step it forward, restart it.
- **See what's happening**: read serial output, read any pin, take a screenshot
  of an OLED / LCD / TFT, or pull the raw display buffer.
- **Interact**: turn switches on/off, press buttons, set a potentiometer,
  feed sensor values (temperature, pressure, accel/gyro), rotate an encoder.
- **Go further**: compile a custom chip from C or Verilog, visually diff two
  screenshots, or run the project through SparkBench *and* Wokwi and diff them.

Works across **Arduino/AVR, STM32, and RP2040** projects — the same tools, any board.

## Connect

Each server instance is pointed at **one project folder** (a directory with
`diagram.json` + `sketch.ino`).

### Claude Code

```bash
claude mcp add sparkbench -- npx tsx /ABS/PATH/sb-private/scripts/sparkbench-mcp.ts projects/rp2040-i2c
```

### Claude Desktop

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sparkbench": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/sb-private/scripts/sparkbench-mcp.ts", "projects/rp2040-i2c"],
      "cwd": "/ABS/PATH/sb-private"
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sparkbench": {
      "command": "npx",
      "args": ["tsx", "scripts/sparkbench-mcp.ts", "projects/rp2040-i2c"]
    }
  }
}
```

Restart the client after editing config. You should see a `sparkbench` server with
its tools available.

## Your first session

Just talk to your assistant. For example:

> **"Start the simulation, run it for one second, and show me the serial output."**

Behind the scenes it calls `start_simulation` → `run_ms` → `read_serial`.

> **"Take a screenshot of the OLED."**

It calls `list_parts` to find the display, then `take_screenshot` — and the PNG
renders inline in the chat.

> **"Turn the potentiometer to 75% and run another 500 ms. Did pin GP15 go high?"**

It calls `set_control` (position 0.75) → `run_ms` → `read_pin`.

There's also a built-in starter prompt named **`sparkbench_explore`** that walks
the assistant through inspecting and running the loaded project end to end.

## Common requests → what happens

| You ask… | Tool(s) used |
|---|---|
| "What's on this board?" | `list_parts` (+ read the `diagram.json` / `sketch.ino` resources) |
| "Start it / stop it / reset it" | `start` / `stop` / `restart_simulation` |
| "Run for N ms" | `run_ms` |
| "What's on serial?" / "Send `AT\r\n`" | `read_serial` / `write_serial` |
| "Is pin 13 / GP15 / the LED high?" | `read_pin` (by pin name, or by part) |
| "Press the button / set the pot / rotate the encoder" | `set_control` |
| "Screenshot the display" | `take_screenshot` |
| "Compile this chip for me" | `compile_chip` |
| "Do these two screenshots match?" | `diff_screenshots` |
| "Does SparkBench agree with real Wokwi?" | `oracle_compare` |

## Setting controls

`set_control` understands these controls (your assistant maps natural language onto them):

- `state` — switch on/off (`true`/`false`)
- `pressed` — button or encoder button down/up
- `position` — potentiometer / slider, `0.0`–`1.0`
- `temperature`, `humidity`, `pressure` — sensor values
- `accel`, `gyro` — IMU values, as `"x,y,z"`
- `rotate-cw`, `rotate-ccw` — encoder detents (a count)

## Optional features & setup

Some tools need extra tooling. They fail with a **clear message** when it's missing,
so nothing breaks — they just won't run until set up:

- **`oracle_compare`** (SparkBench vs Wokwi, AVR projects): needs the `wokwi-cli`
  binary and a `WOKWI_CLI_TOKEN` (free at <https://wokwi.com/dashboard/ci>).
- **`compile_chip`**: C chips need `wokwi-cli`; Verilog chips need Verilator +
  the WASI-SDK.

## Troubleshooting

- **"No simulation running"** — call/ask to *start the simulation* first. Most
  tools need a running sim; `list_projects`, `build_firmware`, `compile_chip`,
  `diff_screenshots`, and reading the project file resources don't.
- **Build is slow the first time** — `start_simulation` compiles firmware via
  PlatformIO; the first compile for a board pulls its toolchain.
- **RP2040 serial looks empty** — RP2040 USB-CDC isn't captured headless; use a
  UART sketch or check pins with `read_pin`.
- **Switching projects** — ask to *start `<slug>`*; `start_simulation` accepts a
  different project path or a slug in the same projects folder.

## Try it without a client

```bash
# Protocol/tool surface only (fast, no compile)
npm run mcp:smoke-test

# Full flow: compile + run + screenshot
npx tsx scripts/mcp-smoke-test.ts rp2040-i2c --full
```

> See also: [mcp.md](./mcp.md) (reference) ·
> [headless-multi-mcu-cli.md](./headless-multi-mcu-cli.md) (the simulator behind it).
