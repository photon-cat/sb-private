// STK500v1 protocol implementation for flashing Arduino boards via Web Serial API

import { loadHex } from "./intelhex";

// STK500v1 protocol constants
const CRC_EOP = 0x20; // 'space' - command terminator
const STK_OK = 0x10;
const STK_INSYNC = 0x14;

const Cmnd_STK_GET_SYNC = 0x30;
const Cmnd_STK_ENTER_PROGMODE = 0x50;
const Cmnd_STK_LEAVE_PROGMODE = 0x51;
const Cmnd_STK_LOAD_ADDRESS = 0x55;
const Cmnd_STK_PROG_PAGE = 0x64;

const PAGE_SIZE = 128; // ATmega328P flash page size in bytes
const FLASH_SIZE = 0x8000; // 32KB

// Board-specific baud rates for bootloader communication
const BOARD_BAUD_RATES: Record<string, number> = {
  uno: 115200,
  nano: 57600, // Old bootloader (most common, especially clones)
  mega: 115200,
  leonardo: 57600,
  micro: 57600,
  pro: 57600,
  promini: 57600,
  atmega328p: 115200,
};

export type FlashProgress = {
  stage: "connecting" | "syncing" | "programming" | "verifying" | "done" | "error";
  percent: number;
  message: string;
};

export type ProgressCallback = (progress: FlashProgress) => void;

/** Read exactly `n` bytes from the serial port, with timeout */
async function readBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
  timeoutMs = 3000,
): Promise<Uint8Array> {
  const buf = new Uint8Array(n);
  let offset = 0;
  const deadline = Date.now() + timeoutMs;

  while (offset < n) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Serial read timeout");

    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Serial read timeout")), remaining),
      ),
    ]);

    if (result.done) throw new Error("Serial port closed unexpectedly");
    const chunk = result.value;
    const needed = n - offset;
    const toCopy = Math.min(chunk.length, needed);
    buf.set(chunk.subarray(0, toCopy), offset);
    offset += toCopy;
  }
  return buf;
}

/** Send an STK500 command and expect INSYNC + OK response */
async function sendCommand(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cmd: number[],
): Promise<void> {
  await writer.write(new Uint8Array([...cmd, CRC_EOP]));
  const resp = await readBytes(reader, 2);
  if (resp[0] !== STK_INSYNC || resp[1] !== STK_OK) {
    throw new Error(
      `STK500 protocol error: expected [${STK_INSYNC},${STK_OK}], got [${resp[0]},${resp[1]}]`,
    );
  }
}

/** Try to sync with the bootloader, retrying a few times */
async function getSync(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await writer.write(new Uint8Array([Cmnd_STK_GET_SYNC, CRC_EOP]));
      const resp = await readBytes(reader, 2, 500);
      if (resp[0] === STK_INSYNC && resp[1] === STK_OK) return;
    } catch {
      // Retry on timeout
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Failed to sync with bootloader — is the board connected and in bootloader mode?");
}

/** Find the last non-0xFF byte to determine actual firmware size */
function firmwareEnd(data: Uint8Array): number {
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] !== 0xff) return i + 1;
  }
  return 0;
}

/** Get the correct baud rate for a given board */
export function getBaudRate(board: string): number {
  return BOARD_BAUD_RATES[board] ?? 115200;
}

/**
 * Flash an Intel HEX file to an Arduino board via Web Serial API (STK500v1).
 * Works with Uno, Nano, and other ATmega328P boards.
 *
 * @param port - SerialPort from navigator.serial.requestPort()
 * @param hexString - Intel HEX format firmware string
 * @param onProgress - Optional progress callback
 * @param baudRate - Baud rate (57600 for Nano old bootloader, 115200 for Uno/Optiboot)
 */
