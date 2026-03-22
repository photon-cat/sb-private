// ESP32 .bin firmware loader
// Format: ESP-IDF app image (magic 0xE9)
import { MemoryBus } from "./memory-bus.js";

// ESP image header (24 bytes)
const ESP_IMAGE_MAGIC = 0xe9;
const ESP_IMAGE_HEADER_LEN = 24;
const ESP_SEGMENT_HEADER_LEN = 8;

// No separate extended header — segments start immediately after the 24-byte main header

export interface LoadResult {
  entryPoint: number;
  segments: { addr: number; size: number }[];
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    (data[offset]) |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] << 24)
  ) >>> 0;
}

export function loadESP32Bin(binData: Uint8Array, memory: MemoryBus): LoadResult {
  if (binData.length < ESP_IMAGE_HEADER_LEN) {
    throw new Error("Firmware too small for ESP32 image header");
  }

  const magic = binData[0];
  if (magic !== ESP_IMAGE_MAGIC) {
    throw new Error(`Invalid ESP32 firmware magic: 0x${magic.toString(16)} (expected 0xE9)`);
  }

  const segmentCount = binData[1];
  // bytes 2-3: SPI flash mode, speed, size
  const entryPoint = readU32(binData, 4);

  // Skip hash_appended byte and other reserved fields
  // WP pin, chip id, etc. in extended header

  const segments: { addr: number; size: number }[] = [];
  let offset = ESP_IMAGE_HEADER_LEN;

  for (let i = 0; i < segmentCount; i++) {
    if (offset + ESP_SEGMENT_HEADER_LEN > binData.length) {
      throw new Error(`Firmware truncated at segment ${i}`);
    }

    const loadAddr = readU32(binData, offset);
    const dataLen = readU32(binData, offset + 4);
    offset += ESP_SEGMENT_HEADER_LEN;

    if (offset + dataLen > binData.length) {
      throw new Error(`Firmware truncated: segment ${i} needs ${dataLen} bytes at offset ${offset}`);
    }

    const segmentData = binData.subarray(offset, offset + dataLen);
    memory.writeBlock(loadAddr, segmentData);
    segments.push({ addr: loadAddr, size: dataLen });

    offset += dataLen;
    // Segments are NOT aligned in the image format (alignment is per-section in ELF, not in bin)
  }

  return { entryPoint, segments };
}
