/**
 * Render SparkBench display controller buffers to RGBA PNG bytes.
 *
 * Matches the pixel layout and palette that `@sparkbench/elements` ssd1306-element
 * and lcd1602-element use so the output can be byte-compared against
 * `wokwi-cli --screenshot-file` captures.
 */

import { encodePngRgba } from "./png-encoder";
import type { SSD1306Controller } from "./ssd1306-controller";
import type { LCD1602Controller } from "./lcd1602-controller";
import { fontA00 } from "@sparkbench/elements";

// ── SSD1306 (128×64, 1 bpp) ──────────────────────────────────────────────

/** SSD1306 colors matching @sparkbench/elements defaults (white-on-black). */
const SSD1306_OFF: [number, number, number, number] = [0, 0, 0, 255];
const SSD1306_ON: [number, number, number, number] = [255, 255, 255, 255];

/**
 * Convert an SSD1306's 1024-byte GDDRAM (page-layout: 8 pages × 128 cols,
 * LSB = top pixel in column) into a 128×64 RGBA buffer.
 */
export function ssd1306ToRgba(controller: SSD1306Controller): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const width = 128;
  const height = 64;
  const gddram = controller.gddramBuffer;
  const rgba = new Uint8Array(width * height * 4);

  for (let page = 0; page < 8; page++) {
    for (let col = 0; col < width; col++) {
      const byte = gddram[page * width + col] ?? 0;
      for (let bit = 0; bit < 8; bit++) {
        const y = page * 8 + bit;
        const on = (byte >> bit) & 1;
        const color = on ? SSD1306_ON : SSD1306_OFF;
        const idx = (y * width + col) * 4;
        rgba[idx] = color[0];
        rgba[idx + 1] = color[1];
        rgba[idx + 2] = color[2];
        rgba[idx + 3] = color[3];
      }
    }
  }

  return { width, height, rgba };
}

export function encodeSsd1306Png(controller: SSD1306Controller): Buffer {
  const { width, height, rgba } = ssd1306ToRgba(controller);
  return encodePngRgba(width, height, rgba);
}

// ── LCD1602 (16×2 characters, HD44780 5×8 font) ──────────────────────────

/**
 * Render LCD1602 character buffer to a simple bitmap using the A00 font
 * from @sparkbench/elements. Each glyph is 5×8 pixels; we render at 16 cols ×
 * 2 rows with a 1 pixel gap between chars and 2 pixel gap between rows,
 * so output is (5*16 + 15) × (8*2 + 2) = 95 × 18.
 */
export function lcd1602ToRgba(controller: LCD1602Controller): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const cols = 16;
  const rows = 2;
  const glyphW = 5;
  const glyphH = 8;
  const charGap = 1;
  const rowGap = 2;
  const width = glyphW * cols + charGap * (cols - 1);
  const height = glyphH * rows + rowGap * (rows - 1);

  // LCD backlight colors — Wokwi default background is a soft yellow-green
  const bgOn: [number, number, number, number] = controller.backlight
    ? [179, 193, 11, 255]
    : [38, 50, 15, 255];
  const fg: [number, number, number, number] = [32, 32, 32, 255];

  const rgba = new Uint8Array(width * height * 4);
  // Fill background
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bgOn[0];
    rgba[i * 4 + 1] = bgOn[1];
    rgba[i * 4 + 2] = bgOn[2];
    rgba[i * 4 + 3] = bgOn[3];
  }

  // fontA00 is a flat Uint8Array: 8 bytes per character, one byte per row,
  // where bits 4..0 are the 5 pixel columns (bit 4 = leftmost pixel).
  const font = fontA00 as Uint8Array;
  const chars = controller.characters;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const ch = chars[row * cols + col] ?? 0x20;
      const base = ch * 8;
      for (let gy = 0; gy < glyphH; gy++) {
        const rowBits = font[base + gy] ?? 0;
        for (let gx = 0; gx < glyphW; gx++) {
          // bit 4 = leftmost pixel, bit 0 = rightmost
          if (!((rowBits >> (4 - gx)) & 1)) continue;
          const px = col * (glyphW + charGap) + gx;
          const py = row * (glyphH + rowGap) + gy;
          const idx = (py * width + px) * 4;
          rgba[idx] = fg[0];
          rgba[idx + 1] = fg[1];
          rgba[idx + 2] = fg[2];
          rgba[idx + 3] = fg[3];
        }
      }
    }
  }

  return { width, height, rgba };
}

export function encodeLcd1602Png(controller: LCD1602Controller): Buffer {
  const { width, height, rgba } = lcd1602ToRgba(controller);
  return encodePngRgba(width, height, rgba);
}

// ── Generic RGBA framebuffer (custom chips, ILI9341, etc.) ───────────────

/**
 * Encode any RGBA framebuffer (width*height*4 bytes) to PNG. Used by custom
 * chip displays and SPI TFT controllers that already store RGBA pixels.
 */
export function encodeFramebufferPng(fb: {
  width: number;
  height: number;
  pixels: Uint8Array;
}): Buffer {
  return encodePngRgba(fb.width, fb.height, fb.pixels);
}
