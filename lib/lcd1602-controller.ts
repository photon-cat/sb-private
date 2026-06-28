// HD44780 16x2 LCD with PCF8574 I2C backpack — SparkBench native simulation.
//
// Wokwi project diagrams use `wokwi-lcd1602` with `pins="i2c"` which models a
// PCF8574 I/O expander at address 0x27 (or 0x3F). The expander maps its 8
// output bits to HD44780 control lines:
//
//   bit 7 6 5 4 | 3  2  1  0
//       D7 D6 D5 D4 | BL EN RW RS
//
// To send a byte, the master writes a sequence like:
//   [D7..D4 | BL 1 0 RS]  (high nibble + EN high)
//   [D7..D4 | BL 0 0 RS]  (EN falling edge: data latched)
//   [D3..D0 | BL 1 0 RS]  (low nibble + EN high)
//   [D3..D0 | BL 0 0 RS]  (EN falling edge: second nibble latched)
//
// We decode this into full HD44780 bytes, then apply them to a 32-byte
// character buffer. The character buffer is exposed on the controller and can
// be handed to `@sparkbench/elements`' `<wokwi-lcd1602>` element for rendering.
//
// Supported HD44780 instructions: clear display, return home, set DDRAM
// address, entry mode (direction), display on/off, and character writes.
// Function set, cursor shift, CGRAM addr, and entry auto-shift are accepted
// and ignored (they don't affect the visible text for 99% of sketches).

import type { AVRTWI, TWIEventHandler } from "avr8js";

const COLS = 16;
const ROWS = 2;
const BUF_SIZE = COLS * ROWS; // 32

export class LCD1602Controller implements TWIEventHandler {
  /** Raw character codes, laid out row-major: [row0c0..row0c15, row1c0..row1c15]. */
  readonly characters = new Uint8Array(BUF_SIZE);

  /** Current cursor position inside `characters`. */
  private cursorIdx = 0;

  /** Entry mode: +1 = cursor advances right, -1 = left. */
  private entryDir = 1;

  /** Backlight on/off — exposed for rendering. */
  backlight = true;

  /** Display enable (0x08 bit in display control). */
  displayOn = true;

  /** Fires whenever `characters` changes so the UI can redraw. */
  onCharactersChange?: (chars: Uint8Array) => void;

  // --- PCF8574 nibble decoder state ---
  private connected = false;
  private prevEn = false;
  private highNibble = 0;
  private highNibbleRs = 0;
  private haveHighNibble = false;

  constructor(
    private twi: AVRTWI,
    private address = 0x27,
  ) {
    this.characters.fill(0x20); // spaces
  }

  // --- TWIEventHandler ---

  start(): void {
    this.twi.completeStart();
  }

  stop(): void {
    this.connected = false;
    this.twi.completeStop();
  }

  connectToSlave(addr: number, _write: boolean): void {
    if (addr === this.address) {
      this.connected = true;
      this.twi.completeConnect(true);
    } else {
      this.connected = false;
      this.twi.completeConnect(false);
    }
  }

  writeByte(value: number): void {
    if (!this.connected) {
      this.twi.completeWrite(false);
      return;
    }
    this.decodePcf8574Byte(value);
    this.twi.completeWrite(true);
  }

  readByte(): void {
    // The HD44780 supports reading (busy flag) but almost no sketch uses
    // this over the I2C backpack — return 0 for anything that tries.
    this.twi.completeRead(0x00);
  }

  // --- PCF8574 → HD44780 decode ---

  private decodePcf8574Byte(byte: number): void {
    // bit 7..4 = D7..D4, bit 3 = backlight, bit 2 = EN, bit 1 = RW, bit 0 = RS
    const en = (byte & 0x04) !== 0;
    const rs = byte & 0x01;
    this.backlight = (byte & 0x08) !== 0;
    const nibble = (byte >> 4) & 0x0f;

    // HD44780 latches data on the EN falling edge.
    if (this.prevEn && !en) {
      if (!this.haveHighNibble) {
        this.highNibble = nibble;
        this.highNibbleRs = rs;
        this.haveHighNibble = true;
      } else {
        const full = (this.highNibble << 4) | nibble;
        this.haveHighNibble = false;
        this.handleByte(full, this.highNibbleRs);
      }
    }
    this.prevEn = en;
  }

  private handleByte(byte: number, rs: number): void {
    if (rs === 0) {
      this.executeInstruction(byte);
    } else {
      this.writeChar(byte);
    }
  }

  private executeInstruction(byte: number): void {
    if (byte === 0x01) {
      // Clear display
      this.characters.fill(0x20);
      this.cursorIdx = 0;
      this.onCharactersChange?.(this.characters);
      return;
    }
    if ((byte & 0xfe) === 0x02) {
      // Return home (0x02 / 0x03)
      this.cursorIdx = 0;
      return;
    }
    if ((byte & 0xfc) === 0x04) {
      // Entry mode set: 0x04 + I/D + S
      this.entryDir = byte & 0x02 ? 1 : -1;
      return;
    }
    if ((byte & 0xf8) === 0x08) {
      // Display on/off control: 0x08 + D + C + B
      this.displayOn = (byte & 0x04) !== 0;
      return;
    }
    if ((byte & 0xf0) === 0x10) {
      // Cursor / display shift — ignored
      return;
    }
    if ((byte & 0xe0) === 0x20) {
      // Function set (bus width, line count, font) — ignored
      return;
    }
    if ((byte & 0xc0) === 0x40) {
      // Set CGRAM address — ignored (custom glyphs not rendered)
      return;
    }
    if ((byte & 0x80) === 0x80) {
      // Set DDRAM address. Row 0 starts at 0x00, row 1 at 0x40.
      const addr = byte & 0x7f;
      if (addr < 0x40) {
        this.cursorIdx = Math.min(addr, COLS - 1);
      } else {
        const col = Math.min(addr - 0x40, COLS - 1);
        this.cursorIdx = COLS + col;
      }
      return;
    }
    // Anything else: ignore silently.
  }

  private writeChar(code: number): void {
    if (this.cursorIdx >= 0 && this.cursorIdx < BUF_SIZE) {
      this.characters[this.cursorIdx] = code;
    }
    this.cursorIdx += this.entryDir;
    // Clamp within the buffer; do not auto-wrap between rows.
    if (this.cursorIdx < 0) this.cursorIdx = 0;
    if (this.cursorIdx >= BUF_SIZE) this.cursorIdx = BUF_SIZE - 1;
    this.onCharactersChange?.(this.characters);
  }

  /** Decode the character buffer into two text rows (useful for tests). */
  toText(): [string, string] {
    const decode = (start: number) =>
      String.fromCharCode(...this.characters.slice(start, start + COLS));
    return [decode(0), decode(COLS)];
  }

  dispose(): void {
    this.onCharactersChange = undefined;
  }
}
