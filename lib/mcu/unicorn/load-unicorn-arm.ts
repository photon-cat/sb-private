// Loader + typed surface for the vendored unicorn.js ARM engine.
//
// The vendored bundle (vendor/unicorn-arm/unicorn-arm.bundle.cjs) is a 2016-era
// Emscripten asm.js build of Unicorn Engine v1.0 with a `uc` wrapper. It's pure
// JS (no native binary, no external .wasm), so it runs in Node AND the browser —
// it is the in-browser ARMv7-M (Thumb-2) core. This module wraps the loose `uc`
// global in a typed, minimal interface so the host can stay strict TypeScript.
//
// Loading uses dynamic import() of the .cjs bundle, which resolves identically
// under vitest/Node and under the Next/webpack browser bundle (CommonJS interop),
// so the SAME core runs headless in tests and live in the browser. The 2.3 MB
// asm.js is therefore code-split and only fetched when an ARM sim actually starts.

/** Subset of Unicorn register ids we use (ARM). Values from unicorn-constants.js. */
export const ARM_REG = {
  R0: 66, R1: 67, R2: 68, R3: 69, R4: 70, R5: 71, R6: 72, R7: 73,
  R8: 74, R9: 75, R10: 76, R11: 77, R12: 78,
  SP: 12, LR: 10, PC: 11,
} as const;

/** Hook-type and permission constants (from unicorn-constants.js). */
export const UC = {
  ARCH_ARM: 1,
  MODE_THUMB: 16,
  PROT_ALL: 7,
  HOOK_CODE: 4,
  HOOK_MEM_READ: 1024,
  HOOK_MEM_WRITE: 2048,
  HOOK_INTR: 32,
} as const;

/** A Unicorn memory-access hook callback (low 32 bits of addr/value only). */
export type MemHook = (
  handle: unknown,
  type: number,
  addrLo: number,
  addrHi: number,
  size: number,
  valLo: number,
  valHi: number,
  userData: unknown,
) => void;

export type CodeHook = (
  handle: unknown,
  addrLo: number,
  addrHi: number,
  size: number,
  userData: unknown,
) => void;

/** Typed view of a unicorn.js engine instance. */
export interface UnicornEngine {
  mem_map(address: number, size: number, perms: number): void;
  mem_write(address: number, bytes: number[] | Uint8Array): void;
  mem_read(address: number, size: number): Uint8Array;
  reg_write_i32(regid: number, value: number): void;
  reg_read_i32(regid: number): number;
  emu_start(begin: number, until: number, timeout: number, count: number): void;
  emu_stop(): void;
  hook_add(
    type: number,
    cb: MemHook | CodeHook,
    userData: unknown,
    begin: number,
    end: number,
  ): unknown;
  close(): void;
}

export interface UcModule {
  version(): number;
  arch_supported(arch: number): number;
  Unicorn: new (arch: number, mode: number) => UnicornEngine;
}

/** Validate a freshly-imported `uc` object and return it typed. */
export function wrapUc(raw: unknown): UcModule {
  const uc = raw as UcModule | undefined;
  if (!uc?.Unicorn) {
    throw new Error("unicorn.js ARM bundle loaded but `uc.Unicorn` is missing");
  }
  return uc;
}

let cached: UcModule | undefined;

// Assembled at runtime (not a literal) so bundlers can't constant-fold it into a
// traced require of the asm.js source — see loadUnicornArm()'s Node branch.
const BUNDLE = ["..", "..", "..", "vendor", "unicorn-arm", "unicorn-arm.bundle.cjs"].join("/");

// In the browser the same bundle is served as a static asset (public/), fetched
// and evaluated at runtime instead of being imported through the bundler — see
// loadUnicornArm() for why.
const BROWSER_URL = "/vendor/unicorn-arm/unicorn-arm.bundle.js";

/**
 * Load the vendored unicorn.js ARM engine. Cached after first call (the asm.js
 * module is multi-MB).
 *
 * The asm.js bundle uses sloppy-mode constructs (duplicate parameter names) that
 * a strict ESM `import()` rejects, so under Node/vitest we load it via CommonJS
 * `require` (sloppy). In the browser (webpack/Next) a dynamic `import()` of the
 * same CJS module is wrapped in a sloppy function scope and code-split.
 */
export async function loadUnicornArm(): Promise<UcModule> {
  if (cached) return cached;
  const isNode =
    typeof process !== "undefined" && !!process.versions?.node;
  let raw: unknown;
  if (isNode) {
    // Node / vitest (even under jsdom): CommonJS require keeps sloppy mode.
    // The bundlers must NOT try to resolve the Node builtin "module" for the
    // browser graph — this branch only ever runs under Node, so tell webpack,
    // Turbopack and Vite to leave the import as a runtime import.
    const { createRequire } = await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ "module"
    );
    const req = createRequire(import.meta.url);
    // Build the path at runtime: a literal `req("…bundle.cjs")` is traced by
    // webpack/Turbopack (they special-case createRequire), which then chokes on
    // the asm.js sloppy-mode source. A computed string is opaque to them.
    raw = (req(BUNDLE) as { uc?: unknown }).uc;
  } else {
    // Browser: the asm.js bundle contains a Node-environment branch that
    // statically references the `fs`/`path` builtins. Importing it through the
    // bundler makes webpack/Turbopack try (and fail) to resolve those. So we
    // DON'T bundle it — we fetch the vendored CJS as text and evaluate it in a
    // sloppy `Function` scope (asm.js uses duplicate parameter names that strict
    // ESM rejects). Its Node branch is gated on `typeof window`, so the `require`
    // calls never run here; we pass `require: undefined` so even the env probe
    // (`typeof require === "function"`) resolves to false.
    const res = await fetch(BROWSER_URL);
    if (!res.ok) {
      throw new Error(`unicorn-arm bundle fetch failed: ${res.status} ${res.statusText}`);
    }
    const src = await res.text();
    const factory = new Function(
      "module",
      "exports",
      "require",
      `${src}\n;return (typeof module !== "undefined" && module.exports) ? module.exports : {};`,
    ) as (m: { exports: { uc?: unknown } }, e: unknown, r: undefined) => { uc?: unknown };
    const mod = { exports: {} as { uc?: unknown } };
    raw = factory(mod, mod.exports, undefined).uc;
  }
  cached = wrapUc(raw);
  return cached;
}
