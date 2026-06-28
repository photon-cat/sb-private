# Verilog / SystemVerilog Custom Chips

SparkBench runs **Verilog/SystemVerilog custom chips locally** — the same HDL→WASM route
Wokwi uses, but Wokwi only does it on their cloud server. Drop a `<name>.chip.sv`
(or `.chip.v`) + `<name>.chip.json` into a project and `sparkbench test`/`simulate`
compiles and simulates it alongside the firmware.

## The transpiler: Verilator

Wokwi's Verilog support transpiles HDL with **Verilator** → C++ → WASM, binding the
Verilated top-level ports to the `wokwi-api.h` pin API. The Verilog→WASM step runs on
Wokwi's **server**; the open-source `wokwi-cli chip compile` only handles C/C++
(verified: it errors with `unknown file type` on `.v`). SparkBench implements the same
route locally.

## Pipeline (lib/sim/verilog-chip-builder.ts)

```
<name>.chip.sv
   │  parseVerilogPorts()        — extract top module + ANSI port list (dir, width)
   │  generateShim()             — C++ shim binding ports ⇄ Wokwi pin API
   ▼
verilator --cc                   — HDL → C++ (Vname.{h,cpp}, runtime)
   ▼
WASI-SDK clang++                 — shim + Verilated model + verilated.cpp → WASM
   ▼
CustomChipRuntime                — instantiate + bridge to avr8js GPIO
```

**Port → pin mapping** (in the generated shim):
- scalar input (incl. `clk`, `rst`) → input pin, `pin_watch(BOTH)` → set member, `eval()`, write outputs
- scalar output → output pin, written after every `eval()`
- vector port `[N:0]` → one pin per bit (`NAME0`, `NAME1`, …)

An MCU-driven `clk` needs no special handling: raising the wired clk pin sets the
Verilated `clk` member and calls `eval()` — a natural posedge.

## Build recipe (the obstacles, solved)

Verilator's runtime assumes a hosted, threaded POSIX environment; WASI doesn't provide
one. The working clang++ flags:

```
--target=wasm32-wasip1-threads --sysroot=$WASI/share/wasi-sysroot
-nostartfiles -pthread -O2 -fno-exceptions -std=gnu++20 -faligned-new -fbracket-depth=4096
-DVL_IGNORE_UNKNOWN_ARCH                 # no VL_CPU_RELAX for wasm (documented escape hatch)
-DCLOCK_PROCESS_CPUTIME_ID=CLOCK_MONOTONIC  # WASI clockid_t is a pointer; map profiling clock
-Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory -Wl,--export-table
shim.cpp obj_dir/V*.cpp verilated.cpp verilated_threads.cpp
```

Keep RTTI on (`dynamic_cast` in `verilated_types.h`). The `timer_t` typedef clashes
between wokwi-api.h (`uint32_t`) and WASI `<time.h>` (`void*`); the shim renames Wokwi's.

## Runtime support (lib/chip-runtime.ts)

A Verilator-linked module imports a **shared** memory and `wasi.thread-spawn`.
`CustomChipRuntime`:
- `parseWasmMemoryImport()` reads the module's memory-import flags; if shared, it
  instantiates `WebAssembly.Memory({ shared: true, maximum })`.
- stubs `wasi.thread-spawn` (returns −1) and `sched_yield` — never invoked, since
  Verilator runs single-threaded here, so the runtime mutexes never contend.
- C-string/`fd_write` reads `.slice()` out of (possibly shared) memory before decoding.

## Verified end-to-end

- `lib/__tests__/verilog-chip.test.ts` — inverter (`y = ~a`), real Verilator WASM.
- `lib/__tests__/verilog-counter.test.ts` — clocked 4-bit counter; counts edges + reset.
- `projects/verilog-counter/` — full project: an Arduino sketch drives `clk`/`rst` over
  GPIO and reads the count back; `sparkbench test verilog-counter` → `COUNT=5`.

Requires Verilator (`brew install verilator` / `apt-get install verilator`) and the
WASI-SDK (auto-installed by `wokwi-cli`). If Verilator is absent, Verilog chips are
skipped with a clear warning. VHDL (`.chip.vhd`) remains unsupported.
