# SparkBench MCP Server — Build Plan

A standalone stdio MCP server that lets external AI tools (Claude Desktop, Cursor, Claude Code, VS Code Copilot, LangGraph, etc.) drive SparkBench's simulator, inspect display/GPIO state, compile custom chips, build firmware, and cross-validate against the official Wokwi simulator.

## Context

Today SparkBench's MCP tools live inside `app/api/chat/route.ts` (`createSimulationServer`). They're bound to an SSE stream back to the browser and only reachable from the in-app Sparky agent. There's no way for an external MCP client to talk to SparkBench. Meanwhile Wokwi ships an experimental `wokwi-cli mcp` server with 11 tools, but its `wokwi_take_screenshot` is broken (truncates base64 to 100 chars) and it has no framebuffer-read tool at all.

SparkBench already has:
- A working headless runner (`scripts/sparkbench-run.ts`) with 1:1 wokwi-cli flag parity
- Oracle cross-validation against Wokwi (`scripts/oracle-test.ts`)
- `lib/display-renderer.ts` → PNG from SSD1306 GDDRAM or LCD1602 character buffer
- `@modelcontextprotocol/sdk@^1.26.0` already in `package.json`
- `wireCustomChipsAsync` + `CustomChipRuntime` for live chip runtime state
- PlatformIO build pipeline via `scripts/sparkbench-run.ts`'s `compileFirmware`

So the build is mostly wiring: extract the simulator lifecycle from `sparkbench-run.ts` into a reusable class, expose it as MCP tools, return full-fidelity display content.

## Deliverables

1. `scripts/sparkbench-mcp.ts` — stdio MCP server entry point
2. `lib/sim-session.ts` — long-lived simulator session wrapping AVRRunner + wired components + chip runtimes
3. `sparkbench mcp` subcommand in `scripts/sparkbench-cli.ts`
4. `docs/mcp.md` — usage docs with connection recipes for Claude Desktop, Cursor, Claude Code
5. `lib/__tests__/sim-session.test.ts` — unit tests for the simulator session lifecycle
6. Integration smoke test that connects an MCP client, calls each tool, and asserts results

## Phase 1 — SimSession abstraction (no MCP yet)

**Goal:** a reusable class that owns a long-running simulation so MCP tool calls can drive it imperatively. Currently `sparkbench-run.ts` runs in a tight loop until timeout; for MCP we need to be able to run some cycles, pause, inspect state, run more, etc.

### Files
- `lib/sim-session.ts` (new)
  ```ts
  export class SimSession {
    private runner: AVRRunner;
    private wired: Map<string, WiredComponent>;
    private i2cBus: I2CBus;
    private chipRuntimes: Map<string, CustomChipRuntime>;
    private serialBuffer: string = "";
    private status: "idle" | "running" | "stopped" | "error" = "idle";

    static async load(projectDir: string, opts: { quiet?: boolean }): Promise<SimSession>;
    runMs(ms: number): void;                        // advance simulation N ms
    readSerial(opts?: { clear?: boolean }): string; // drain/read buffer
    writeSerial(text: string): void;                // inject bytes to USART RX
    readPin(partId: string, pin: string): { state: 0|1; voltage: number };
    setControl(partId: string, control: string, value: number): void;
    readDisplayBuffer(partId: string): DisplayBuffer | null;
    takeScreenshot(partId: string): Buffer;         // PNG bytes, full RGBA
    stop(): void;
    restart(): Promise<void>;
    status(): { status: string; cycles: number; timeMs: number };
  }
  ```
- Extract `compileFirmware` + `compileChips` + `wireComponents + wireCustomChipsAsync` from `scripts/sparkbench-run.ts` into `SimSession.load()` so both the CLI runner and the MCP server share one code path.

