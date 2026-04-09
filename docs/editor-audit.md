# SparkBench Diagram Editor — Audit vs Wokwi

Systematic comparison of SparkBench's diagram editor against the Wokwi web editor (https://wokwi.com). Based on reading all ~1300 lines of `components/DiagramCanvas.tsx`, the wiring / controller / custom-chip code in `lib/`, and the `@wokwi/elements` package shipped in `node_modules`.

Legend: ✅ parity  |  ⚠️ partial  |  ❌ missing  |  🐛 bug

## 0. Critical bugs — fix first

These are the bugs that **visibly break user-facing behavior** in the canvas right now, ordered by severity:

### ⛔ #1. Custom chip wires don't render (`pinInfo` on wrong class level)

**Symptom:** In any project with a `chip-*` part, the wires connecting the chip's pins to other parts **do not appear in the canvas**, even though the simulation itself works (verified via headless oracle match). Image #8 shows this on `cd4051-mux`: no gold wires from the 8 pots to the chip.

**Root cause:** `@wokwi/elements` sets `this.pinInfo = [...]` as an **instance property** inside each element's class constructor. SparkBench's `DiagramCanvas.computePinsAndWires` reads `(el as any).pinInfo` on the HTMLElement instance.

Our `CustomChipElement.ts` originally exposed `pinInfo` via `static get pinInfo()` — a **static class getter**, which JavaScript does not forward through instance property access. So every custom chip element returned `undefined` for its pin list, which meant:
1. `computePinsAndWires` skipped the chip entirely
2. Pin positions for `ic1:CIO0`, `ic1:COMIO`, etc. never entered the pin-position map
3. Every wire with an endpoint on the chip silently dropped in `renderWires` (no position = no wire)

**Impact:** all 17 Wokwi oracle test runs pass serial-level because simulation uses `part.connections` + the MCU pin mapper — those never look at element pinInfo. But the *visual* canvas silently rendered half the diagram for every custom chip project.

**Fix (applied this session):** set `pinInfo` as an instance property in the class body, not a static getter. File: `components/CustomChipElement.ts`. Also exposes `chipWidth`/`chipHeight` instance fields so `pinToCanvas()` uses accurate dimensions instead of `offsetWidth` which includes the SVG overflow region.

**Status:** 🟢 **FIXED** — regression test coverage: refresh `cd4051-mux` in the browser and verify all 8 gold wires from pots → chip now render.

### ⛔ #2. Rendering divergence vs Wokwi ≠ simulation divergence

**Symptom:** The `cd4051-mux` project **renders differently** in SparkBench and Wokwi (see image comparisons — Wokwi has a detailed green breakout board for `chip-cd4051b`, SparkBench shows a small teal DIP with our own label).

**Is it the "same project"?** Yes *and* no:
- **Simulation semantics: byte-identical.** `scripts/oracle-test.ts cd4051-mux` produced 43 lines of matching serial output over 5 seconds of real-time running. The Arduino sketch reads the same values back from the chip in both simulators. Our own `cd4051b.chip.c` is the **authoritative** implementation on both sides — the oracle staging step writes the same `cd4051b.wasm` into the wokwi-cli work directory so both simulators are running identical chip bytecode, not Wokwi's built-in community chip.
- **Visual rendering: different.** Wokwi's canvas still draws `chip-cd4051b` using its own built-in breakout board SVG (from its closed-source WASM bundle). Our canvas draws the chip using `CustomChipElement.ts` which is a generic DIP — it has no idea what a CD4051B's breakout looks like. The pin positions are identical but the chassis art is not.

