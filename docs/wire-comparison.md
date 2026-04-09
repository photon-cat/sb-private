# Wire Comparison: SparkBench vs Wokwi

This document captures the results of running `scripts/compare-wires.ts` against the cd4051-mux project on both SparkBench and the official Wokwi web editor, plus the infrastructure built to support cross-simulator wire diffing.

## Summary

```
╔══════════════════════════════════════════════════════════════════╗
║ Wire comparison: cd4051-mux                                      ║
╚══════════════════════════════════════════════════════════════════╝

Total wires: wokwi=47  sparkbench=47

Wires by color:
  color       wokwi      sb  diff
  red            14      14  ✓
  black          10      11  +1   (intentional — INH wire color)
  green          10      10  ✓
  gold            8       8  ✓
  violet          4       3  -1   (intentional — INH wire color)
  gray            1       1  ✓

Per-endpoint match:   45 of 47 endpoint groups match
Topology comparison:  14 of 42 topologically identical, 28 differ by +1 bridge segment
```

**Bottom line:** the two simulators render **the same 47 wires between the same endpoints with identical colors** (one intentional divergence from my diagram edit). Shape divergence exists for 28 wires because SparkBench's custom chip pin positions don't line up with Wokwi's exact pin positions — SparkBench's auto-router inserts a consistent ~18 px bridge segment at the end of each wire to reach its chip pin.

## How the comparison works

Three Playwright scripts, all runnable headlessly:

### `scripts/extract-wires.ts`

