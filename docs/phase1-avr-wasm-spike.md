# Phase 1 Spike — In-Browser AVR Compilation (go/no-go)

Status: **Spike complete.** Branch: `full-local`.
Test app: `app/avr-wasm-test/page.tsx` → http://localhost:3000/avr-wasm-test
Roadmap context: [roadmap-in-browser-compile.md](./roadmap-in-browser-compile.md) (Phase 1).

## Question

Can we compile AVR firmware **entirely in the browser** today, using an off-the-shelf
WASM toolchain — or do we have to build the toolchain ourselves?

## TL;DR

**GO, but gated.** Running a real `clang` in the browser works end-to-end. The blocker is
**artifact availability**: the only ready-made `clang.wasm` (Wasmer `clang/clang`) is built for
**WebAssembly targets only** — it has **no AVR backend**. An in-browser AVR compile is therefore
feasible but requires us to **build our own AVR-enabled `clang.wasm` + `lld`**. No code search,
npm package, or CDN artifact shortcuts this.

## How it was tested (empirical, in a real browser)

`app/avr-wasm-test/page.tsx` loads `@wasmer/sdk@0.10.0`, fetches the `clang/clang` package, and runs
staged invocations. `next.config.ts` serves `/avr-wasm-test` with `Cross-Origin-Opener-Policy:
same-origin` + `Cross-Origin-Embedder-Policy: credentialless` so the page is `crossOriginIsolated`
(required for the SDK's threaded `clang.wasm` / SharedArrayBuffer).

### Results

| Stage | Result | Evidence |
|---|---|---|
| Cross-origin isolation | ✅ | `window.crossOriginIsolated === true`, `SharedArrayBuffer` available |
| Load `clang.wasm` in browser | ✅ | `clang/clang` fetched (~100 MB, cached after first run), ready in ~0.3 s warm |
| `clang --version` | ✅ | `clang version 16.0.0`, `Target: wasm32-unknown-wasi` |
| `clang -print-targets` | ⛔ | **Registered targets: `wasm32`, `wasm64` only — no `avr`** |
| `clang --target=avr -c blink.c` | 🚧 blocked | impossible: AVR backend not in this build |
| Positive control: `clang control.c -o control.wasm` | ✅ | 47,333-byte wasm module — toolchain genuinely runs in-browser |

### Notable sub-findings

- The Wasmer `clang/clang` driver **injects wasm-target flags** on every invocation
  (`-matomics`, `-mbulk-memory`, `-mmutable-globals`, `-Wl,--export=__tls_base`, …). It is packaged
  specifically for C→wasm32-wasi, not as a general cross-compiler.
- A standalone `-c` (compile-to-object) step fails with
  `error: unknown integrated tool '-cc1'` — the clang **driver's self-exec for a separate cc1 phase
  doesn't work under WASIX** (no process spawning). The proven-working path is a single
  compile+**link** invocation straight to a final artifact. This matters for how we'd drive a custom
  toolchain: prefer one-shot driver invocations, or invoke the integrated `cc1` directly, rather than
  multi-step `-c`/`-S` pipelines that re-exec.
- Pyodide cross-check (earlier): PlatformIO **imports** under Pyodide but `subprocess` raises
  `OSError: emscripten does not support processes` — confirming orchestrators can't run in-browser;
  only compiler/linker binaries-as-WASM can.

## What this means

1. **The browser runtime is not the wall.** Cross-origin isolation, `@wasmer/sdk`, a 100 MB
   `clang.wasm`, and WASIX all work. clang compiles and links in the tab.
2. **The artifact is the wall.** We need an LLVM build with `LLVM_TARGETS_TO_BUILD` including **AVR**
   (and an AVR-capable linker), compiled to WASIX/WASM. That artifact does not exist publicly.
3. **The linker is the second wall** (not yet reached here). Even with AVR codegen, producing a
   loadable `.hex` needs an AVR linker + `avr-libc`/crt + the Arduino core. `lld`'s AVR support is
   limited; we may need `avr-ld` (binutils) in WASM. This is the Phase 2 risk and must be validated
   right after a custom clang.wasm exists.

## Recommended path (if we pursue Phase 1)

1. **Build an AVR-enabled `clang.wasm`.** Compile LLVM/clang to WASIX with
   `-DLLVM_TARGETS_TO_BUILD="WebAssembly;AVR"` (WebAssembly kept so the same binary can self-host /
   run under wasmer-js). Package it the way Wasmer packages `clang/clang`. This is a CI build job
   (hours), not an in-session task.
2. **Validate codegen** in the existing test page (drop the custom package name into
   `Wasmer.fromRegistry(...)`): expect `-print-targets` to list `avr` and
   `clang --target=avr -mmcu=atmega328p -c blink.c` to emit an AVR ELF object. The page already
   branches on AVR-present and will exercise this with no further changes.
3. **Probe the linker wall.** Attempt `ld.lld` for AVR; if it can't relocate AVR, evaluate building
   `avr-ld`/binutils to WASM. Decide GO/NO-GO on Phase 2 from this result.
4. **Ship precompiled `avr-libc` + Arduino core `.a`** via the package-manager CAS
   (see [package-manager-plan.md](./package-manager-plan.md)) so the browser only compiles the user's
   translation unit and links against archives.
5. **Wire `hex` → `AVRRunner`** (`lib/avr-runner.ts`, `loadHex`) — contract already exists; the test
   page can load a produced hex straight into avr8js.

## Cost / risk notes

- **Bundle size:** a full clang.wasm is ~100 MB uncompressed. Acceptable only with caching
  (IndexedDB / service worker) — i.e. Phase 5 of the roadmap is what makes this pleasant, not Phase 1.
- **Build ownership:** we'd own a custom LLVM-to-WASM build (GPL/Apache-2.0-with-LLVM-exception
  review needed, same as the vendored unicorn-arm bundle already flagged).
- **Parity:** clang-AVR is not guaranteed bit-identical to standard avr-gcc. Keep the **server build
  authoritative**; treat in-browser compile as a fast preview until parity is validated.

## Decision

The in-browser-compile bet is **technically viable** — the hard runtime questions are answered
positively. It is **not blocked by feasibility; it is blocked by a build artifact we must produce.**
Recommend **not** starting the LLVM-to-WASM build until [Phase 0 (package manager + hermetic build)]
(./package-manager-plan.md) ships, per the roadmap's decision rule — Phase 0 delivers reproducible,
portable, vendored builds on its own and is the prerequisite the in-browser compiler plugs into.