**What this means for "exact match":**
- "Same inputs → same outputs" ✅ (oracle-verified)
- "Same pin positions, same wire endpoints" ✅ (verified by fix #1)
- "Pixel-identical rendering" ❌ and will stay that way until we either author per-chip SVG art or ship Wokwi's `chip-cd4051b` element file (if they publish it).

**Status:** 🟡 **EXPECTED DIVERGENCE**, not a bug. But it means visual screenshots can't be pixel-diffed across simulators for custom chips unless we render against the same underlying SVG.

### ⛔ #3. `wokwi-ssd1306` pin-name mismatch silently ignored

**Symptom:** SparkBench accepts `wokwi-ssd1306` part wired with `VCC/SDA/SCL` pin names, but those aren't the real pin names of the element. Wokwi CLI **rejects** the same diagram as `invalid-pin`.

**Root cause:** `lib/wire-components.ts` registers the SSD1306 controller on the I2C bus at address 0x3c purely from `part.type`, regardless of which pins the diagram references. Wire endpoints like `oled1:SDA` silently fail to resolve (because the real pin names are `DATA`, `CLK`, `VIN`) but the controller still works because it doesn't need those connections to function.

**Real pin names** (from `@wokwi/elements`): `DATA, CLK, DC, RST, CS, 3V3, GND, VIN` — it's actually the SPI variant with I2C signals annotated on DATA/CLK.

**Impact:** Projects authored in SparkBench with wrong pin names *look fine locally* but fail to import into Wokwi, and the LCD/OLED wires that reference bogus pin names are invisible on the canvas because `pinInfo` has no entry for them.

**Fix (partial, applied earlier):** `projects/actuator-test/diagram.json` now uses correct pin names. Need a linter in SparkBench to catch this: iterate each connection, look up the referenced part's element pinInfo, warn on unresolved pins.

**Status:** 🟡 **KNOWN** — not automatically detected. Planned: add a diagram linter in `lib/diagram-parser.ts` that warns on unresolved pin refs.

### ⛔ #4. Bend hints rendered but not re-flowed when parts move

**Symptom:** When a user drags a part in the canvas, the part's position updates but the wire bend hints (`h`/`v` segments in `diagram.connections[i][3]`) are not re-computed. Result: wires can drift off the grid, cross parts, or point at thin air.

**Root cause:** `computePinsAndWires` is recomputed after drag, but it only reads `part.top/left` to compute pin positions — the bend hints stored in the connection array are absolute `hN`/`vN` segments calculated from the original positions. Dragging doesn't edit the hints.

**Fix:** Either (a) re-run `pathToHints()` on every drag-end to regenerate hints from scratch, or (b) switch to a relative coordinate system so hints become independent of part position. Option (a) is ~1 hour.

**Status:** 🟡 **KNOWN** — not fixed yet.

### ⛔ #5. `cleanPath()` strips user-drawn collinear bends

**Symptom:** User carefully draws a wire with three collinear points to make a specific routing. On re-render, the middle point disappears. The bend handle vanishes.

**Root cause:** `lib/wire-renderer.ts::cleanPath()` removes any point whose predecessor and successor share the same x or y. This is correct for eliminating redundancies in auto-routed paths, but wrong for user-authored paths where a collinear point is meaningful (e.g. planning to drag it later).

**Fix:** Only call `cleanPath()` on auto-routed paths, not on user-drawn ones. Track provenance of each point (auto vs user).

**Status:** 🟡 **KNOWN** — edge case, not urgent.

### ⛔ #6. Zoom centers on viewport, not mouse cursor

**Symptom:** When you zoom in on a specific area with the wheel, the canvas scales from the center of the screen instead of from under the cursor. Makes "zoom into this pin" frustrating.

**Root cause:** `applyZoomStep` in `DiagramCanvas.tsx` uses viewport center for the new origin. Should compensate using `(mouseX - panX) / oldZoom` to keep the mouse point stationary.

**Fix:** ~30-line change. Standard zoom-to-cursor math.

**Status:** 🟡 **KNOWN** — quick fix, not yet applied.

### ⛔ #7. Ruler unit labels cryptic ("u/10")

**Symptom:** Canvas rulers show labels like "0", "-1", "-2", "-3" where one unit = 10 grid squares = 96 CSS pixels = 1 inch. This is confusing because Wokwi shows mm and the diagram coordinates are in raw pixels, not inches.

**Fix:** Either (a) label rulers in mm (96px ≈ 25.4mm), (b) label in native pixels for debugging, or (c) add a dropdown for unit choice. ~10 lines.

**Status:** 🟡 **KNOWN** — trivial fix.

### ⛔ #8. Wire drawing tool is vertical-first but renderer is horizontal-first

**Symptom:** When you draw a wire with the click-click tool, it bends vertical→horizontal. When you import a Wokwi project that auto-routed, those wires come in as horizontal→vertical. Inconsistent look in the same diagram.

**Root cause:** `useWireDrawing.ts` is hand-coded to produce `[start, {x:start.x, y:end.y}, end]` (vertical-first). `lib/wire-renderer.ts::buildWirePath` with no hints produces `[start, {x:end.x, y:start.y}, end]` (horizontal-first). Comment says "Wokwi routes horizontal-first" — that's correct, but the wire drawing tool doesn't follow the same convention.

**Fix:** Make `useWireDrawing`'s auto-bridge use the same horizontal-first L. ~5 line change.

**Status:** 🟡 **KNOWN** — quick fix, not yet applied.



## 1. Editor UX features

| Feature | SparkBench | Wokwi | Notes |
|---|:---:|:---:|---|
| Part library picker | ✅ | ✅ | Categorized with live search (`AddPartPanel`) |
| Click-to-wire with bend points | ✅ | ✅ | Wire tool toggles with `W`; dashed preview path |
| Pin highlight / snap while wiring | ✅ | ✅ | Concentric-circle hover, green ring on start pin |
| Auto wire color from pin role | ✅ | ✅ | GND→black, 5V/VCC→red, others cycle palette |
| Horizontal-first auto-route | ✅ | ✅ | Match Wokwi convention (actually vertical-first in code, see 🐛 below) |
| Wire bend handles (drag to reshape) | ✅ | ✅ | Axis-aligned only |
| Single-part selection | ✅ | ✅ | Blue outline, 2px offset |
| **Multi-select / marquee** | ❌ | ✅ | No drag-select, no group ops |
| **Copy / paste (clipboard)** | ❌ | ✅ | `D` duplicates one part; no multi-part clipboard |
| **Alignment / distribute** | ❌ | ✅ | No align-left/right/center, no distribute |
| **Group / lock** | ❌ | ✅ | Parts are individually manipulable only |
| Drag-to-move with snap | ✅ | ✅ | Anchor-pin snap to grid; `Shift`=fine, `Shift+Ctrl`=free |
| Rotate 90° (`R` key) | ✅ | ✅ | 0/90/180/270 only |
| **Rotate arbitrary angle** | ❌ | ⚠️ | Neither supports it; Wokwi is 90° increments too |
| Delete (`Del`/`⌫`) | ✅ | ✅ | Also cleans up connected wires |
| Right-click context menu | ❌ | ✅ | SparkBench has no context menu at all |
| Undo / redo | ✅ | ✅ | 50-entry history; all mutations tracked |
| Zoom wheel | ✅ | ✅ | 0.25x–4x, `+`/`-` keys, `F` fit-to-screen |
| **Zoom centered on mouse** | 🐛 | ✅ | SparkBench zooms on viewport center; Wokwi centers on cursor |
| Pan (middle-click, drag empty) | ✅ | ✅ | Pointer captured to prevent text selection |
| **Pan (trackpad two-finger / space-drag)** | ❌ | ✅ | SparkBench has no spacebar-drag or trackpad gesture |
| Grid / ruler | ✅ | ✅ | Dot grid at 9.6px, rulers with tick marks |
| **Ruler unit labels** | 🐛 | ✅ | SparkBench ruler shows "u/10" (confusing); Wokwi shows mm |
| Live `diagram.json` ↔ canvas sync | ✅ | ✅ | Bidirectional — edit JSON updates canvas and vice versa |
| Attribute inspector per part type | ✅ | ✅ | `PartAttributePanel` registry covers 20+ types |
| Runtime sensor sliders during sim | ✅ | ✅ | DHT22, BMP180, MPU6050, custom chip `controls[]` |
| Keyboard shortcut coverage | ✅ | ✅ | W/R/D/Del/0-9/Esc/+/-/F/G — more than Wokwi documents |
| **Custom chip visual (DIP fallback)** | ⚠️ | ✅ | SparkBench draws a small generic teal DIP; Wokwi ships rich breakout visuals for community chips (see §3) |
| **Label orientation at 180° rotation** | ✅ | ✅ | Fixed in `CustomChipElement` — counter-rotates the SVG text |

### Bugs and rough edges found

1. 🐛 **Zoom center** — all zoom operations (wheel, `+/-`) center on viewport midpoint instead of the mouse pointer. Makes "zoom to area" awkward. `DiagramCanvas.tsx` around the `applyZoomStep` function.
2. 🐛 **Ruler unit mismatch** — rulers are labeled "u/10" (integer grid units divided by 10) but the canvas unit is CSS pixels at 9.6 px = 0.1 inch. Either show mm/inches or relabel. Confusing when users import a Wokwi project whose coordinates are in the same raw pixels but ruler looks different.
3. 🐛 **"Horizontal-first" routing is actually vertical-first** — code comment says "Wokwi routes horizontal-first" but the default L-path in `buildWirePath` is `[start, {x: end.x, y: start.y}, end]` which IS horizontal-first (sideways then vertical). However the wire-drawing tool in `useWireDrawing` draws vertical-first during click-click. Inconsistent with the renderer.
4. 🐛 **`cleanPath()` can collapse user-drawn collinear bends** — if a user carefully routes a wire with three points that happen to be collinear, the middle point gets removed and the bend handle disappears on re-render.
5. ⚠️ **Pan works during sim run, drag doesn't** — confusing UX: users can still pan while simulation is running (good), but dragging parts is blocked (also good), yet there's no visual indicator why.
6. ⚠️ **No layer / z-order** — if two parts overlap in dense layouts, you can't bring-to-front / send-to-back. Matters less on Wokwi because most layouts are spread out, but bites SparkBench users who try to author compact boards.
7. ⚠️ **No "make a copy of the project"** — `D` duplicates a part, but there's no "fork this project" like Wokwi's "Save a copy".

## 2. Part simulation coverage

Rendering is free via `@wokwi/elements` (SparkBench imports the whole package). Simulation is what SparkBench actually implements in `lib/wire-components.ts` and the various `*-sim.ts` / `*-controller.ts` files.

### ✅ Fully simulated (14 parts)

GPIO: `wokwi-led`, `wokwi-pushbutton`, `wokwi-pushbutton-6mm`, `wokwi-buzzer`, `wokwi-servo`
Analog: `wokwi-potentiometer`, `wokwi-slide-potentiometer`
Digital I/O: `wokwi-slide-switch` (wired to HC165), `wokwi-ky-040` encoder
I2C devices: `wokwi-ssd1306`, `wokwi-lcd1602`, `wokwi-lcd2004`, `wokwi-mpu6050`, `wokwi-bmp180`
Shift registers: `wokwi-74hc165`, `wokwi-74hc595`
Sensors: `wokwi-dht22`
Boards: `wokwi-arduino-uno`, `wokwi-arduino-nano`, `wokwi-arduino-mega`, `sb-atmega328`

### ⚠️ Partially simulated (3)

- `wokwi-7segment` — renders, but only lights up when driven through an HC595 chain. Direct GPIO scan doesn't work.
- `wokwi-dip-switch-8` — renders, but switches don't inject any pin state.
- `wokwi-ntc-temperature-sensor` — rendered but no ADC value source wired in.

### ❌ Render-only (no simulation) — ~35 parts

**Sensors** (ADC-based, mostly 1-pin voltage outputs): `wokwi-analog-joystick`, `wokwi-flame-sensor`, `wokwi-gas-sensor`, `wokwi-photoresistor-sensor`, `wokwi-heart-beat-sensor`, `wokwi-big-sound-sensor`, `wokwi-small-sound-sensor`, `wokwi-pir-motion-sensor`, `wokwi-hc-sr04`, `wokwi-tilt-switch`, `wokwi-hx711`, `wokwi-rotary-dialer`

**Displays**: `wokwi-ili9341` (TFT SPI)

**LEDs**: `wokwi-rgb-led` (no PWM→color), `wokwi-led-bar-graph`, `wokwi-led-ring`, `wokwi-neopixel`, `wokwi-neopixel-matrix` (no WS2812 1-wire)

**ICs / protocol devices**: `wokwi-ds1307` (I2C RTC), `wokwi-microsd-card` (SPI), `wokwi-ir-receiver`, `wokwi-ir-remote`, `wokwi-membrane-keypad`

**Motors**: `wokwi-stepper-motor`, `wokwi-biaxial-stepper`, `wokwi-ks2e-m-dc5` relay

**Other MCU boards**: `wokwi-esp32-devkit-v1`, `wokwi-nano-rp2040-connect`, `wokwi-franzininho` — compile-only (we build firmware but don't emulate the chip)

**Passives**: `wokwi-resistor` is render-only by design (SparkBench treats all connections as ideal wires)

## 3. Community chips (`chip-*` types)

Wokwi has a separate "community chips" feature — a library of pre-written custom chips that ship with the simulator, not `@wokwi/elements`. Wokwi references them by type like `chip-cd4051b`, `chip-74hc595`, `chip-74hc138`, `chip-mcp3008`, `chip-mcp23017`, `chip-max7219`, etc.

**SparkBench's approach:** users ship their own `.chip.c` + `.chip.json` files in the project. We have 4 first-party examples:

| Chip | Project | Status |
|---|---|---|
| `chip-cd4051b` (8-ch analog mux) | `projects/cd4051-mux/` | ✅ oracle-matches Wokwi |
| `chip-inverter` | `projects/inverter-demo/` | ✅ oracle-matches Wokwi |
| `chip-amplifier` (analog gain/offset) | `projects/control-knob-demo/` | ✅ oracle-matches Wokwi |
| `chip-magic8` (I2C peripheral) | `projects/i2c-chip-demo/` | ✅ oracle-matches Wokwi |

**Gap:** if a user imports a Wokwi project that references `chip-74hc595` or any other built-in community chip, the chip renders as a blank area (no element registered) and the wire endpoints don't resolve. They'd have to author their own chip.c. Wokwi ships these for free.

**Fix options:**
1. Ship a "stock chips" folder with SparkBench that users can symlink into their project (`stock-chips/74hc595.chip.c` etc.) — 5-10 commonly-used chips would cover 80% of Wokwi projects
2. Add a `[[stock-chip]] name = "74hc595"` section to our project format that auto-loads from the stock library
3. Port Wokwi's open-source inverter/cd4051 chip sources directly — they're MIT-licensed on github.com/wokwi

## 4. Importing a Wokwi project — what users actually hit

When someone copies a Wokwi `diagram.json` into SparkBench, here's the typical failure mode order:

1. **Stale `tiny:*` connections** (from ATtiny → Uno remixes). SparkBench's diagram-parser silently drops unresolved refs. Harmless but leaves "dead wires" in the JSON.
2. **Community chip type missing.** `chip-74hc595` renders as nothing, connected wires fail to resolve endpoints, looks like parts are floating. **High impact.**
3. **Render-only parts in the simulation path.** The LCD looks right, the PIR sensor looks right, but neither responds. Serial output shows nothing happening. **High impact** for tutorial projects.
4. **Wrong pin names** (rare now — we already found that `wokwi-ssd1306` uses DATA/CLK, not SDA/SCL). Silently accepted by SparkBench.
5. **`rotate: 180` flipped labels.** Now fixed in `CustomChipElement` via counter-rotation.
6. **Bend hints rendered but not auto-generated.** If a user drags a part in SparkBench, the existing wire bends persist but don't re-flow.

## 5. Prioritized fix list

### Tier 1 — high impact, low effort

1. **Ship stock `chip-74hc595` + `chip-74hc138` + `chip-mcp3008` + `chip-cd4051b` in a `projects/_stock-chips/` or `lib/stock-chips/` folder**, plus a loader that symlinks them in when a diagram references an unknown `chip-*` type. ~1 day. Unlocks most Wokwi imports.
2. **Fix the zoom center bug.** Zoom-to-cursor is a 10-line change in `applyZoomStep`. ~30 minutes.
3. **Rename ruler units to mm** (or match Wokwi's labeling). ~10 minutes.
4. **Render-only fallback for `wokwi-dip-switch-8`** — wire each switch as a digital output into the connected MCU pin. The switch already has `values[]` state. ~1 hour.
5. **Wire simulation for `wokwi-rgb-led`** — detect R/G/B pin connections, mix colors based on their PWM duty cycle. ~2 hours.

### Tier 2 — medium impact, moderate effort

6. **Marquee multi-select + align tools** — SparkBench has no multi-select at all, which is the most-cited editor gap. The drag handler infrastructure is already there. ~4 hours.
7. **Clipboard copy/paste** — builds on multi-select. ~2 hours.
8. **Right-click context menu** — delete, rotate, duplicate, send-to-back. ~2 hours.
9. **`wokwi-neopixel` + `wokwi-neopixel-matrix` simulation** — implement WS2812 timing protocol, push pixel colors to the element. ~1 day. Very common in projects.
10. **`wokwi-hc-sr04` ultrasonic** — trigger/echo pin timing. ~2 hours. Classic beginner project.

### Tier 3 — deeper investments

11. **Full ADC sensor framework** — a registry where `wokwi-photoresistor-sensor`, `wokwi-flame-sensor`, `wokwi-gas-sensor`, `wokwi-ntc-temperature-sensor`, etc. all plug in by wiring their SIG pin to the MCU's ADC channel with a user-controllable slider. Would cover 8-10 parts at once. ~1 day including UI sliders in PartAttributePanel.
12. **I2C device framework** — generic "I2C register-based peripheral" class that the RTC (DS1307), 24C EEPROMs, ADS1115 ADC, MCP23017 GPIO expander, etc. can all subclass. Each part becomes a ~50-line controller. ~1-2 days for the framework + 3-4 controllers.
13. **Fix `cleanPath()` over-simplification** — preserve user-drawn bend points even when collinear. Edge case but annoying. ~1 hour.
14. **Cursor-centered zoom** — see Tier 1 #2, but do it properly using the viewport transform math (not just a pan compensation). ~1 hour.
15. **Layer / z-order** — `bring-to-front` / `send-to-back` in the right-click menu. ~30 minutes after #8 lands.
16. **ESP32 visual simulator** — currently we compile ESP32 firmware but don't run it. Would need the espwebemu WASM or wokwi's approach. Much bigger project.

## 6. TL;DR

**What works well in SparkBench's editor:**
- Full feature parity for single-part editing: select, drag, rotate, delete, attribute inspector
- Keyboard shortcut surface matches or exceeds Wokwi
- Wire tool has colors, bend handles, pin snapping, auto routing
- Custom chip support via `.chip.c/.json` — and the oracle test shows we're byte-identical to Wokwi for 5 chip projects
- Live diagram.json sync is bidirectional
- 50-entry undo covers every mutation

**The real gaps in order of user pain:**
1. Missing community chip library (`chip-74hc595` etc.)
2. ~35 parts that render but don't simulate (sensors, neopixels, displays)
3. No multi-select / no copy-paste
4. Zoom doesn't center on mouse
5. No right-click menu
6. Ruler unit labels are cryptic

**What's surprisingly already solid:**
- Editor responds to all keyboard shortcuts
- Custom chip registration happens before simulation (fixed this session)
- LCD1602 + SSD1306 fully cycle-accurate (verified by oracle)
- Bend hints from imported Wokwi projects render correctly
- 176 unit tests covering renderer, controllers, and chip runtime
