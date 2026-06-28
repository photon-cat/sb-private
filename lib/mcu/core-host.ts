// Common surface shared by the two STM32 core hosts so one runner can drive
// either: CortexM0Host (ARMv6-M, rp2040js core) and UnicornArmHost (ARMv7-M,
// unicorn.js). Both already expose these members structurally.

export interface McuCoreHost {
  /** Retired-instruction / cycle counter. */
  readonly cycles: number;
  /** Program counter (next instruction). */
  readonly pc: number;
  /** Stack pointer. */
  readonly sp: number;
  /** Load a raw flash image (offset 0 = 0x08000000). */
  loadFlash(image: Uint8Array): void;
  /** Reset: load SP/PC from the vector table. */
  reset(): void;
  /** Execute one instruction. */
  step(): void;
  /** Execute up to `n` instructions efficiently (batched where the core allows). */
  runBatch(n: number): void;
}
