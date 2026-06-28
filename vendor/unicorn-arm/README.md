# Vendored: unicorn.js (ARM)

`unicorn-arm.bundle.cjs` is the [unicorn.js](https://github.com/AlexAltea/unicorn.js)
ARM target — the Unicorn Engine ARM CPU (QEMU-derived) cross-compiled to asm.js —
concatenated with `src/libelf-integers.js` and a CommonJS export footer.

- **Engine:** Unicorn v1.0 (`uc.version()` → 256 = 0x0100).
- **Arch/mode:** `uc.ARCH_ARM` + `uc.MODE_THUMB`. Executes full Thumb-2 (`mla`,
  `udiv`, …) that the ARMv6-M (M0+) core in `lib/mcu/cortex-m0-host.ts` cannot.
- **Self-contained:** asm.js, no external `.wasm`/`.mem`; runs in Node and browsers.
- **License:** GPLv2 (see header in the bundle). Flagged for review before
  shipping in a proprietary client bundle.

Consumed by `lib/mcu/unicorn/load-unicorn-arm.ts`.