Unified extractor that works against **both** Wokwi and SparkBench URLs. Walks the live DOM, finds the simulator canvas SVG (picks the one with the most distinct stroke colors — this tiebreaker matters because SparkBench's canvas layers have a ruler SVG, a grid SVG, a wire SVG, and an interaction-hit SVG, all sized identically), then:

1. For every `line` / `polyline` / `path` child:
   - Skips invisible (`stroke:none`, `transparent`, or `strokeWidth < 0.5`)
   - Computes the element's screen-space points via `getScreenCTM()` + point matrix transforms
   - For `path` elements (Wokwi), samples `getPointAtLength()` every ~5 px to reconstruct the path
   - For `polyline` elements (SparkBench), reads each vertex
2. Tags every wire with its nearest start/end part by bounding-box edge distance (not center, so pin-terminated wires resolve correctly even when the wire ends outside the part body)
3. Dumps a JSON record per wire: `{ index, color, points, startPart, endPart, bbox }`

Output is a stable JSON format usable by any diff tool. Run:

```bash
npx tsx scripts/extract-wires.ts wokwi       https://wokwi.com/projects/343522915673702994
npx tsx scripts/extract-wires.ts sparkbench  http://localhost:3000/projects/cd4051-mux
```

### `scripts/compare-wires.ts`

Loads dumps from both extractors for the same project slug and:

1. **Color bucketing** — normalizes RGB strings across the two simulators' slightly different palettes (`rgb(255,0,0)` vs `rgb(238,0,0)` both classified as `red`)
2. **Endpoint grouping** — pairs wires by `(sorted startPart+endPart, colorBucket)` so direction-flipped wires still match
3. **Topology fingerprint** — collapses each wire into a sequence of N/S/E/W direction changes (e.g. `"SE"` for an L-bend going south then east). Invariant to:
   - Wokwi's 5 px path sampling vs SparkBench's 2-point polylines
   - Absolute position differences between the two coordinate systems
   - Overall zoom / scale factors
4. **Reporting** — prints wire count, color histogram, per-group endpoint counts, and per-wire topology matches

Usage:
```bash
npx tsx scripts/compare-wires.ts cd4051-mux
```

### `scripts/dump-wokwi-chip.ts`

Fetches the raw `outerHTML` of a single Wokwi part by id. Used to extract the authoritative CD4051B breakout SVG source (and confirmed Wokwi renders `chip-*` community parts as `div[wokwi-controller="chip-..."]` wrappers containing an inline `<svg width="30mm" height="22.32mm" viewBox="...">`).

## What we confirmed is identical

| Metric | SparkBench | Wokwi | Match |
|---|---|---|---|
| Wire count | 47 | 47 | ✓ |
| Red wires (VCC) | 14 | 14 | ✓ |
| Green wires (digital) | 10 | 10 | ✓ |
| Gold wires (pot SIG) | 8 | 8 | ✓ |
| Gray wires (COMIO) | 1 | 1 | ✓ |
| Pot GND daisy chain | 7 | 7 | ✓ |
| Pot VCC daisy chain | 7 | 7 | ✓ |
| pot1:VCC → ic1:VDD | present | present | ✓ |
| pot8:GND → ic1:VSS | present | present | ✓ |
| DIP switch → resistor → Uno chain | 8 green wires | 8 green wires | ✓ |
| LCD I2C wires | 2 green | 2 green | ✓ |
| Uno 5V/GND → LCD | 1 red + 1 black | 1 red + 1 black | ✓ |

All endpoint groups match for every wire in the diagram **except** the `ic1↔uno` black/violet groups (my intentional diagram edit changed INH from Wokwi's `purple` to SparkBench's `black`).

## Where the shapes differ and why

For every **pot→ic1 gold wire**, the topology fingerprints are:

| wire | Wokwi | SparkBench | delta |
|---|---|---|---|
| pot1→ic1 | SE | SE**N** | +1 trailing N |
| pot2→ic1 | SE | SE**N** | +1 trailing N |
| pot3→ic1 | SE | SE**N** | +1 trailing N |
| pot4→ic1 | SWSE | SWSE**N** | +1 trailing N |
| pot5→ic1 | SESW | SESW**N** | +1 trailing N |
| pot6→ic1 | SW | SW**N** | +1 trailing N |
| pot7→ic1 | SW | SW**N** | +1 trailing N |
| pot8→ic1 | SW | SW**N** | +1 trailing N |

**Pattern:** every SparkBench wire has **exactly one extra `N` (north) segment** at the end, roughly 18 px long.

**Root cause:** the diagram.json bend hints (e.g. `["v67.2", "h214.61"]` for pot1→ic1:CIO0) were authored against Wokwi's `chip-cd4051b` element, whose pin positions follow Wokwi's internal coordinate system (pins on the left and right edges of a 30 mm × 22.32 mm rectangle). SparkBench's `CustomChipElement` places pins on the top and bottom rows of a horizontal DIP grid at different y coordinates. When the wire renderer applies the `v67.2`/`h214.61` hints from pot1:SIG, it ends at a point that's ~18 px *north* of where SparkBench's `ic1:CIO0` actually is, so `autoRoute` inserts a final `N` bridge to close the gap.

Wokwi, having authored the hints against its own pin positions, lands directly on the pin with no bridge.

## The fix infrastructure is now in place

This session added `pinPositions` as an optional field in `chip.json`:

```json
{
  "name": "cd4051b",
  "pins": ["CIO4", "CIO6", ...],
  "pinPositions": {
    "CIO4": { "x": 4.80, "y": 3.78 },
    "CIO0": { "x": 108.60, "y": 42.18 },
    ...
  }
}
```

When present, `CustomChipElement` uses these explicit coordinates verbatim instead of the default DIP grid placement. Populating the `pinPositions` map for `cd4051b` with Wokwi's exact coordinates (extracted via `scripts/dump-wokwi-chip.ts`) will eliminate the +18 px bridge segment and give us topologically identical wires.

**Why it wasn't filled in this session:** Wokwi's `chip-cd4051b` uses a *vertical* DIP layout (pins on left/right edges in a 30 mm × 22.32 mm box), while SparkBench's `CustomChipElement` draws its breakout in *horizontal* orientation. Copying Wokwi's pin positions verbatim would put SparkBench's pins on the left/right of the chip body, which would require a second pass to re-author the breakout SVG to match. Tracked as a follow-up.

## Reproducibility

Everything is headless and reproducible:

```bash
# SparkBench dev server running on :3000 is required
npm run dev &

# Extract wire dumps
npx tsx scripts/extract-wires.ts wokwi https://wokwi.com/projects/343522915673702994 > /tmp/wokwi-wires.json
npx tsx scripts/extract-wires.ts sparkbench http://localhost:3000/projects/cd4051-mux > /tmp/sb-wires.json

# Compare
npx tsx scripts/compare-wires.ts cd4051-mux

# Raw comparison output is stashed in /var/folders/.../T/wire-compare-cd4051-mux-<ts>/
# (wokwi.json and sparkbench.json)
```

Exit code 0 if every SparkBench wire matches a Wokwi wire in endpoint+color. Non-zero if any group differs.

## Related artifacts

- `scripts/extract-wires.ts` — unified wire extractor
- `scripts/compare-wires.ts` — comparison driver
- `scripts/dump-wokwi-chip.ts` — single-part HTML dumper
- `scripts/extract-wokwi-dimensions.ts` — all-parts bounding-box + pinInfo dumper
- `lib/chip-json.ts` — `ChipJsonDef` interface now includes `pinPositions?`
- `components/CustomChipElement.ts` — `registerCustomChipElement` accepts and applies `pinPositions`
- `components/DiagramCanvas.tsx` — plumbs `pinPositions` through the project-files pre-registration path
