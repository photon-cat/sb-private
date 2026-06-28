import { describe, it, expect } from "vitest";
import { ILI9341Controller } from "../ili9341-controller";

function px(c: ILI9341Controller, x: number, y: number): [number, number, number, number] {
  const { width, pixels } = c.getFramebuffer();
  const i = (y * width + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

describe("ILI9341Controller", () => {
  function cmd(c: ILI9341Controller, b: number) { c.processByte(b, true); }
  function dat(c: ILI9341Controller, b: number) { c.processByte(b, false); }

  function setWindow(c: ILI9341Controller, x0: number, x1: number, y0: number, y1: number) {
    cmd(c, 0x2a); dat(c, x0 >> 8); dat(c, x0 & 0xff); dat(c, x1 >> 8); dat(c, x1 & 0xff);
    cmd(c, 0x2b); dat(c, y0 >> 8); dat(c, y0 & 0xff); dat(c, y1 >> 8); dat(c, y1 & 0xff);
  }

  it("starts blank", () => {
    const c = new ILI9341Controller(8, 8);
    expect(px(c, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("RAMWR fills the active window with RGB565 pixels (red)", () => {
    const c = new ILI9341Controller(8, 8);
    setWindow(c, 0, 1, 0, 1); // 2x2 window
    cmd(c, 0x2c); // RAMWR
    for (let i = 0; i < 4; i++) { dat(c, 0xf8); dat(c, 0x00); } // 0xF800 = red
    expect(px(c, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(c, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(px(c, 0, 1)).toEqual([255, 0, 0, 255]);
    expect(px(c, 1, 1)).toEqual([255, 0, 0, 255]);
    // outside the window stays blank
    expect(px(c, 2, 2)).toEqual([0, 0, 0, 0]);
  });

  it("decodes green and blue from RGB565", () => {
    const c = new ILI9341Controller(4, 4);
    setWindow(c, 0, 0, 0, 0);
    cmd(c, 0x2c); dat(c, 0x07); dat(c, 0xe0); // 0x07E0 = green
    expect(px(c, 0, 0)).toEqual([0, 255, 0, 255]);

    setWindow(c, 1, 1, 0, 0);
    cmd(c, 0x2c); dat(c, 0x00); dat(c, 0x1f); // 0x001F = blue
    expect(px(c, 1, 0)).toEqual([0, 0, 255, 255]);
  });

  it("advances column-major and wraps to the next row at the window edge", () => {
    const c = new ILI9341Controller(8, 8);
    setWindow(c, 2, 3, 5, 6); // 2x2 window offset from origin
    cmd(c, 0x2c);
    // 1st pixel red, 2nd green, 3rd blue, 4th white
    dat(c, 0xf8); dat(c, 0x00); // (2,5) red
    dat(c, 0x07); dat(c, 0xe0); // (3,5) green
    dat(c, 0x00); dat(c, 0x1f); // (2,6) blue — wrapped to next row
    dat(c, 0xff); dat(c, 0xff); // (3,6) white
    expect(px(c, 2, 5)).toEqual([255, 0, 0, 255]);
    expect(px(c, 3, 5)).toEqual([0, 255, 0, 255]);
    expect(px(c, 2, 6)).toEqual([0, 0, 255, 255]);
    expect(px(c, 3, 6)).toEqual([255, 255, 255, 255]);
  });

  it("RAMWR continue (0x3C) keeps writing without resetting the cursor", () => {
    const c = new ILI9341Controller(8, 1);
    setWindow(c, 0, 3, 0, 0);
    cmd(c, 0x2c); dat(c, 0xf8); dat(c, 0x00); // (0,0) red
    cmd(c, 0x3c); dat(c, 0x07); dat(c, 0xe0); // continue → (1,0) green
    expect(px(c, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(c, 1, 0)).toEqual([0, 255, 0, 255]);
  });

  it("ignores unknown init commands (e.g. MADCTL/COLMOD) without corrupting state", () => {
    const c = new ILI9341Controller(4, 4);
    cmd(c, 0x36); dat(c, 0x48); // MADCTL
    cmd(c, 0x3a); dat(c, 0x55); // COLMOD 16-bit
    setWindow(c, 0, 0, 0, 0);
    cmd(c, 0x2c); dat(c, 0xf8); dat(c, 0x00);
    expect(px(c, 0, 0)).toEqual([255, 0, 0, 255]);
  });
});
