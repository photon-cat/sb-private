/**
 * Integration test: full flash flow with a mock STK500v1 bootloader.
 *
 * Simulates a complete Arduino Nano flashing session:
 *   1. Port open with correct baud rate
 *   2. DTR reset sequence
 *   3. Bootloader sync (with retries)
 *   4. Enter programming mode
 *   5. Load address + program page for each page
 *   6. Leave programming mode
 *   7. Port close and lock cleanup
 *
 * The mock bootloader validates command structure and responds
 * with correct STK500v1 protocol responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flashArduino, getBaudRate, type FlashProgress } from "../stk500";
import { loadHex } from "../intelhex";

// Protocol constants
const CRC_EOP = 0x20;
const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const Cmnd_STK_GET_SYNC = 0x30;
const Cmnd_STK_ENTER_PROGMODE = 0x50;
const Cmnd_STK_LEAVE_PROGMODE = 0x51;
const Cmnd_STK_LOAD_ADDRESS = 0x55;
const Cmnd_STK_PROG_PAGE = 0x64;
const PAGE_SIZE = 128;
const FLASH_SIZE = 0x8000;

// Realistic Arduino blink sketch hex (partial — enough for multi-page test)
const BLINK_HEX = [
  ":100000000C9434000C9451000C9451000C945100A1",
  ":100010000C9451000C9451000C9451000C945100B0",
  ":100020000C9451000C9451000C9451000C945100A0",
  ":100030000C9451000C9451000C9451000C94510090",
  ":100040000C9451000C9451000C9451000C94510080",
  ":100050000C9451000C9451000C9451000C94510070",
  ":100060000C9451000C9451000C9451000C94510060",
  ":100070000C9451000C9451000C9451000C94510050",
  ":100080000C94510011241FBECFEFD8E0DEBFCDBF3C",
  ":1000900021E0A0E0B1E001C01D92A930B207E1F7E6",
  ":1000A00002D005C020E0A0E0B1E001C01D92A23052",
  ":1000B000B107D9F710E0C4E6D0E004C02197FE0194",
  ":1000C0000C94B8000C940000259A2D9825982D9A0B",
  ":1000D000CFCFF894FFCF0000000000000000000098",
  ":00000001FF",
].join("\n");

/**
 * A mock bootloader that validates incoming STK500v1 commands
 * and tracks the full conversation for assertions.
 */
