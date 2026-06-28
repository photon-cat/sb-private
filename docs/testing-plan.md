# SparkBench Testing Plan

## Goal

Make sure the code we generate actually works. Not coverage percentages — bug
detection. For every test we add, the question is: *"if I break this code, does
this test tell me?"* If the answer is no, we don't write it.

## Principle: test at the right layer

SparkBench is a hardware simulator with a browser UI. The cheapest, highest-signal
tests are not React component tests — they are **scenario tests** that compile real
firmware and assert real simulation output, and **pure-logic unit tests** on the
parser/reducer/builder layer. The browser-only behavior (custom elements, WebGL,
DOM measurement) is covered by **Playwright**, not jsdom mocks.

```
Layer 1  Scenario tests      compile → wire → simulate → assert   (highest signal)
Layer 2  Pure-logic units    reducer, ops, builder, parsers       (fast, no mocks)
Layer 3  Playwright E2E       real browser, real user workflows   (catches UI bugs)
Layer 4  Mutation (targeted)  only the component simulators        (finds loose tests)
Layer 5  CI enforcement       run all of the above, fail loudly
```

### What we deliberately do NOT do

- No jsdom tests for `DiagramCanvas`, `KiPCBEditor`, `SimulationPanel`. They depend
  on custom elements, WebGL, `getBoundingClientRect`, and `requestAnimationFrame`.
  Testing them in jsdom tests a parallel universe, not the product.
- No snapshot tests. They break on cosmetic changes and assert nothing about correctness.
- No mock-heavy "integration" tests. Mocking AVRRunner + build + fs tests glue, not behavior.
- No coverage thresholds. "80% or CI fails" incentivizes line-hitting tests that
  never check results. Scenario tests give real coverage guarantees instead.

---

## Layer 1 — Scenario test expansion (highest ROI)

The YAML scenario runner (`lib/scenario-runner.ts`) is the most valuable test asset:
it compiles a real sketch, wires the diagram, runs the AVR simulation, and asserts
serial / display output. 19 of 39 projects have scenarios; key simulators have none.

**Tasks**
1. Add `sparkbench test --all` — walk `projects/*/test.scenario.yaml`, run each via
   `runScenarioAsync` (custom-chip aware), aggregate pass/fail, emit JSON + JUnit.
2. Backfill missing scenarios for shipped simulators:
   - `blink` — GPIO toggle on pin 13 within 1100 ms
   - `bmp180-test` — I2C pressure read round-trips via serial
   - `inverter-test` — custom WASM chip loads and inverts a pin
   - `74hc595-demo`, `actuator-test` — verify they have meaningful asserts
3. Add a clock-speed scenario — run the same sketch at 8 MHz and 16 MHz, assert serial
   timing scales (validates the configurable-clock work).
4. Add negative scenarios — invalid hex, missing diagram, malformed chip JSON →
   clean deterministic error, never a crash.

**Rule going forward:** every new component simulator ships with a scenario test.

---

## Layer 2 — Pure-logic unit tests

Pure functions, no DOM, no mocks. These protect the refactors we just did.

**Tasks**
5. `lib/workbench/reducer.ts` — one test per action type; assert immutability (input
   state object is never mutated); assert `LOAD_PROJECT` resets dirty, `SET_SAVED`
   clears dirty, `SET_DIAGRAM_JSON` keeps old diagram on invalid JSON.
6. `lib/diagram-ops.ts` — every mutation; specifically prove `removePart` also drops
   connections that touch the removed part, and `duplicatePart` produces a unique id.
7. `lib/sim/firmware-builder.ts` — `generatePlatformioIni` header→lib detection and
   dedup; board aliasing (`atmega328p`→`uno`); `findPlatformio` fallback order.
8. `lib/sim/reporter.ts` — `buildReport` shape; `toJUnit` valid XML + escaping.
9. `lib/diagram-io.ts` — `exportToWokwi(importWokwi(x))` round-trip equivalence.
10. `lib/spice-netlist.ts` — already partly covered; add the injection-sanitization
    cases (`parseResistance("220\n.dc 0 5")` strips the directive).

---

## Layer 3 — Playwright E2E workflows

Replace the "page loads / body has text" smoke tests with real journeys. These
catch what nothing else can: custom elements, Monaco, WebGL, persistence all working
together.

**Tasks**
11. Compile + simulate `blink`: open → Run → serial/LED state changes → Stop.
12. Edit + persist: change sketch → save → reload → text persists.
13. Schematic edit: add LED from catalog → draw wire to pin 13 → wire exists.
14. PCB sync: switch to PCB tab → sync-from-schematic → footprints render.
15. Diagram JSON ↔ visual round-trip: edit JSON tab → switch to visual → reflected.

(Keep these resilient: assert on behavior/roles, not CSS structure.)

---

## Layer 4 — Mutation testing (targeted, optional cadence)

Worth it **only** for the component simulators, where a flipped bit mask or off-by-one
in I2C register handling silently diverges from real hardware and a loose scenario
won't notice.

**Status: implemented.** Stryker (Vitest runner) is configured in `stryker.conf.json`,
scoped to the simulator modules that have *fast unit tests* (the rest are only covered
by toolchain-dependent scenario tests, which are not feasible to run per-mutant):

- `lib/hc595-sim.ts`            (← `hc595-sim.test.ts`)
- `lib/lcd1602-controller.ts`   (← `lcd1602-sim.test.ts`)
- `lib/chip-runtime.ts`         (← `chip-runtime.test.ts`)

Run it on-demand, **not** on every PR:

```bash
npm run test:mutation            # all three modules
npx stryker run --mutate "lib/hc595-sim.ts"   # one module
```

It uses `vitest.stryker.config.ts`, a scoped Vitest config that includes only those
three test files so each mutant runs against a minimal, fast suite (~40s total).
HTML report lands in `test-results/mutation/`.

**What the first run found:** `hc595-sim` scored 95% (1 survivor) — tight. `lcd1602`
had survivors in the cursor-clamping logic: no test drove the cursor past the 32-cell
buffer end or below 0. Added boundary tests (`clamps the cursor at the end…`, `clamps
the cursor at 0 when decrementing past the start`) that kill those mutants. One
remaining `< 0` → `<= 0` survivor at the lower clamp is a genuine *equivalent mutant*
(clamping to 0 at `0` or `<0` is identical) — acceptable.

Not worth mutating: reducer, ops, CLI scripts, reporter, UI — either trivially correct
or already covered by higher layers; mutants there are noise.

---

## Layer 5 — CI enforcement

**Tasks**
17. CI step: `sparkbench test --all --json --junit test-results/scenarios.xml`,
    fail the job on any scenario failure.
18. CI step: `vitest run --reporter=junit` for machine-readable unit results.
19. Wire JUnit outputs into GitHub Actions annotations.

---

## Execution order (by payoff-to-effort)

1. `sparkbench test --all` + missing scenarios (blink, bmp180, inverter) — Layer 1
2. Reducer + diagram-ops unit tests — Layer 2 (protects the workbench refactor)
3. firmware-builder + reporter + diagram-io units — Layer 2
4. Playwright workflow tests — Layer 3 (protects UI through the context migration)
5. CI wiring — Layer 5
6. Stryker on simulators — Layer 4 (monthly)