### Tasks
- [ ] Create `lib/sim-session.ts` with the class skeleton above
- [ ] Move `compileFirmware` from `sparkbench-run.ts` into `lib/firmware-builder.ts` (new); both files import from there
- [ ] Move `compileChips` into `lib/chip-loader.ts` (new); same reason
- [ ] Implement `SimSession.runMs(ms)` using `runner.runCycles(ms * cyclesPerMs)` in small batches (1ms slices) so serial callbacks can fire promptly
- [ ] Implement `SimSession.readPin(partId, pin)` — look up the wired part, resolve pin to an MCU port, return `pinState()` + derived voltage (HIGH=5V, LOW=0V, unless it's a portC ADC channel in which case return the channelValues voltage)
- [ ] Implement `SimSession.setControl` — delegate to the existing `wired.get(partId).setValue/setState/setPressed/...` handlers from `wire-components.ts`
- [ ] Implement `SimSession.readDisplayBuffer` — return typed result: `{type:'ssd1306', width:128, height:64, gddram:Uint8Array(1024)}` or `{type:'lcd1602', cols:16, rows:2, characters:Uint8Array(32)}`
- [ ] Implement `SimSession.takeScreenshot` — reuse `encodeSsd1306Png` / `encodeLcd1602Png` from `lib/display-renderer.ts`
- [ ] Refactor `scripts/sparkbench-run.ts` to use `SimSession` so its behavior is unchanged but the simulator code lives in one place
- [ ] Add `lib/__tests__/sim-session.test.ts` with ≥6 tests covering: load, runMs advances serial, readPin, setControl for pot, readDisplayBuffer for ssd1306/lcd1602, takeScreenshot returns valid PNG bytes
- [ ] Verify `npx tsx scripts/sparkbench-run.ts actuator-test --screenshot-part oled1 --screenshot-time 2500 --screenshot-file /tmp/a.png` still produces the same PNG byte-for-byte

## Phase 2 — MCP server with the tool surface

**Goal:** a stdio MCP server that exposes SparkBench capabilities to external AI clients.

### Files
- `scripts/sparkbench-mcp.ts` (new) — entry point, spawned by clients
- Register `sparkbench mcp <project-dir>` subcommand in `scripts/sparkbench-cli.ts`

### Transport
Use `@modelcontextprotocol/sdk`'s stdio transport. Accept a project directory as the sole positional arg (required), validate it contains `diagram.json` + `sketch.ino`. Log status messages to `stderr` only — `stdout` is the MCP transport.

### Tool surface

All tools are prefixed `sparkbench_`. Where there's a direct analog in `wokwi-cli mcp`, we match the semantics so clients can swap servers.

| Tool | Input schema | Returns | Wokwi analog |
|---|---|---|---|
| `sparkbench_list_projects` | `{}` | `{projects: ProjectMeta[]}` as text | ❌ none |
| `sparkbench_start_simulation` | `{projectPath?: string}` | `{status:"running", hexBytes:N, chips:[...]}` | `wokwi_start_simulation` |
| `sparkbench_stop_simulation` | `{}` | `{status:"stopped"}` | `wokwi_stop_simulation` |
| `sparkbench_restart_simulation` | `{}` | `{status:"running"}` | `wokwi_restart_simulation` |
| `sparkbench_run_ms` | `{ms: number}` | `{cyclesRun, timeMs, serialAppended}` — **no Wokwi analog, lets external agent step the sim** | ❌ none |
| `sparkbench_get_status` | `{}` | `{status, cycles, timeMs, parts:[...]}` | `wokwi_get_status` |
| `sparkbench_read_serial` | `{clear?: boolean}` | text | `wokwi_read_serial` |
| `sparkbench_write_serial` | `{text: string}` | confirmation | `wokwi_write_serial` |
| `sparkbench_read_pin` | `{partId, pin}` | `{state:0|1, voltage:number}` | `wokwi_read_pin` |
| `sparkbench_set_control` | `{partId, control, value}` | confirmation | `wokwi_set_control` |
| `sparkbench_take_screenshot` | `{partId: string}` | **MCP `image` content block with full base64 PNG** — crucially NOT truncated like wokwi's | `wokwi_take_screenshot` (broken) |
| `sparkbench_read_display_buffer` | `{partId: string}` | `{type, width, height, pixels|characters (base64)}` — **raw buffer, no Wokwi equivalent** | ❌ none |
| `sparkbench_compile_chip` | `{name, source}` | `{wasm: base64, size}` | ❌ none (chip is a CLI flag in wokwi, not an MCP tool) |
| `sparkbench_build_firmware` | `{projectPath?, board?}` | `{hex, stderr, durationMs}` | ❌ none |
| `sparkbench_oracle_compare` | `{projectPath?, timeoutMs?}` | `{match:bool, details, sparkbenchSerial, wokwiSerial}` — **runs both simulators and diffs them in one call** | ❌ none |

### Resources

Expose these as MCP `resources/list` + `resources/read` so clients can pull project files without path-traversal risk:

- `sparkbench://project/diagram.json`
- `sparkbench://project/sketch.ino`
- `sparkbench://project/libraries.txt` (if present)
- `sparkbench://project/*.chip.c` and `*.chip.json` (enumerated)
- `sparkbench://project/test.scenario.yaml` (if present)

All paths are sandboxed to the project directory passed at server start.

### Prompts

Include one starter `sparkbench_explore` prompt that walks an AI through: list parts, read sketch, start simulation, step 1000ms, read serial, take screenshot of any display. Helps new clients get oriented.

### Tasks
- [ ] Scaffold `scripts/sparkbench-mcp.ts` with `createServer()` from `@modelcontextprotocol/sdk`
- [ ] Wire stdio transport via `StdioServerTransport`
- [ ] Instantiate a single `SimSession` at server start; all tools operate against it
- [ ] Register the 15 tools above with Zod schemas for inputs
- [ ] Implement `sparkbench_take_screenshot` to return `{ type: "image", data: base64, mimeType: "image/png" }` — the content type that MCP clients actually render
- [ ] Implement `sparkbench_read_display_buffer` using `SimSession.readDisplayBuffer` and base64-encode the raw bytes
- [ ] Implement `sparkbench_oracle_compare` by spawning `scripts/oracle-test.ts` as a subprocess and parsing its stdout for `✓ ORACLE MATCH` vs `✗ ORACLE MISMATCH`
- [ ] Register the project-file resources
- [ ] Register the starter prompt
- [ ] Add `sparkbench mcp <project-dir>` subcommand in `scripts/sparkbench-cli.ts` that execs `sparkbench-mcp.ts`
- [ ] Smoke test: run `scripts/sparkbench-mcp.ts projects/cd4051-mux` from a test client (see Phase 4)

## Phase 3 — Interoperability polish

### Tasks
- [ ] Accept the same `--timeout`, `--screenshot-time`, `--quiet` flags as `wokwi-cli mcp` so configs can be swapped between the two
- [ ] Environment variable `SPARKBENCH_PROJECT_DIR` as an alternative to the positional arg (some MCP clients pass env only)
- [ ] Log every tool call to `stderr` in a grep-friendly format for debugging in Claude Desktop logs
- [ ] Add a `sparkbench_diff_screenshots` tool that takes two base64 PNGs, runs pixelmatch, returns `{match, diffPixels, diffPng}` — for cross-sim visual diffing
- [ ] Expose `sparkbench_list_chip_runtimes` returning which custom chips are instantiated and their attribute values (uses `CustomChipRuntime.getAttr`)
- [ ] Cache `compileFirmware` results by sketch hash so repeated `start_simulation` calls are fast

## Phase 4 — Client integration + tests

### Files
- `docs/mcp.md` — how to connect from Claude Desktop, Cursor, Claude Code, generic MCP clients
- `scripts/mcp-smoke-test.ts` — launches `sparkbench-mcp.ts` as a child process, connects via `StdioClientTransport`, calls every tool, asserts return shapes

### Claude Desktop config example
```json
{
  "mcpServers": {
    "sparkbench": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/sb-private/scripts/sparkbench-mcp.ts", "projects/cd4051-mux"],
      "cwd": "/absolute/path/to/sb-private"
    }
  }
}
```

### Claude Code config example
```
claude mcp add sparkbench -- npx tsx /absolute/path/to/sb-private/scripts/sparkbench-mcp.ts projects/cd4051-mux
```

### Cursor config example
`.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "sparkbench": {
      "command": "npx",
      "args": ["tsx", "scripts/sparkbench-mcp.ts", "projects/cd4051-mux"]
    }
  }
}
```

### Tasks
- [ ] Write `docs/mcp.md` with the three config recipes and a worked example ("ask Claude to turn on pin 13 and take a screenshot")
- [ ] Build `scripts/mcp-smoke-test.ts` using `StdioClientTransport` from the SDK; connects, calls `start_simulation`, `run_ms(1000)`, `read_serial`, `take_screenshot(oled1)`, `read_display_buffer(oled1)`, asserts PNG magic bytes and correct buffer lengths
- [ ] Add `npm run mcp:smoke-test` script in `package.json`
- [ ] Run the smoke test in CI (`scripts/ci.sh` or similar)

## Phase 5 — Oracle cross-sim tool

**Goal:** one MCP tool call that runs a project through both simulators and returns the diff — the capability Wokwi doesn't expose at all.

### Tasks
- [ ] `sparkbench_oracle_compare({projectPath, timeoutMs, screenshotPart?})`:
  - Spawns the existing `scripts/oracle-test.ts` as a subprocess
  - Captures both simulators' serial + PNGs
  - Optionally runs `pixelmatch` on the PNGs if `screenshotPart` is provided
  - Returns `{serialMatch, pixelMatch, sparkbenchSerial, wokwiSerial, diffPng?}`
- [ ] Wire up in Phase 2's tool registration
- [ ] Document in `docs/mcp.md`
- [ ] Add a smoke test that runs it against `cd4051-mux`

## Known gaps / defer

- **Multi-session**: Phase 2 only supports ONE active `SimSession` per MCP process. Multi-project concurrency can be added later if needed — MCP clients typically spawn one server per project anyway.
- **Attribute slider tools**: `sparkbench_set_control` can already drive pot values etc., but a dedicated `sparkbench_set_chip_attr(partId, name, value)` would be cleaner for custom chip knobs. Defer until Phase 3.
- **VCD export**: wokwi has `wokwi_export_vcd`; avr8js doesn't have a built-in VCD writer. Defer — would need to hook port listeners and build a VCD timeline.
- **Screenshots of non-display parts**: Wokwi's take_screenshot supports any element (Uno body, LEDs showing their color, etc.). SparkBench would need to rasterize the whole `<wokwi-arduino-uno>` custom element via Puppeteer or headless chromium. Significant effort — defer.
- **Hot-reload**: changing files while the MCP session is live. Defer; restart the server.

## Priority / ordering

1. **Phase 1** (SimSession) — everything else depends on this. ~1 day.
2. **Phase 2** (MCP server with core tools) — the main deliverable. ~1 day.
3. **Phase 4** (smoke tests + docs) — needed before calling it done. ~half day.
4. **Phase 5** (oracle compare tool) — high value differentiator vs wokwi-cli mcp. ~half day.
5. **Phase 3** (polish) — nice-to-haves, ship incrementally.

Total estimated effort: 2-3 focused days.

## Verification checklist

- [ ] `npx vitest run` — 176 existing tests still pass + new sim-session + mcp tests
- [ ] `npx tsx scripts/sparkbench-run.ts actuator-test --timeout 4000 --screenshot-part oled1 --screenshot-time 2500 --screenshot-file /tmp/a.png` — CLI still works after refactor
- [ ] `npx tsx scripts/oracle-test.ts cd4051-mux --timeout 5000` — oracle still matches
- [ ] `npm run mcp:smoke-test` — MCP server passes in-process smoke test
- [ ] Manual: launch Claude Desktop with the sparkbench server configured, ask it to "list projects", "start cd4051-mux", "run for 2 seconds", "take a screenshot of the OLED", "show me the display buffer" — all tools reachable and return usable content
- [ ] Manual: rebuild Claude Code config to add sparkbench, try the same flow in Claude Code CLI
- [ ] Compare `sparkbench mcp` tool surface to `wokwi-cli mcp` — confirm every non-broken tool has an analog and 4+ tools exist that wokwi doesn't have (oracle_compare, read_display_buffer, list_projects, compile_chip, build_firmware, run_ms)

## References

- Existing in-app MCP tools: `app/api/chat/route.ts:164` `createSimulationServer`
- Headless CLI: `scripts/sparkbench-run.ts`
- Oracle: `scripts/oracle-test.ts`
- Display renderer: `lib/display-renderer.ts`
- PNG encoder: `lib/png-encoder.ts`
- Wokwi CLI MCP source (for parity reference): https://github.com/wokwi/wokwi-cli (`packages/cli/src/mcp/WokwiMCPTools.ts`)
- MCP spec: https://modelcontextprotocol.io
- MCP TypeScript SDK: `@modelcontextprotocol/sdk@^1.26.0` (already in `package.json`)
