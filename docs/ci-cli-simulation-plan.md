# CI-Grade CLI and Simulation Plan

## Goal

Make SparkBench usable as a complete headless hardware development tool:

- create projects and `diagram.json` from the CLI
- compile firmware without the web app
- compile and run custom chips with the MCU simulation
- run deterministic scenario tests in CI
- run real-time or cycle-bounded MCU simulations
- expose a stable machine-readable output format for agents and CI
- grow into mixed-signal simulation with SPICE and HDL models

The current web app should become a client of the same core runtime used by the CLI,
not a parallel implementation.

## Current State

### Already Useful

- `sparkbench list` lists filesystem projects.
- `sparkbench run <project>` compiles firmware, loads `diagram.json`, runs AVR
  simulation, captures serial, supports display screenshots, and compiles Wokwi
  custom chips.
- `sparkbench test <project>` runs YAML scenarios.
- `sparkbench serve <project>` exposes a WebSocket-controlled headless simulator.
- `CustomChipRuntime` can instantiate compiled Wokwi-style WASM chips and bridge
  GPIO, ADC-like analog pin reads/writes, timers, attributes, console output, and
  I2C peripheral behavior.

### Main Gaps

- CLI compile/run logic is duplicated across `sparkbench-run.ts`,
  `run-scenario.ts`, `serve-api.ts`, `sparky-fuzzer.ts`, and API routes.
- `sparkbench test` uses the synchronous scenario runner, so it does not compile
  and wire custom chips.
- There is no `sparkbench create`.
- There is no direct `sparkbench simulate --diagram diagram.json --sketch sketch.ino`.
- MCU clock is hardcoded to 16 MHz in `AVRRunner`.
- PlatformIO command discovery differs between scripts.
- Output is human-first, not CI-first. There is no stable JSON report schema.
- SPICE is not implemented.
- SystemVerilog/Verilog custom chip authoring is not implemented.

## Target CLI

```bash
sparkbench create blink --template uno-led
sparkbench create my-board --mcu uno --part led:led1 --wire uno:13:led1:A

sparkbench compile projects/blink
sparkbench simulate projects/blink --timeout 2000 --realtime
sparkbench simulate projects/blink --max-cycles 32000000 --json
sparkbench simulate --diagram diagram.json --sketch sketch.ino --mcu uno

sparkbench test projects/blink
sparkbench test projects/blink --scenario tests/blink.yaml --json --report test-results/blink.json

sparkbench chip compile projects/my-chip
sparkbench chip test projects/my-chip --scenario tests/chip.yaml

sparkbench serve projects/autothrottle --port 8765

sparkbench spice projects/filter --tran 0 10ms 1us
sparkbench mixed projects/sensor-board --timeout 100ms --realtime
```

## Core Runtime Refactor

Create a shared package under `lib/cli-runtime/` or `lib/sim/`:

- `project-loader.ts`
  - load from `projects/<slug>`
  - load from explicit paths
  - validate required files
  - return `{ root, diagram, sketch, librariesTxt, files }`
- `firmware-builder.ts`
  - generate `platformio.ini`
  - detect libraries
  - choose board
  - run PlatformIO
  - return HEX and build metadata
- `chip-builder.ts`
  - find `.chip.json` + `.chip.c`
  - compile with `wokwi-cli chip compile`
  - cache WASM by source hash
  - return `Map<partId, CustomChipConfig>`
- `simulation-runner.ts`
  - own `AVRRunner`, wiring, custom chips, serial capture, display capture
  - support real-time, faster-than-real-time, and fixed-cycle modes
  - expose `runUntil`, `runForMs`, `runCycles`, `sendSerial`, `setControl`
- `scenario-engine.ts`
  - run YAML scenarios against `simulation-runner`
  - support custom chips by default
  - return stable JSON reports
- `reporter.ts`
  - text, JSON, and JUnit output

After that, scripts and API routes should call this runtime instead of each
reimplementing compile/sim/chip setup.

## MCU Clock and Timing

`AVRRunner` should accept config:

```ts
new AVRRunner(hex, {
  clockHz: 16_000_000,
  realtime: true,
  workUnitCycles: 500_000,
});
```

Required modes:

- `--realtime`: throttle simulated time to wall time.
- `--speed 10x`: run 10 simulated seconds per wall second.
- `--no-throttle`: run as fast as possible.
- `--max-cycles N`: deterministic CI cutoff.
- `--timeout-ms N`: simulated time cutoff.

Everything should report:

- final cycle count
- simulated elapsed time
- wall elapsed time
- effective sim speed
- selected MCU/board/clock

## Custom Chips

### Wokwi C/WASM Path

This is the immediate production path because it already mostly works.

Project files:

```text
foo.chip.json
foo.chip.c
foo.chip.svg   # optional
```

The CLI must:

1. detect chip file pairs
2. validate `chip.json`
3. compile `.chip.c` to `.wasm`
4. map the compiled chip to matching diagram parts
5. wire all matching parts into the MCU simulation
6. stream chip `printf` output into the simulation log
7. expose chip attrs/controls to scenario steps and WebSocket clients

Scenario additions:

```yaml
- expect-chip-log:
    part-id: amp1
    text: "gain set"

- set-chip-attr:
    part-id: amp1
    attr: gain
    value: 2.5

- expect-chip-attr:
    part-id: amp1
    attr: output
    equals: 3.3
    tolerance: 0.05
```

### SystemVerilog Path

SystemVerilog should be a second custom-chip authoring frontend, not a separate
simulation world.

Recommended first implementation:

1. accept `<name>.chip.sv`
2. use Verilator to compile SystemVerilog into C++/WASM or a native helper
3. generate/require a matching `<name>.chip.json`
4. expose the same pin/attr/timer interface used by `CustomChipRuntime`

Minimal target:

- combinational and synchronous digital chips
- single clock input
- GPIO-level pins
- deterministic CI execution

Deferred:

- arbitrary delays
- analog HDL modeling
- multi-clock timing closure
- synthesis-level constraints

## SPICE and Mixed Signal

Do not hand-roll a SPICE solver first. Use `ngspice` as the engine and make
SparkBench responsible for netlist generation, orchestration, and co-simulation.

Phases:

1. `sparkbench spice`
   - convert supported diagram parts to a SPICE netlist
   - run DC and transient analyses
   - output CSV/JSON waveform data
2. MCU-to-SPICE bridge
   - MCU digital output becomes piecewise voltage source
   - SPICE analog node drives MCU ADC channel
   - digital threshold node drives MCU GPIO input
3. Time-step co-simulation
   - run MCU for N cycles
   - advance SPICE by dt
   - exchange boundary values
   - repeat deterministically

Initial supported analog parts:

- resistor
- capacitor
- diode
- voltage source
- potentiometer as divider
- simple op amp macro model
- transistor models later

## CI Contract

Every CI command should support:

```bash
--json
--report <file>
--junit <file>
--timeout-ms <n>
--max-cycles <n>
--seed <n>
--no-network
```

Report schema:

```json
{
  "project": "blink",
  "passed": true,
  "mcu": { "id": "uno", "board": "uno", "clockHz": 16000000 },
  "build": { "success": true, "durationMs": 1234 },
  "chips": [
    { "partId": "amp1", "name": "amplifier", "compiled": true, "wasmBytes": 12400 }
  ],
  "simulation": {
    "cycles": 32000000,
    "simulatedMs": 2000,
    "wallMs": 450,
    "serial": "..."
  },
  "steps": [
    { "index": 0, "passed": true, "description": "wait-serial READY" }
  ]
}
```

## Implementation Phases

### Phase 1: Make Existing CLI Coherent

- Add `sparkbench create`.
- Add `sparkbench compile`.
- Rename/standardize `sparkbench run` as `sparkbench simulate` while keeping
  `run` as an alias.
- Add direct path mode: `--project`, `--diagram`, `--sketch`.
- Centralize PlatformIO discovery.
- Add JSON output and reports.

### Phase 2: Custom Chips Everywhere

- Extract chip compilation from `sparkbench-run.ts` into shared runtime.
- Make `sparkbench test` use async scenario execution with custom chips.
- Add chip log capture to reports.
- Add scenario steps for chip attrs/logs.
- Add cache for compiled `.chip.c` to `.wasm`.

### Phase 3: Timing Controls

- Make `AVRRunner` configurable by clock.
- Add `--clock-hz`, `--realtime`, `--speed`, `--max-cycles`.
- Report deterministic cycle/time metadata.
- Add tests proving delays and serial timing scale with clock.

### Phase 4: CI Polish

- Add JUnit reporter.
- Add stable exit codes.
- Add `--no-network` build mode once PlatformIO deps are cached.
- Add GitHub Actions examples.
- Add fixtures that run in CI with custom chips.

### Phase 5: SystemVerilog Custom Chips

- Define `.chip.sv` project convention.
- Prototype Verilator-based compile.
- Map HDL pins to the same runtime pin API.
- Add a first HDL fixture: inverter or counter.

### Phase 6: SPICE

- Add `sparkbench spice` with ngspice-backed netlist execution.
- Generate netlists from diagram subsets.
- Add CSV/JSON waveform output.
- Add MCU/SPICE boundary model.

## Acceptance Criteria

The CLI is feature-complete enough when this works in CI without the web app:

```bash
sparkbench create ci-chip-demo --template custom-chip-inverter
sparkbench test ci-chip-demo --json --report test-results/ci-chip-demo.json
sparkbench simulate ci-chip-demo --max-cycles 32000000 --serial-log serial.txt
```

And the report proves:

- firmware compiled
- custom chip compiled
- custom chip instantiated
- chip log was captured
- MCU interacted with the chip
- scenario assertions passed
- cycle count and simulated time are deterministic