export async function flashArduino(
  port: SerialPort,
  hexString: string,
  onProgress?: ProgressCallback,
  baudRate = 115200,
): Promise<void> {
  const report = (stage: FlashProgress["stage"], percent: number, message: string) => {
    onProgress?.({ stage, percent, message });
  };

  report("connecting", 0, `Opening serial port at ${baudRate} baud...`);

  // Close port first if it's already open
  try {
    await port.close();
  } catch {
    // Ignore — port may not have been open
  }

  await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none" });

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  try {
    // DTR pulse to reset the board into bootloader.
    // The capacitor on DTR triggers a reset on the falling edge.
    report("connecting", 5, "Resetting board...");
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await new Promise((r) => setTimeout(r, 50));
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await new Promise((r) => setTimeout(r, 50));
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });

    writer = port.writable!.getWriter();
    reader = port.readable!.getReader();

    // Wait for bootloader to initialize after reset.
    // Old bootloader Nano needs ~250ms, Optiboot is faster.
    await new Promise((r) => setTimeout(r, 300));

    // Drain any pending data (bootloader banner, garbage from reset)
    try {
      await readBytes(reader, 512, 100);
    } catch {
      // Expected timeout — just clearing the buffer
    }

    // Sync with bootloader
    report("syncing", 10, "Syncing with bootloader...");
    await getSync(writer, reader);

    // Enter programming mode
    report("programming", 15, "Entering programming mode...");
    await sendCommand(writer, reader, [Cmnd_STK_ENTER_PROGMODE]);

    // Parse hex into flash image
    const flash = new Uint8Array(FLASH_SIZE).fill(0xff);
    loadHex(hexString, flash);

    const endAddr = firmwareEnd(flash);
    const totalPages = Math.ceil(endAddr / PAGE_SIZE);

    if (totalPages === 0) {
      throw new Error("Firmware is empty — nothing to flash");
    }

    // Program pages
    for (let page = 0; page < totalPages; page++) {
      const byteAddr = page * PAGE_SIZE;
      const wordAddr = byteAddr >> 1; // STK500 uses word addresses

      const pageData = flash.slice(byteAddr, byteAddr + PAGE_SIZE);

      // Load address (little-endian word address)
      await writer.write(
        new Uint8Array([
          Cmnd_STK_LOAD_ADDRESS,
          wordAddr & 0xff,
          (wordAddr >> 8) & 0xff,
          CRC_EOP,
        ]),
      );
      const addrResp = await readBytes(reader, 2);
      if (addrResp[0] !== STK_INSYNC || addrResp[1] !== STK_OK) {
        throw new Error(`Load address failed at page ${page}`);
      }

      // Program page: cmd + size_hi + size_lo + memtype('F') + data + CRC_EOP
      const progCmd = new Uint8Array(4 + PAGE_SIZE + 1);
      progCmd[0] = Cmnd_STK_PROG_PAGE;
      progCmd[1] = (PAGE_SIZE >> 8) & 0xff;
      progCmd[2] = PAGE_SIZE & 0xff;
      progCmd[3] = 0x46; // 'F' for flash
      progCmd.set(pageData, 4);
      progCmd[4 + PAGE_SIZE] = CRC_EOP;

      await writer.write(progCmd);
      const pageResp = await readBytes(reader, 2, 5000);
      if (pageResp[0] !== STK_INSYNC || pageResp[1] !== STK_OK) {
        throw new Error(`Program page failed at address 0x${byteAddr.toString(16)}`);
      }

      const pct = 15 + Math.round(((page + 1) / totalPages) * 80);
      report("programming", pct, `Programming page ${page + 1}/${totalPages}...`);
    }

    // Leave programming mode
    report("done", 98, "Leaving programming mode...");
    await sendCommand(writer, reader, [Cmnd_STK_LEAVE_PROGMODE]);

    report("done", 100, `Flash complete! ${endAddr} bytes written.`);
  } finally {
    reader?.releaseLock();
    writer?.releaseLock();
    try {
      await port.close();
    } catch {
      // Best effort
    }
  }
}

/** Check if Web Serial API is available in this browser */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}