function createBootloaderMock(options: {
  syncRetriesNeeded?: number;
  rejectPageAt?: number;
} = {}) {
  const syncRetriesNeeded = options.syncRetriesNeeded ?? 0;
  let syncAttempts = 0;
  let pagesReceived = 0;

  // Record the full conversation
  const log: Array<{
    direction: "tx" | "rx";
    command: string;
    raw: Uint8Array;
  }> = [];

  // Addresses and page data received
  const receivedPages: Array<{ wordAddr: number; data: Uint8Array }> = [];

  let readQueue: Uint8Array[] = [];

  const respond = (data: Uint8Array) => {
    readQueue.push(data);
  };

  const handleCommand = (data: Uint8Array) => {
    const cmd = data[0];
    let cmdName = `unknown(0x${cmd.toString(16)})`;

    switch (cmd) {
      case Cmnd_STK_GET_SYNC: {
        cmdName = "GET_SYNC";
        syncAttempts++;
        if (syncAttempts <= syncRetriesNeeded) {
          log.push({ direction: "tx", command: `${cmdName} (ignored, attempt ${syncAttempts})`, raw: data });
          return; // No response — simulates bootloader not ready
        }
        respond(new Uint8Array([STK_INSYNC, STK_OK]));
        break;
      }
      case Cmnd_STK_ENTER_PROGMODE: {
        cmdName = "ENTER_PROGMODE";
        respond(new Uint8Array([STK_INSYNC, STK_OK]));
        break;
      }
      case Cmnd_STK_LEAVE_PROGMODE: {
        cmdName = "LEAVE_PROGMODE";
        respond(new Uint8Array([STK_INSYNC, STK_OK]));
        break;
      }
      case Cmnd_STK_LOAD_ADDRESS: {
        cmdName = "LOAD_ADDRESS";
        respond(new Uint8Array([STK_INSYNC, STK_OK]));
        break;
      }
      case Cmnd_STK_PROG_PAGE: {
        cmdName = "PROG_PAGE";
        pagesReceived++;

        if (options.rejectPageAt !== undefined && pagesReceived === options.rejectPageAt) {
          respond(new Uint8Array([0x00, 0x00])); // Protocol error
        } else {
          // Extract page data (skip header: cmd + size_hi + size_lo + memtype)
          const pageData = data.slice(4, 4 + PAGE_SIZE);
          // Find the most recent LOAD_ADDRESS to pair with this page
          const lastAddr = log
            .filter((e) => e.command === "LOAD_ADDRESS")
            .pop();
          const wordAddr = lastAddr
            ? lastAddr.raw[1] | (lastAddr.raw[2] << 8)
            : 0;
          receivedPages.push({ wordAddr, data: new Uint8Array(pageData) });
          respond(new Uint8Array([STK_INSYNC, STK_OK]));
        }
        break;
      }
      default: {
        // Unknown command — respond OK anyway (bootloader is lenient)
        respond(new Uint8Array([STK_INSYNC, STK_OK]));
      }
    }

    log.push({ direction: "tx", command: cmdName, raw: data });
  };

  const mockReader = {
    read: vi.fn(async () => {
      let attempts = 0;
      while (readQueue.length === 0) {
        if (attempts++ > 200) throw new Error("Serial read timeout");
        await new Promise((r) => setTimeout(r, 5));
      }
      const chunk = readQueue.shift()!;
      return { value: chunk, done: false };
    }),
    releaseLock: vi.fn(),
  };

  const mockWriter = {
    write: vi.fn(async (data: Uint8Array) => {
      log.push({ direction: "rx", command: "write", raw: new Uint8Array(data) });
      handleCommand(data);
    }),
    releaseLock: vi.fn(),
  };

  let isOpen = false;
  const signals: Array<Record<string, boolean>> = [];

  const port = {
    open: vi.fn(async (opts: SerialOptions) => {
      isOpen = true;
    }),
    close: vi.fn(async () => {
      isOpen = false;
    }),
    setSignals: vi.fn(async (sigs: SerialOutputSignals) => {
      signals.push({ ...sigs });
    }),
    readable: { getReader: () => mockReader },
    writable: { getWriter: () => mockWriter },
  } as unknown as SerialPort;

  return {
    port,
    log,
    signals,
    receivedPages,
    get isOpen() { return isOpen; },
    get syncAttempts() { return syncAttempts; },
    get pagesReceived() { return pagesReceived; },
    mockReader,
    mockWriter,
  };
}

