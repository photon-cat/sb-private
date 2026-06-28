# SparkBench MCP server

A standalone **stdio MCP server** that lets external AI clients (Claude Desktop,
Claude Code, Cursor, any MCP host) drive the SparkBench headless simulator:
compile a project, step the simulation, inspect serial / pins / displays, and
drive controls — across **AVR, STM32 and RP2040**, all through the unified
`SimSession` → `HeadlessMcu` path.

> Unlike the in-app Sparky MCP tools (`app/api/chat/route.ts`, bound to the
> browser SSE stream), this server speaks the standard MCP stdio protocol and is
> reachable from any external client.

> **New here?** Start with the [user guide](./mcp-quickstart.md) — connecting
> and example conversations. This page is the full reference.

## Run it

```bash
# via the CLI subcommand (resolves a bare slug under projects/)
npm run sparkbench -- mcp rp2040-i2c

# or directly, with a project directory
npx tsx scripts/sparkbench-mcp.ts projects/rp2040-i2c

# or via SPARKBENCH_PROJECT_DIR (some clients pass env only)
SPARKBENCH_PROJECT_DIR=projects/rp2040-i2c npm run mcp
```

The server is scoped to **one project directory** (must contain `diagram.json` +
`sketch.ino`). stdout carries the MCP protocol; all logging goes to stderr.

## Tool surface

All tools are prefixed `sparkbench_`. Where wokwi-cli mcp has an analog the
semantics match, so configs can be swapped.

| Tool | Input | Returns | Wokwi analog |
|---|---|---|---|
| `sparkbench_list_projects` | — | projects next to the server's project | ❌ |
| `sparkbench_start_simulation` | `{projectPath?}` | compiles firmware + starts sim; status | `wokwi_start_simulation` |
| `sparkbench_stop_simulation` | — | stops (stays loaded) | `wokwi_stop_simulation` |
| `sparkbench_restart_simulation` | — | resets to power-on (no recompile) | `wokwi_restart_simulation` |
| `sparkbench_run_ms` | `{ms}` | `{cyclesRun, timeMs, serialAppended}` | ❌ (lets an agent step the sim) |
| `sparkbench_get_status` | — | core, board, clock, cycles, time, parts | `wokwi_get_status` |
| `sparkbench_read_serial` | `{clear?}` | serial text | `wokwi_read_serial` |
| `sparkbench_write_serial` | `{text}` | bytes sent (not on STM32) | `wokwi_write_serial` |
| `sparkbench_read_pin` | `{pin, partId?}` | `{state, high, voltage, mcuPin}` | `wokwi_read_pin` |
| `sparkbench_set_control` | `{partId, control, value}` | ok / error | `wokwi_set_control` |
| `sparkbench_list_parts` | — | all parts + which expose a display | ❌ |
| `sparkbench_read_display_buffer` | `{partId}` | raw GDDRAM / chars / RGBA (base64) | ❌ |
| `sparkbench_take_screenshot` | `{partId}` | **MCP `image` block, full base64 PNG** | `wokwi_take_screenshot` (broken there) |
| `sparkbench_build_firmware` | `{projectPath?}` | compile-only: board, core, sizes | ❌ |
| `sparkbench_compile_chip` | `{name, source, language?}` | compiles a C/Verilog chip to wasm (base64) | ❌ |
| `sparkbench_diff_screenshots` | `{pngA, pngB, threshold?, includeDiffImage?}` | match/diffPixels + diff PNG | ❌ |
| `sparkbench_oracle_compare` | `{projectPath?, timeoutMs?}` | **runs SparkBench + Wokwi and diffs serial** | ❌ |

`read_pin` takes either a board-native pin — `13`/`A0`/`PB5` (AVR), `PC13`
(STM32), `GP15` (RP2040) — or a part's pin via `partId` (resolved through the
diagram to the MCU GPIO it's wired to, matching `wokwi_read_pin`'s `{partId, pin}`).

`set_control` controls: `state` (switch), `pressed` (button/encoder),
`position` (pot, 0.0–1.0), `temperature`, `humidity`, `pressure`,
`accel`/`gyro` (`"x,y,z"`), `rotate-cw`/`rotate-ccw` (detent count).

