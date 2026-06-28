// ILI9341 SPI TFT display controller.
//
// Decodes the 4-wire SPI command/data stream (the DC pin selects command vs
// data) for the subset of the ILI9341 command set that drawing libraries use:
// CASET (0x2A), PASET (0x2B), RAMWR (0x2C / continue 0x3C), MADCTL (0x36) and
// COLMOD (0x3A). Pixel data is RGB565 (2 bytes/pixel, high byte first) and is
// expanded into an RGBA framebuffer that tests and the UI can read.

export interface Framebuffer {
  width: number;
  height: number;
  pixels: Uint8Array; // RGBA, width*height*4
}

// ILI9341 commands we act on
const CMD_CASET = 0x2a;
const CMD_PASET = 0x2b;
const CMD_RAMWR = 0x2c;
const CMD_RAMWR_CONT = 0x3c;
const CMD_MADCTL = 0x36;
const CMD_COLMOD = 0x3a;

export class ILI9341Controller {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  private cmd = 0;
  private args: number[] = [];
  private colStart = 0;
  private colEnd = 0;
  private rowStart = 0;
  private rowEnd = 0;
  private curX = 0;
  private curY = 0;
  private inRamwr = false;
  private pixelHi = -1; // first (high) byte of the current RGB565 pixel, or -1

  constructor(width = 240, height = 320) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.colEnd = width - 1;
    this.rowEnd = height - 1;
  }

  getFramebuffer(): Framebuffer {
    return { width: this.width, height: this.height, pixels: this.pixels };
  }

  /** Process one SPI byte. `isCommand` reflects the DC pin (low = command). */
  processByte(byte: number, isCommand: boolean): void {
    byte &= 0xff;
    if (isCommand) {
      this.cmd = byte;
      this.args = [];
      if (byte === CMD_RAMWR || byte === CMD_RAMWR_CONT) {
        this.inRamwr = true;
        if (byte === CMD_RAMWR) {
          // A fresh RAMWR resets the write cursor to the window origin.
          this.curX = this.colStart;
          this.curY = this.rowStart;
        }
        this.pixelHi = -1;
      } else {
        this.inRamwr = false;
      }
      return;
    }

    // Data byte
    switch (this.cmd) {
      case CMD_CASET:
        this.args.push(byte);
        if (this.args.length === 4) {
          this.colStart = (this.args[0] << 8) | this.args[1];
          this.colEnd = (this.args[2] << 8) | this.args[3];
        }
        break;
      case CMD_PASET:
        this.args.push(byte);
        if (this.args.length === 4) {
          this.rowStart = (this.args[0] << 8) | this.args[1];
          this.rowEnd = (this.args[2] << 8) | this.args[3];
        }
        break;
      case CMD_MADCTL:
      case CMD_COLMOD:
        // Orientation / pixel format — accepted; we always render RGB565→RGBA.
        this.args.push(byte);
        break;
      default:
        if (this.inRamwr) this.writePixelByte(byte);
        break;
    }
  }

  private writePixelByte(byte: number): void {
    if (this.pixelHi < 0) {
      this.pixelHi = byte;
      return;
    }
    const rgb565 = ((this.pixelHi << 8) | byte) & 0xffff;
    this.pixelHi = -1;
    this.putPixel(this.curX, this.curY, rgb565);

    // Advance within the active window (column-major rows, ILI9341 default).
    this.curX++;
    if (this.curX > this.colEnd) {
      this.curX = this.colStart;
      this.curY++;
      if (this.curY > this.rowEnd) this.curY = this.rowStart;
    }
  }

  private putPixel(x: number, y: number, rgb565: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const r5 = (rgb565 >> 11) & 0x1f;
    const g6 = (rgb565 >> 5) & 0x3f;
    const b5 = rgb565 & 0x1f;
    // Expand 5/6/5 to 8 bits per channel.
    const r = (r5 * 255 + 15) / 31;
    const g = (g6 * 255 + 31) / 63;
    const b = (b5 * 255 + 15) / 31;
    const i = (y * this.width + x) * 4;
    this.pixels[i] = r | 0;
    this.pixels[i + 1] = g | 0;
    this.pixels[i + 2] = b | 0;
    this.pixels[i + 3] = 255;
  }
}
