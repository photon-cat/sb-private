import { describe, it, expect, beforeEach } from "vitest";
import type { AVRTWI } from "avr8js";
import { LCD1602Controller } from "../lcd1602-controller";

/**
 * Minimal TWI mock — records completeWrite/completeRead calls.
 * The LCD1602Controller only reads from TWI via these "complete*" setters.
 */
function makeTwi(): AVRTWI {
  return {
    completeStart: () => {},
    completeStop: () => {},
    completeConnect: (_ack: boolean) => {},
    completeWrite: (_ack: boolean) => {},
    completeRead: (_value: number) => {},
  } as unknown as AVRTWI;
}

/**
 * Drive a byte through the PCF8574 → HD44780 decoder.
 * Each byte uses the nibble protocol: high nibble with EN pulse, then low.
 */
function sendByte(lcd: LCD1602Controller, rs: 0 | 1, byte: number) {
  const BL = 0x08;
  const high = (byte & 0xf0);
  const low = (byte & 0x0f) << 4;
  lcd.writeByte(high | BL | 0x04 | rs); // EN high, high nibble
  lcd.writeByte(high | BL | 0x00 | rs); // EN falling edge (latch)
  lcd.writeByte(low  | BL | 0x04 | rs); // EN high, low nibble
  lcd.writeByte(low  | BL | 0x00 | rs); // EN falling edge (latch)
}

function sendCommand(lcd: LCD1602Controller, cmd: number) {
  sendByte(lcd, 0, cmd);
}

function sendData(lcd: LCD1602Controller, data: number) {
  sendByte(lcd, 1, data);
}

function sendString(lcd: LCD1602Controller, s: string) {
  for (const ch of s) sendData(lcd, ch.charCodeAt(0));
}

describe("LCD1602Controller", () => {
  let lcd: LCD1602Controller;

  beforeEach(() => {
    lcd = new LCD1602Controller(makeTwi(), 0x27);
    // Simulate the master connecting; bypass the bus in this unit test.
    lcd.connectToSlave(0x27, true);
  });

  it("initial buffer is filled with spaces", () => {
    const [r0, r1] = lcd.toText();
    expect(r0).toBe("                ");
    expect(r1).toBe("                ");
  });

  it("writes characters at cursor position starting at row 0", () => {
    sendString(lcd, "Hello");
    expect(lcd.toText()[0]).toBe("Hello           ");
  });

  it("'Hello, World!' renders correctly", () => {
    sendString(lcd, "Hello, World!");
    expect(lcd.toText()[0]).toBe("Hello, World!   ");
  });

  it("set DDRAM address 0x40 moves cursor to row 1", () => {
    sendCommand(lcd, 0x80 | 0x00); // row 0 col 0
    sendString(lcd, "Row 0");
    sendCommand(lcd, 0x80 | 0x40); // row 1 col 0
    sendString(lcd, "Row 1");
    expect(lcd.toText()).toEqual(["Row 0           ", "Row 1           "]);
  });

  it("clear display wipes the buffer and resets the cursor", () => {
    sendString(lcd, "SCRATCH");
    sendCommand(lcd, 0x01); // clear
    expect(lcd.toText()[0]).toBe("                ");

    sendString(lcd, "fresh");
    expect(lcd.toText()[0]).toBe("fresh           ");
  });

  it("return home resets the cursor without clearing", () => {
    sendString(lcd, "Hi");
    sendCommand(lcd, 0x02); // return home
    sendString(lcd, "yo");
    expect(lcd.toText()[0]).toBe("yo              ");
  });

  it("entry mode 0x04 (decrement) writes characters right-to-left", () => {
    sendCommand(lcd, 0x80 | 0x0f); // move to row 0 col 15
    sendCommand(lcd, 0x04);        // entry mode: I/D=0 → decrement
    sendString(lcd, "ABC");
    // 'A' at col 15, 'B' at col 14, 'C' at col 13
    const r0 = lcd.toText()[0];
    expect(r0[15]).toBe("A");
    expect(r0[14]).toBe("B");
    expect(r0[13]).toBe("C");
  });

  it("function set and cursor shift are accepted silently", () => {
    sendCommand(lcd, 0x28); // 4-bit, 2 lines, 5x8 font
    sendCommand(lcd, 0x0c); // display on, cursor off, blink off
    sendCommand(lcd, 0x06); // entry mode: increment, no shift
    sendString(lcd, "ok");
    expect(lcd.toText()[0]).toBe("ok              ");
  });

  it("onCharactersChange fires on writes", () => {
    let fired = 0;
    lcd.onCharactersChange = () => { fired++; };
    sendString(lcd, "hi");
    expect(fired).toBe(2);
  });

  it("backlight bit toggles the backlight state", () => {
    // Send a command with backlight off
    lcd.writeByte(0x04);
    lcd.writeByte(0x00);
    expect(lcd.backlight).toBe(false);

    // ...then with backlight on
    lcd.writeByte(0x08 | 0x04);
    lcd.writeByte(0x08);
    expect(lcd.backlight).toBe(true);
  });

  it("non-matching address refuses the connection", () => {
    const twi = makeTwi();
    const other = new LCD1602Controller(twi, 0x27);
    let accepted: boolean | null = null;
    twi.completeConnect = (ack: boolean) => { accepted = ack; };
    other.connectToSlave(0x3f, true);
    expect(accepted).toBe(false);
  });
});
