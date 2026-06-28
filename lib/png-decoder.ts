/**
 * Minimal PNG decoder for 8-bit truecolor images.
 *
 * The inverse of {@link ./png-encoder.encodePngRgba}: parses a PNG buffer back
 * into a flat RGBA pixel array. Supports 8-bit color type 6 (RGBA) and type 2
 * (RGB, expanded to RGBA), all five scanline filters (None/Sub/Up/Average/
 * Paeth) and split IDAT chunks. No external dependencies beyond Node's `zlib`.
 *
 * Scope: enough to round-trip our own screenshots and decode the truecolor PNGs
 * the SparkBench / Wokwi display renderers emit. Palette, grayscale, 16-bit and
 * interlaced PNGs are intentionally unsupported (we never produce them).
 */

import { inflateSync } from "zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** Flat 8-bit RGBA, row-major: [r,g,b,a, …]. */
  rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode an 8-bit RGB/RGBA PNG into a flat RGBA array. */
export function decodePngToRgba(png: Uint8Array): DecodedPng {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (png[i] !== SIGNATURE[i]) throw new Error("Not a PNG (bad signature)");
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  const idatParts: Uint8Array[] = [];

  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    const dataStart = offset + 8;

    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
      const interlace = png[dataStart + 12];
      if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8)`);
      if (colorType !== 6 && colorType !== 2) {
        throw new Error(`Unsupported PNG color type ${colorType} (only 2/RGB and 6/RGBA)`);
      }
      if (interlace !== 0) throw new Error("Interlaced PNGs are not supported");
    } else if (type === "IDAT") {
      idatParts.push(png.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }

    offset = dataStart + length + 4; // skip data + CRC
  }

  if (width === 0 || height === 0) throw new Error("PNG missing IHDR");

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatParts.map((p) => Buffer.from(p))));
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error(`PNG data too short: got ${raw.length}, expected ${expected}`);
  }

  // Unfilter scanlines in place into a contiguous channel buffer.
  const unfiltered = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const inRow = y * (stride + 1) + 1;
    const outRow = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[inRow + x];
      const a = x >= channels ? unfiltered[outRow + x - channels] : 0; // left
      const b = y > 0 ? unfiltered[outRow - stride + x] : 0; // up
      const c = x >= channels && y > 0 ? unfiltered[outRow - stride + x - channels] : 0; // up-left
      let recon: number;
      switch (filter) {
        case 0: recon = value; break;
        case 1: recon = value + a; break;
        case 2: recon = value + b; break;
        case 3: recon = value + ((a + b) >> 1); break;
        case 4: recon = value + paeth(a, b, c); break;
        default: throw new Error(`Unknown PNG filter type ${filter}`);
      }
      unfiltered[outRow + x] = recon & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: unfiltered };

  // Expand RGB → RGBA (opaque).
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < unfiltered.length; i += 3, j += 4) {
    rgba[j] = unfiltered[i];
    rgba[j + 1] = unfiltered[i + 1];
    rgba[j + 2] = unfiltered[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}
