/**
 * Minimal PNG encoder for RGBA framebuffers.
 *
 * Produces a spec-compliant PNG with IHDR + IDAT + IEND chunks.
 * Uses zlib deflate for the image data. No external dependencies beyond
 * Node's built-in `zlib` and `Buffer`.
 *
 * This exists because our CLI needs to emit PNGs that match the byte
 * layout of `wokwi-cli --screenshot-file` output (128×64 8-bit RGBA) so
 * the two simulators' display output can be compared byte-for-byte.
 */

import { deflateSync } from "zlib";

// --- CRC32 (standard PNG polynomial 0xEDB88320) ---
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBytes, data, crcBytes]);
}

/**
 * Encode a raw 8-bit RGBA pixel array as a PNG.
 * @param rgba Flat RGBA array, row-major: [r0,g0,b0,a0, r1,g1,b1,a1, ...]
 */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePngRgba: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }

  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk (13 bytes)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type = RGBA
  ihdr[10] = 0; // compression = deflate
  ihdr[11] = 0; // filter = standard
  ihdr[12] = 0; // interlace = none

  // IDAT: prepend filter byte (0 = None) to each scanline, then deflate
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
    }
  }
  const idatData = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
