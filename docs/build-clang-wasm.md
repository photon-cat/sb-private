# Build recipe — multi-target `clang.wasm` (WebAssembly + ARM + AVR)

Status: **Recipe** (Phase 2 of [the roadmap](./roadmap-in-browser-compile.md)). Not yet run.
Produces the artifact the in-browser compiler needs; drop it into `app/avr-wasm-test/page.tsx`
(package-name field) to validate.

## Why this exists

The spike ([phase1-avr-wasm-spike.md](./phase1-avr-wasm-spike.md)) proved clang runs in the browser,
but the only off-the-shelf `clang.wasm` (Wasmer `clang/clang`) is built `WebAssembly`-only — no ARM,
no AVR. No prebuilt clang.wasm with embedded targets exists publicly. We build our own once; it then
covers AVR + every Cortex-M (RP2040, STM32F4/H7, …) from a single artifact.

## Output

- `clang.wasm` + `lld` (i.e. `ld.lld` for ARM) built for **WASIX**, with backends
  `WebAssembly;ARM;AVR`, `MinSizeRel`.
- `compiler-rt` builtins cross-built for `arm` and `avr` (clang needs `libclang_rt.builtins-*`).
- Clang's own resource headers (`lib/clang/<v>/include`).
- Packaged as a Wasmer package (`wasmer.toml`) so `@wasmer/sdk` `Wasmer.fromRegistry("<ns>/clang-embedded")`
  (or `fromFile`) loads it unchanged.

Target size: **~30 MB compressed** (Wasmer's own clang target), cached once in the browser. Backends
add little — clang's bulk is frontend+optimizer, not targets.

> Sysroots (newlib for ARM, avr-libc for AVR) and the Arduino/Pico/STM32 cores are **NOT** in this
> package — they ship as precompiled `.a` via the package-manager CAS (roadmap Phase 5). This package
> is just the compiler + linker + builtins.

## Approach

clang must run *as* a wasm module, so it's a **cross-build**: host LLVM builds an LLVM that targets
`wasm32-wasix` as its host platform, while the *backends compiled in* are ARM/AVR/WebAssembly. Same
shape as Wasmer's clang and [soedirgo/llvm-wasm](https://github.com/soedirgo/llvm-wasm), with extra
`LLVM_TARGETS_TO_BUILD`.

### Prereqs
- LLVM/Clang source (pin a release, e.g. `llvmorg-18.x`).
- A **native** clang/LLVM of the *same version* (provides `llvm-tblgen`/`clang-tblgen` for the cross
  build).
- **WASIX sysroot + wasix-libc** (Wasmer) — WASIX, not plain WASI: clang needs `setjmp`/`longjmp`,
  threads, and fuller POSIX than WASI provides. (Plain wasi-sdk is insufficient; that limitation is
  exactly what Wasmer's WASIX work removed.)
- `wasmer` CLI for packaging.

### Stage 1 — native tools (for tblgen)
```bash
cmake -S llvm -B build-native -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_TARGETS_TO_BUILD="WebAssembly;ARM;AVR" \
  -DLLVM_ENABLE_PROJECTS="clang;lld"
ninja -C build-native llvm-tblgen clang-tblgen
```

### Stage 2 — cross-build clang/lld to WASIX
```bash
cmake -S llvm -B build-wasix -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_CROSSCOMPILING=ON \
  -DCMAKE_TOOLCHAIN_FILE=<wasix-cmake-toolchain>.cmake \
  -DCMAKE_SYSROOT=<wasix-sysroot> \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_TARGETS_TO_BUILD="WebAssembly;ARM;AVR" \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasi \
  -DLLVM_TABLEGEN=$PWD/build-native/bin/llvm-tblgen \
  -DCLANG_TABLEGEN=$PWD/build-native/bin/clang-tblgen \
  -DLLVM_ENABLE_THREADS=ON \
  -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_BUILD_TOOLS=OFF
ninja -C build-wasix clang lld
```
Then `wasm-opt -Oz` (Binaryen) and `wasm-strip` the resulting `clang.wasm`/`lld.wasm`.

### Stage 3 — compiler-rt builtins for arm + avr
Cross-build `compiler-rt` `builtins` for `armv7m-none-eabi` (and `cortex-m0plus`/`m4`/`m7` as needed)
and `avr`, using the freshly built clang. Bundle as `lib/clang/<v>/lib/<triple>/libclang_rt.builtins.a`.

### Stage 4 — package for @wasmer/sdk
`wasmer.toml` with `clang.wasm` as the `clang` command + `lld.wasm` as `ld.lld`, and a `[fs]` mapping
that bundles the clang resource headers + compiler-rt builtins. `wasmer publish` (or host the package
tarball and load via `Wasmer.fromFile`).

## Driver note (learned from the spike)

The WASIX clang **cannot fork** to spawn a separate `-cc1` for a standalone `-c` step
(`error: unknown integrated tool '-cc1'`). Two consequences for how we drive it:

1. Prefer **one-shot driver invocations** (compile *and* link in a single `clang` call) where possible
   — that path works today.
2. For staged builds (compile each TU, then link many), **invoke the phases explicitly from JS**:
   `clang -cc1 …` for codegen, then `ld.lld …` for the link — rather than relying on the driver to
   spawn sub-tools. JS is the orchestrator (there is no process model in the tab).

## Verification (when the artifact exists)

1. In `app/avr-wasm-test/page.tsx`, set the package field to the new package. Expect
   `clang -print-targets` to list `arm`, `avr`, `wasm32`.
2. **ARM:** `clang --target=arm-none-eabi -mcpu=cortex-m0plus -c blink.c` → ARM ELF object;
   `ld.lld` with a Cortex-M linker script → `.elf`; `llvm-objcopy -O binary` → `.bin`/`.uf2` →
   load into `rp2040-runner` / `unicorn-arm-host`.
3. **AVR:** `clang --target=avr -mmcu=atmega328p -c blink.c` → AVR ELF object. Linking likely needs
   `avr-ld` (separate, roadmap Phase 4); until then this validates **codegen only**.
4. Size check: compressed package ≤ ~40 MB.

## Open items
- Confirm WASIX toolchain availability/version vs the LLVM release pinned.
- AVR linking: evaluate `ld.lld` AVR relocations first; if insufficient, scope `avr-ld`→WASM (GPL —
  license review) as a separate package.
- Decide registry namespace vs self-hosted `fromFile` (avoids a public Wasmer package).
