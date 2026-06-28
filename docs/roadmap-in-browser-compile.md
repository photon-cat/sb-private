# Roadmap — Full In-Browser Compile Chain (AVR + RP2040)

Status: **Roadmap** (forward-looking). Branch: `full-local`.

## Goal

Move firmware **compilation** from the server into the browser, so SparkBench can compile **and**
simulate an Arduino sketch entirely client-side — no build server, optionally offline. AVR (ATmega328P)
and RP2040 (Pico) are the two targets from the outset.

## What we already have (and why it matters)

| Building block | Where | Role in this roadmap |
|---|---|---|
| avr8js (CPU sim) | `lib/avr-runner.ts` (`loadHex`) | Consumes compiled `hex` — the **stable target** for the AVR compiler output |
| rp2040js (CPU sim) | `lib/rp2040-runner.ts`, `lib/rp2040/load-flash.ts` (UF2) | Consumes `uf2`/`hex` — stable target for RP2040 output |
| WASI-SDK `clang++ → wasm32` | `lib/sim/verilog-chip-builder.ts` | **Precedent**: the codebase already drives an LLVM/clang toolchain to WASM for Verilog chips |
| Package manager + CAS | [package-manager-plan.md](./package-manager-plan.md) | Supplies pinned, vendored deps + precompiled archives to *whatever* compiler runs |
| Hermetic server build | build route + `lib/sandbox.ts` | The **fallback** every phase preserves |

## The invariant that makes this safe

> The **lockfile schema, CAS keys, and simulator load APIs** (`AVRRunner.loadHex`,
> `RP2040Runner` UF2 loading) stay stable across every phase.

Because the compiler's only job is "sketch + locked deps → `hex`/`uf2`", the compile backend can move
server → browser **without touching the package manager or the simulators**. Each phase swaps the
backend behind a fixed contract and keeps the server build as a fallback.

---

## Phases

### Phase 0 — Hermetic server build *(foundation — see package-manager-plan.md)*
Reproducible, vendored, portable dependencies feeding the existing PlatformIO build through
`lib_extra_dirs`. Establishes the lockfile + CAS contracts the later phases depend on.
**Status: planned (Phase 0 doc).** Everything below builds on this.

### Phase 1 — Toolchain-in-WASM spike (AVR)
Probe `clang` + the LLVM **AVR backend** compiled to WASM, reusing the codebase's existing
WASI-SDK `clang++ → wasm32` experience (`lib/sim/verilog-chip-builder.ts`).

- **Goal:** compile a blink sketch to a linkable object **in the browser**.
- **Expected wall:** linking. `lld`'s AVR support is weak; we likely need `avr-ld`/binutils in WASM.
  This phase exists to *find that wall precisely*, not to ship.
- **Deliverable:** a go/no-go memo — does a clean compile+link path exist, and at what bundle size?

> Note: empirical context already gathered — Pyodide can *import* PlatformIO but `subprocess`
> raises `OSError: emscripten does not support processes`. So PlatformIO/arduino-cli orchestration
> cannot run in the browser; only the compiler/linker binaries-as-WASM can. This phase tests exactly that.

### Phase 2 — Precompiled core + libc via CAS
Ship `avr-libc` and the Arduino AVR core as **precompiled `.a` archives**, keyed by
`(arch × board-config)` in the **same CAS** the package manager already populates.

- The browser then compiles **only the user's translation unit(s)** and **links** against archives —
  a far smaller job than compiling the whole core every time.
- Reuses the CAS keying and `dependency_cache` patterns from Phase 0.

### Phase 3 — Wire in-browser `hex` into the simulator
Feed the WASM-compiler output straight into the existing `AVRRunner` (`lib/avr-runner.ts`,
`loadHex`) — the contract is already there.

- **UX:** instant "fast preview" compile for single-file sketches; no server round-trip.
- **Fallback:** anything the in-browser path can't handle (multi-lib, exotic boards) routes to the
  Phase-0 server build automatically.

### Phase 4 — RP2040
Extend to ARM: `clang` / `arm-none-eabi` for Cortex-M0+ in WASM (heavier than AVR — Pico SDK /
arduino-pico core, more C++).

- Reuse `lib/rp2040-runner.ts` + `lib/rp2040/load-flash.ts` (UF2 loader already proven against a
  real PlatformIO `.uf2` fixture).
- Precompiled Pico core archives via CAS, same as Phase 2.

### Phase 5 — Fully offline PWA
Cache CAS archives + the toolchain WASM in IndexedDB; compile **and** simulate with zero server.

- Server reduces to storage/CDN + the export endpoint.
- This is the literal "fully local MCU toolchain in the browser" end state.

---

## Phase dependency graph

```
Phase 0 (lockfile + CAS + hermetic build)  ──►  Phase 1 (AVR toolchain WASM spike)
                                                     │
                                                     ▼
                                            Phase 2 (precompiled core/libc in CAS)
                                                     │
                                                     ▼
                                            Phase 3 (browser hex → AVRRunner; server fallback)
                                                     │
                                                     ▼
                                            Phase 4 (RP2040 ARM toolchain)
                                                     │
                                                     ▼
                                            Phase 5 (offline PWA, zero server)
```

## Risks / open questions

- **Linker wall (Phase 1)** is the make-or-break. If `lld` AVR is unusable and binutils-to-WASM is
  intractable, the in-browser bet stalls at Phase 1 — but Phase 0 still delivers reproducible,
  portable, hermetic builds on its own. The roadmap degrades gracefully.
- **Bundle size** — a full AVR toolchain WASM is tens of MB. Phase 2 (precompiled core/libc) and
  Phase 5 (IndexedDB caching) are what make the download cost acceptable.
- **GPLv2 surfaces** — GCC/binutils are GPL; the vendored unicorn-arm bundle is already flagged for
  license review. Any shipped toolchain WASM needs the same review.
- **Output parity** — clang-AVR may not be bit-identical to standard avr-gcc. Keep the server build
  authoritative; treat browser compile as a fast preview until parity is validated.

## Decision rule

Proceed phase-by-phase. **Do not commit to Phase 1+ until Phase 0 ships** and the fast-preview UX is
shown to be worth the toolchain R&D. Phase 0 is independently valuable; Phases 1–5 are an optional,
reversible bet layered on top of stable contracts.
