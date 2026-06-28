// PNG decode + screenshot diff — backs the MCP sparkbench_diff_screenshots tool.

import { describe, it, expect } from "vitest";
import { encodePngRgba } from "../png-encoder";
import { decodePngToRgba } from "../png-decoder";
import { diffScreenshots, diffRgba } from "../png-diff";

function solid(w: number, h: number, rgba: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = rgba[0]; out[i * 4 + 1] = rgba[1]; out[i * 4 + 2] = rgba[2]; out[i * 4 + 3] = rgba[3];
  }
  return out;
}

describe("png-decoder", () => {
  it("round-trips an RGBA buffer through encode → decode", () => {
    const w = 8, h = 4;
    const src = new Uint8Array(w * h * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 37) & 0xff; // varied values
    const png = encodePngRgba(w, h, src);
    const decoded = decodePngToRgba(png);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(src));
  });

  it("rejects non-PNG input", () => {
    expect(() => decodePngToRgba(new Uint8Array([1, 2, 3, 4]))).toThrow(/signature/);
  });
});

describe("png-diff", () => {
  it("reports a perfect match for identical images", () => {
    const a = encodePngRgba(16, 16, solid(16, 16, [10, 20, 30, 255]));
    const r = diffScreenshots(a, a);
    expect(r.match).toBe(true);
    expect(r.diffPixels).toBe(0);
    expect(r.totalPixels).toBe(256);
    expect(r.diffPng && Array.from(r.diffPng.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("counts differing pixels and flags mismatch", () => {
    const base = solid(4, 4, [0, 0, 0, 255]);
    const changed = solid(4, 4, [0, 0, 0, 255]);
    // Flip two pixels to white.
    changed[0] = changed[1] = changed[2] = 255;
    changed[4] = changed[5] = changed[6] = 255;
    const r = diffRgba(base, changed, 4, 4);
    expect(r.match).toBe(false);
    expect(r.diffPixels).toBe(2);
    expect(r.diffRatio).toBeCloseTo(2 / 16, 5);
  });

  it("throws when dimensions differ", () => {
    const a = encodePngRgba(8, 8, solid(8, 8, [0, 0, 0, 255]));
    const b = encodePngRgba(8, 4, solid(8, 4, [0, 0, 0, 255]));
    expect(() => diffScreenshots(a, b)).toThrow(/dimensions differ/);
  });

  it("honors the threshold (tiny delta below threshold = match)", () => {
    const a = solid(4, 4, [100, 100, 100, 255]);
    const b = solid(4, 4, [102, 100, 100, 255]); // small delta
    expect(diffRgba(a, b, 4, 4, { threshold: 0.3 }).diffPixels).toBe(0);
    expect(diffRgba(a, b, 4, 4, { threshold: 0.0001 }).diffPixels).toBeGreaterThan(0);
  });
});
