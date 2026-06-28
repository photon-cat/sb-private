// QEMU ARM backend / oracle for STM32 M3–M7 (ARMv7-M, Thumb-2 + FPU/DSP).
//
// Phase 4's production goal is Unicorn-WASM (QEMU's ARM CPU in the browser). That
// WASM build isn't available in every environment, but a NATIVE qemu-system-arm
// is — and it is the same QEMU ARM core. So this wraps native QEMU as:
//   1. the heavyweight M3–M7 execution backend (CI / desktop), and
//   2. the ARM-semantics ORACLE for the differential harness (the ARMv7-M analog
//      of simavr for AVR — see lib/verify/).
//
// The M0+ core (lib/mcu/cortex-m0-host.ts) covers C0/G0/L0 in-browser; this
// covers F1/F4/F7/H7/G4 where full Thumb-2 is required. The CortexM0Host-shaped
// production WASM core for M3–M7 is a drop-in once a Unicorn/QEMU WASM build is
// vendored — this module is the interface + the working native path meanwhile.

import { execFileSync, spawnSync } from "child_process";

const DEFAULT_QEMU = "qemu-system-arm";
/** Cortex-M3/M4 machine with semihosting; flash at 0x0 (matches the fixture). */
const DEFAULT_MACHINE = "lm3s6965evb";

export interface QemuArmOptions {
  /** QEMU binary (default `qemu-system-arm` on PATH). */
  qemuPath?: string;
  /** Board machine (default `lm3s6965evb`, a Cortex-M3). */
  machine?: string;
  /** CPU override, e.g. "cortex-m4", "cortex-m7". */
  cpu?: string;
  /** Hard timeout in ms (default 10s). */
  timeoutMs?: number;
}

export interface QemuArmResult {
  /** Semihosting output the firmware produced (QEMU routes it to stderr). */
  output: string;
  /** True if QEMU was killed by the timeout (firmware didn't SYS_EXIT). */
  timedOut: boolean;
}

/** Is a usable qemu-system-arm present? Tests should skip when false. */
export function qemuArmAvailable(qemuPath = DEFAULT_QEMU): boolean {
  try {
    execFileSync(qemuPath, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an ARM Cortex-M ELF on native QEMU headless and capture its semihosting
 * output. Throws only if QEMU can't be launched at all (check qemuArmAvailable
 * first); a firmware that never exits is reported via `timedOut`.
 */
export function runQemuArm(elfPath: string, opts: QemuArmOptions = {}): QemuArmResult {
  const qemu = opts.qemuPath ?? DEFAULT_QEMU;
  const args = [
    "-machine",
    opts.machine ?? DEFAULT_MACHINE,
    ...(opts.cpu ? ["-cpu", opts.cpu] : []),
    "-kernel",
    elfPath,
    "-semihosting",
    "-nographic",
  ];
  // QEMU writes semihosting console output to stderr; capture both streams.
  const r = spawnSync(qemu, args, {
    timeout: opts.timeoutMs ?? 10_000,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { output, timedOut: r.signal === "SIGTERM" };
}