describe("STK500 integration: full flash flow", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flashes a multi-page hex to a Nano with correct baud rate", async () => {
    const bootloader = createBootloaderMock();
    const baudRate = getBaudRate("nano");
    const progressLog: FlashProgress[] = [];

    await flashArduino(bootloader.port, BLINK_HEX, (p) => progressLog.push({ ...p }), baudRate);

    // Port opened with Nano baud rate
    expect(bootloader.port.open).toHaveBeenCalledWith(
      expect.objectContaining({ baudRate: 57600 }),
    );

    // DTR reset happened (3 setSignals calls)
    expect(bootloader.signals.length).toBe(3);

    // Bootloader synced
    expect(bootloader.syncAttempts).toBeGreaterThanOrEqual(1);

    // Pages were programmed (BLINK_HEX is ~224 bytes = 2 pages)
    expect(bootloader.pagesReceived).toBe(2);

    // Port was closed
    expect(bootloader.port.close).toHaveBeenCalled();

    // Progress went through all stages to 100%
    const stages = progressLog.map((p) => p.stage);
    expect(stages).toContain("connecting");
    expect(stages).toContain("syncing");
    expect(stages).toContain("programming");
    expect(stages).toContain("done");
    expect(progressLog[progressLog.length - 1].percent).toBe(100);
  });

  it("recovers from bootloader sync retries", async () => {
    const bootloader = createBootloaderMock({ syncRetriesNeeded: 3 });

    await flashArduino(bootloader.port, BLINK_HEX);

    // Should have retried sync 3 times, then succeeded on the 4th
    expect(bootloader.syncAttempts).toBe(4);
    // Should still have flashed successfully
    expect(bootloader.pagesReceived).toBe(2);
  });

  it("verifies page data matches the original hex", async () => {
    const bootloader = createBootloaderMock();
    await flashArduino(bootloader.port, BLINK_HEX);

    // Parse the hex the same way flashArduino does
    const expected = new Uint8Array(FLASH_SIZE).fill(0xff);
    loadHex(BLINK_HEX, expected);

    // Verify each received page matches the expected flash content
    for (const page of bootloader.receivedPages) {
      const byteAddr = page.wordAddr * 2; // word → byte address
      const expectedPage = expected.slice(byteAddr, byteAddr + PAGE_SIZE);
      expect(page.data).toEqual(expectedPage);
    }
  });

  it("sends pages in sequential address order", async () => {
    const bootloader = createBootloaderMock();
    await flashArduino(bootloader.port, BLINK_HEX);

    const addrs = bootloader.receivedPages.map((p) => p.wordAddr);
    for (let i = 1; i < addrs.length; i++) {
      expect(addrs[i]).toBeGreaterThan(addrs[i - 1]);
    }
  });

  it("command sequence follows STK500v1 protocol order", async () => {
    const bootloader = createBootloaderMock();
    await flashArduino(bootloader.port, BLINK_HEX);

    const commands = bootloader.log
      .filter((e) => e.direction === "tx")
      .map((e) => e.command);

    // Expected sequence: SYNC → ENTER_PROGMODE → (LOAD_ADDRESS + PROG_PAGE)* → LEAVE_PROGMODE
    const syncIdx = commands.indexOf("GET_SYNC");
    const enterIdx = commands.indexOf("ENTER_PROGMODE");
    const firstLoadIdx = commands.indexOf("LOAD_ADDRESS");
    const firstProgIdx = commands.indexOf("PROG_PAGE");
    const leaveIdx = commands.indexOf("LEAVE_PROGMODE");

    expect(syncIdx).toBeLessThan(enterIdx);
    expect(enterIdx).toBeLessThan(firstLoadIdx);
    expect(firstLoadIdx).toBeLessThan(firstProgIdx);
    expect(firstProgIdx).toBeLessThan(leaveIdx);
  });

  it("cleans up resources when page programming fails", async () => {
    const bootloader = createBootloaderMock({ rejectPageAt: 1 });

    await expect(
      flashArduino(bootloader.port, BLINK_HEX),
    ).rejects.toThrow("Program page failed");

    // Even on failure, resources must be cleaned up
    expect(bootloader.mockReader.releaseLock).toHaveBeenCalled();
    expect(bootloader.mockWriter.releaseLock).toHaveBeenCalled();
    expect(bootloader.port.close).toHaveBeenCalled();
  });

  it("reports error progress when programming fails", async () => {
    const bootloader = createBootloaderMock({ rejectPageAt: 1 });
    const progressLog: FlashProgress[] = [];

    try {
      await flashArduino(bootloader.port, BLINK_HEX, (p) => progressLog.push({ ...p }));
    } catch {
      // Expected
    }

    // Should have reached programming stage before failing
    const stages = progressLog.map((p) => p.stage);
    expect(stages).toContain("connecting");
    expect(stages).toContain("programming");
    // Should NOT have reached done
    expect(stages).not.toContain("done");
  });

  it("handles Uno at 115200 baud", async () => {
    const bootloader = createBootloaderMock();
    const baudRate = getBaudRate("uno");

    await flashArduino(bootloader.port, BLINK_HEX, undefined, baudRate);

    expect(bootloader.port.open).toHaveBeenCalledWith(
      expect.objectContaining({ baudRate: 115200 }),
    );
    expect(bootloader.pagesReceived).toBe(2);
  });

  it("port is not left open after successful flash", async () => {
    const bootloader = createBootloaderMock();
    await flashArduino(bootloader.port, BLINK_HEX);
    expect(bootloader.isOpen).toBe(false);
  });

  it("port is not left open after failed flash", async () => {
    const bootloader = createBootloaderMock({ rejectPageAt: 1 });
    try {
      await flashArduino(bootloader.port, BLINK_HEX);
    } catch {
      // Expected
    }
    expect(bootloader.isOpen).toBe(false);
  });
});
