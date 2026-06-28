// Minimal UF2 loader for rp2040js — parses a UF2 image (Uint8Array) and writes
// its payload into the RP2040 flash. Self-contained (no `uf2` package, no fs).

import type { RP2040 } from "rp2040js";

const FLASH_START_ADDRESS = 0x10000000;

const UF2_MAGIC_START0 = 0x0a324655;
const UF2_MAGIC_START1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const UF2_FLAG_NOT_MAIN_FLASH = 0x00000001;
const UF2_BLOCK_SIZE = 512;

/**
 * Load a UF2 image into the RP2040 flash. Each 512-byte block carries a target
 * address and payload; blocks flagged "not main flash" are skipped.
 */
export function loadUF2(image: Uint8Array, rp2040: RP2040): void {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  for (let offset = 0; offset + UF2_BLOCK_SIZE <= image.length; offset += UF2_BLOCK_SIZE) {
    const magic0 = view.getUint32(offset + 0, true);
    const magic1 = view.getUint32(offset + 4, true);
    const magicEnd = view.getUint32(offset + 508, true);
    if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1 || magicEnd !== UF2_MAGIC_END) {
      continue; // not a valid UF2 block
    }
    const flags = view.getUint32(offset + 8, true);
    if (flags & UF2_FLAG_NOT_MAIN_FLASH) continue;
    const targetAddr = view.getUint32(offset + 12, true);
    const payloadSize = view.getUint32(offset + 16, true);
    const flashOffset = targetAddr - FLASH_START_ADDRESS;
    if (flashOffset < 0 || flashOffset + payloadSize > rp2040.flash.length) continue;
    rp2040.flash.set(image.subarray(offset + 32, offset + 32 + payloadSize), flashOffset);
  }
}
