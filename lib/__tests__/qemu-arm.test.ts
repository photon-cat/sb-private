// Phase 4 (M3–M7 backend): native QEMU runs ARMv7-M Thumb-2 firmware that the
// in-browser M0+ core cannot. Skips cleanly when qemu-system-arm isn't installed.

import { describe, it, expect } from "vitest";
import path from "path";
import { existsSync } from "fs";
import { runQemuArm, qemuArmAvailable } from "../mcu/qemu/qemu-arm-runner";

const ELF = path.join(__dirname, "fixtures", "qemu-arm", "firmware.elf");
const canRun = qemuArmAvailable() && existsSync(ELF);

describe("QEMU ARM backend (Cortex-M4 / Thumb-2)", () => {
  it("executes Thumb-2 (mla + udiv) and reports via semihosting", () => {
    if (!canRun) return; // qemu-system-arm not present — skip
    const r = runQemuArm(ELF, { cpu: "cortex-m4", timeoutMs: 15_000 });
    // mla: 7*6+5 = 47 ; udiv: 47/7 = 6 — both ARMv7-M-only ops.
    expect(r.output).toContain("M4=47/6");
  });
});