## Wokwi parity

Verified against the live `wokwi-cli mcp` surface (v0.26.1,
`packages/cli/src/mcp/WokwiMCPTools.ts`). Every non-broken Wokwi tool has an
analog here, plus extras Wokwi has no equivalent for:

- **Matched:** `start`/`stop`/`restart_simulation`, `get_status`, `read_serial`,
  `write_serial`, `read_pin` (`{partId, pin}`), `set_control`, `take_screenshot`.
- **Better here:** `take_screenshot` returns the full base64 PNG (Wokwi truncates
  to 100 chars); `set_control` also accepts boolean/string values; `read_pin`
  also accepts a bare board-native pin.
- **Only here:** `run_ms` (step the sim), `list_projects`, `list_parts`,
  `read_display_buffer` (raw framebuffer), `build_firmware`, `compile_chip`,
  `diff_screenshots`, `oracle_compare`.
- **Wokwi-only, not ported:** `wokwi_resume_simulation` (our `stop` is a hard
  stop; use `restart`), `wokwi_export_vcd` (avr8js has no VCD writer yet).

## Resources

Project files, sandboxed to the project directory:

- `sparkbench://project/diagram.json`
- `sparkbench://project/sketch.ino`
- `sparkbench://project/libraries.txt` (if present)
- `sparkbench://project/test.scenario.yaml` (if present)

## Prompt

`sparkbench_explore` — walks a client through inspecting the circuit, reading the
sketch, starting the sim, stepping, reading serial, and screenshotting a display.

## Client configuration

### Claude Code

```bash
claude mcp add sparkbench -- npx tsx /ABS/PATH/sb-private/scripts/sparkbench-mcp.ts projects/rp2040-i2c
```

### Claude Desktop (`claude_desktop_config.json`)

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

### Cursor (`.cursor/mcp.json`)

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

### Worked example

Ask the client: *"Start the simulation, run for 1 second, read the serial output,
then take a screenshot of the OLED."* The agent calls `start_simulation` →
`run_ms {ms:1000}` → `read_serial` → `take_screenshot {partId:"oled1"}` and gets
a rendered PNG back inline.

## Architecture

```
scripts/sparkbench-mcp.ts   stdio MCP server (tools/resources/prompt)
        │
        ▼
lib/sim/sim-session.ts      SimSession — long-lived sim, imperative stepping
        │
        ▼
lib/sim/headless-mcu.ts     HeadlessMcu — AVR / STM32 / RP2040 behind one API
```

`SimSession.load()` does project load → `buildFirmware` (PlatformIO) +
`buildChips` → `createHeadlessMcu` (wiring). `restart()` re-wires from the
already-built firmware without recompiling. The `set-control` mapping lives in
`lib/sim/controls.ts`, shared with the YAML scenario runner so both drive
components identically.

## Verify

```bash
# Lightweight: protocol surface only (no compile)
npm run mcp:smoke-test

# Full: also compiles firmware, runs the sim, screenshots a display
npx tsx scripts/mcp-smoke-test.ts rp2040-i2c --full

# Unit tests for the session lifecycle
npx vitest run lib/__tests__/sim-session.test.ts
```

## Known limits

- **One session per server process** — clients typically spawn one server per
  project, so this is rarely a constraint.
- **`write_serial` is unsupported on the STM32 core** (no USART RX feed yet).
- **RP2040 USB-CDC serial** isn't captured headless — use UART or `read_pin`.
- **`oracle_compare`** is AVR-only and needs `wokwi-cli` + `WOKWI_CLI_TOKEN`
  in the environment; it degrades to a clear error when either is missing.
- **`compile_chip`** needs `wokwi-cli` for C chips, or Verilator + WASI-SDK for
  Verilog chips; it reports a clear error when the toolchain is missing.
- **`diff_screenshots`** decodes 8-bit RGB/RGBA PNGs only (what our renderers and
  Wokwi emit) — not palette/grayscale/16-bit/interlaced.
- **VCD export** (`wokwi_export_vcd`) isn't ported — avr8js has no VCD writer.

> Related: [headless-multi-mcu-cli.md](./headless-multi-mcu-cli.md).
