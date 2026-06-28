/**
 * Compare two PNG screenshots pixel-by-pixel.
 *
 * A small, dependency-free pixelmatch: decodes both PNGs, counts differing
 * pixels using a perceptual (YIQ) distance threshold, and renders a diff image
 * (unchanged pixels dimmed to grayscale, changed pixels painted red). Used by
 * the MCP `sparkbench_diff_screenshots` tool for cross-sim visual comparison.
 */

import { decodePngToRgba } from "./png-decoder";
import { encodePngRgba } from "./png-encoder";

export interface DiffResult {
  match: boolean;
  /** Number of pixels that differ beyond the threshold. */
  diffPixels: number;
  totalPixels: number;
  /** diffPixels / totalPixels, 0..1. */
  diffRatio: number;
  width: number;
  height: number;
  /** Diff visualization (PNG bytes), present unless `includeImage` is false. */
  diffPng?: Buffer;
}

export interface DiffOptions {
  /**
   * Matching sensitivity, 0..1 (default 0.1). Smaller = stricter. A pixel
   * counts as different when its YIQ distance exceeds this fraction of the
   * maximum possible distance.
   */
  threshold?: number;
  /** Render the diff PNG (default true). */
  includeImage?: boolean;
}

// Max possible squared YIQ distance, used to scale the threshold (from pixelmatch).
const MAX_DELTA = 35215;

/** Squared YIQ color delta between two RGBA pixels (alpha blended over white-ish). */
function colorDelta(a: Uint8Array, b: Uint8Array, i: number): number {
  const r1 = a[i], g1 = a[i + 1], b1 = a[i + 2];
  const r2 = b[i], g2 = b[i + 1], b2 = b[i + 2];
  const y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);
  const q = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
  const iq = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
  return 0.5053 * y * y + 0.299 * q * q + 0.1957 * iq * iq;
}

const rgb2y = (r: number, g: number, b: number) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const rgb2i = (r: number, g: number, b: number) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
const rgb2q = (r: number, g: number, b: number) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;

/** Diff two decoded RGBA buffers of equal dimensions. */
export function diffRgba(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  opts: DiffOptions = {},
): DiffResult {
  const threshold = opts.threshold ?? 0.1;
  const includeImage = opts.includeImage ?? true;
  const maxDelta = MAX_DELTA * threshold * threshold;
  const totalPixels = width * height;

  const out = includeImage ? new Uint8Array(totalPixels * 4) : undefined;
  let diffPixels = 0;

  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    const delta = colorDelta(a, b, i);
    if (delta > maxDelta) {
      diffPixels++;
      if (out) {
        out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
      }
    } else if (out) {
      // Dim the unchanged pixel to grayscale so diffs stand out.
      const gray = Math.round(rgb2y(a[i], a[i + 1], a[i + 2]) * 0.4 + 153);
      out[i] = gray; out[i + 1] = gray; out[i + 2] = gray; out[i + 3] = 255;
    }
  }

  return {
    match: diffPixels === 0,
    diffPixels,
    totalPixels,
    diffRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    width,
    height,
    diffPng: out ? encodePngRgba(width, height, out) : undefined,
  };
}

/** Decode two PNGs and diff them. Throws if dimensions differ. */
export function diffScreenshots(pngA: Uint8Array, pngB: Uint8Array, opts: DiffOptions = {}): DiffResult {
  const da = decodePngToRgba(pngA);
  const db = decodePngToRgba(pngB);
  if (da.width !== db.width || da.height !== db.height) {
    throw new Error(
      `Screenshot dimensions differ: ${da.width}×${da.height} vs ${db.width}×${db.height}`,
    );
  }
  return diffRgba(da.rgba, db.rgba, da.width, da.height, opts);
}
