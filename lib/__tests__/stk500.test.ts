import { describe, it, expect, vi, beforeEach } from "vitest";
import { flashArduino, getBaudRate, isWebSerialSupported, type FlashProgress } from "../stk500";

// STK500v1 protocol constants
const CRC_EOP = 0x20;
const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const Cmnd_STK_GET_SYNC = 0x30;
const Cmnd_STK_ENTER_PROGMODE = 0x50;
const Cmnd_STK_LEAVE_PROGMODE = 0x51;
const Cmnd_STK_LOAD_ADDRESS = 0x55;
const Cmnd_STK_PROG_PAGE = 0x64;
const PAGE_SIZE = 128;

/** Minimal Intel HEX: 4 bytes of data at address 0x0000 */
const SIMPLE_HEX = ":04000000DEADBEEF9E\n:00000001FF\n";

/**
 * Creates a mock SerialPort that simulates STK500v1 bootloader responses.
 * The bootloader responds to each command with [STK_INSYNC, STK_OK].
 */
function createMockPort(options: {
  /** Override the response for specific command bytes */
  commandResponses?: Map<number, Uint8Array>;
  /** If true, the first N sync attempts will timeout */
  syncFailures?: number;
  /** If true, fail on a specific page number */
  failOnPage?: number;
} = {}) {
  const written: Uint8Array[] = [];
  const readQueue: Uint8Array[] = [];
  let syncAttempts = 0;
  const syncFailures = options.syncFailures ?? 0;
  const commandResponses = options.commandResponses ?? new Map();

  const enqueueResponse = (data: Uint8Array) => {
    readQueue.push(data);
  };

  const processCommand = (data: Uint8Array) => {
    const cmd = data[0];

    // Handle sync with optional failures
    if (cmd === Cmnd_STK_GET_SYNC) {
      syncAttempts++;
      if (syncAttempts <= syncFailures) {
        // Don't enqueue anything — simulates timeout
        return;
      }
    }

    // Check for custom response
    if (commandResponses.has(cmd)) {
      enqueueResponse(commandResponses.get(cmd)!);
      return;
    }

    // Handle page programming — check for failOnPage
    if (cmd === Cmnd_STK_PROG_PAGE && options.failOnPage !== undefined) {
      // Count how many PROG_PAGE commands we've seen
      const progPages = written.filter((w) => w[0] === Cmnd_STK_PROG_PAGE).length;
      if (progPages === options.failOnPage) {
        enqueueResponse(new Uint8Array([0x00, 0x00])); // Bad response
        return;
      }
    }

    // Default: respond with INSYNC + OK
    enqueueResponse(new Uint8Array([STK_INSYNC, STK_OK]));
  };

  const mockReader = {
    read: vi.fn(async () => {
      // Wait for data to appear (with a reasonable limit)
      let attempts = 0;
      while (readQueue.length === 0) {
        if (attempts++ > 100) {
          throw new Error("Serial read timeout");
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      const chunk = readQueue.shift()!;
      return { value: chunk, done: false };
    }),
    releaseLock: vi.fn(),
  };

  const mockWriter = {
    write: vi.fn(async (data: Uint8Array) => {
      written.push(new Uint8Array(data));
      processCommand(data);
    }),
    releaseLock: vi.fn(),
  };

  const port = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    setSignals: vi.fn(async () => {}),
    readable: { getReader: () => mockReader },
    writable: { getWriter: () => mockWriter },
  } as unknown as SerialPort;

  return { port, written, mockReader, mockWriter, enqueueResponse };
}

describe("getBaudRate", () => {
  it("returns 57600 for nano", () => {
    expect(getBaudRate("nano")).toBe(57600);
  });

  it("returns 115200 for uno", () => {
    expect(getBaudRate("uno")).toBe(115200);
  });

  it("returns 115200 for mega", () => {
    expect(getBaudRate("mega")).toBe(115200);
  });

  it("returns 115200 for unknown boards", () => {
    expect(getBaudRate("unknown-board")).toBe(115200);
  });

  it("returns correct rates for all supported boards", () => {
    expect(getBaudRate("leonardo")).toBe(57600);
    expect(getBaudRate("micro")).toBe(57600);
    expect(getBaudRate("pro")).toBe(57600);
    expect(getBaudRate("promini")).toBe(57600);
    expect(getBaudRate("atmega328p")).toBe(115200);
  });
});

describe("isWebSerialSupported", () => {
  it("returns false in jsdom (no navigator.serial)", () => {
    expect(isWebSerialSupported()).toBe(false);
  });
});

describe("flashArduino", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("opens port with correct baud rate", async () => {
    const { port } = createMockPort();
    await flashArduino(port, SIMPLE_HEX, undefined, 57600);

    expect(port.open).toHaveBeenCalledWith({
      baudRate: 57600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
    });
  });

  it("performs DTR reset sequence", async () => {
    const { port } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);

    const calls = (port.setSignals as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(3);
    // First: DTR+RTS high
    expect(calls[0][0]).toEqual({ dataTerminalReady: true, requestToSend: true });
    // Second: DTR+RTS low (triggers reset)
    expect(calls[1][0]).toEqual({ dataTerminalReady: false, requestToSend: false });
    // Third: DTR+RTS high again
    expect(calls[2][0]).toEqual({ dataTerminalReady: true, requestToSend: true });
  });

  it("sends GET_SYNC command", async () => {
    const { port, written } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);

    const syncCmd = written.find((w) => w[0] === Cmnd_STK_GET_SYNC);
    expect(syncCmd).toBeDefined();
    expect(syncCmd![1]).toBe(CRC_EOP);
  });

  it("sends ENTER_PROGMODE command", async () => {
    const { port, written } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);

    const cmd = written.find((w) => w[0] === Cmnd_STK_ENTER_PROGMODE);
    expect(cmd).toBeDefined();
    expect(cmd![1]).toBe(CRC_EOP);
  });

  it("sends LOAD_ADDRESS before each page", async () => {
    const { port, written } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);

    const addrCmds = written.filter((w) => w[0] === Cmnd_STK_LOAD_ADDRESS);
    expect(addrCmds.length).toBeGreaterThanOrEqual(1);
    // First page: word address 0x0000
    expect(addrCmds[0][1]).toBe(0x00); // low byte
    expect(addrCmds[0][2]).toBe(0x00); // high byte
  });

  it("sends PROG_PAGE with correct format", async () => {
    const { port, written } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);

    const progCmds = written.filter((w) => w[0] === Cmnd_STK_PROG_PAGE);
    expect(progCmds.length).toBeGreaterThanOrEqual(1);

    const cmd = progCmds[0];
    // Header: cmd + size_hi + size_lo + memtype
    expect(cmd[1]).toBe((PAGE_SIZE >> 8) & 0xff); // size high byte
    expect(cmd[2]).toBe(PAGE_SIZE & 0xff);         // size low byte
    expect(cmd[3]).toBe(0x46);                      // 'F' for flash
    // Data starts at offset 4, should contain our firmware bytes
    expect(cmd[4]).toBe(0xde);
    expect(cmd[5]).toBe(0xad);
    expect(cmd[6]).toBe(0xbe);
    expect(cmd[7]).toBe(0xef);
    // Remaining bytes should be 0xFF (empty flash)
    expect(cmd[8]).toBe(0xff);
    // Last byte is CRC_EOP
    expect(cmd[4 + PAGE_SIZE]).toBe(CRC_EOP);
  });

  it("sends LEAVE_PROGMODE at end", async () => {
    const { port, written } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);

    const cmd = written.find((w) => w[0] === Cmnd_STK_LEAVE_PROGMODE);
    expect(cmd).toBeDefined();
    expect(cmd![1]).toBe(CRC_EOP);
  });

  it("closes port in finally block", async () => {
    const { port } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);
    expect(port.close).toHaveBeenCalled();
  });

  it("releases reader and writer locks", async () => {
    const { port, mockReader, mockWriter } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);
    expect(mockReader.releaseLock).toHaveBeenCalled();
    expect(mockWriter.releaseLock).toHaveBeenCalled();
  });

  it("reports progress through all stages", async () => {
    const { port } = createMockPort();
    const stages: FlashProgress["stage"][] = [];
    const onProgress = (p: FlashProgress) => {
      if (!stages.includes(p.stage)) stages.push(p.stage);
    };

    await flashArduino(port, SIMPLE_HEX, onProgress);

    expect(stages).toContain("connecting");
    expect(stages).toContain("syncing");
    expect(stages).toContain("programming");
    expect(stages).toContain("done");
  });

  it("progress reaches 100%", async () => {
    const { port } = createMockPort();
    let lastPercent = 0;
    const onProgress = (p: FlashProgress) => {
      lastPercent = p.percent;
    };

    await flashArduino(port, SIMPLE_HEX, onProgress);
    expect(lastPercent).toBe(100);
  });

  it("throws on empty firmware", async () => {
    const { port } = createMockPort();
    const emptyHex = ":00000001FF\n"; // Just EOF record, no data

    await expect(flashArduino(port, emptyHex)).rejects.toThrow("Firmware is empty");
  });

  it("handles protocol error on ENTER_PROGMODE", async () => {
    const badResponse = new Map([[Cmnd_STK_ENTER_PROGMODE, new Uint8Array([0x00, 0x00])]]);
    const { port } = createMockPort({ commandResponses: badResponse });

    await expect(flashArduino(port, SIMPLE_HEX)).rejects.toThrow("STK500 protocol error");
  });

  it("closes port even when flashing fails", async () => {
    const badResponse = new Map([[Cmnd_STK_ENTER_PROGMODE, new Uint8Array([0x00, 0x00])]]);
    const { port } = createMockPort({ commandResponses: badResponse });

    try {
      await flashArduino(port, SIMPLE_HEX);
    } catch {
      // Expected
    }

    expect(port.close).toHaveBeenCalled();
  });

  it("closes port before opening if already open", async () => {
    const { port } = createMockPort();
    await flashArduino(port, SIMPLE_HEX);

    // close is called twice: once at start (best effort) and once in finally
    expect((port.close as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("programs correct number of pages for multi-page firmware", async () => {
    // Create hex with 256 bytes (2 pages worth of data)
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) {
      const addr = i * 16;
      const addrHex = addr.toString(16).padStart(4, "0");
      const data = "AA".repeat(16);
      // Simplified checksum (not validated by loadHex anyway)
      lines.push(`:10${addrHex}00${data}00`);
    }
    lines.push(":00000001FF");
    const bigHex = lines.join("\n");

    const { port, written } = createMockPort();
    await flashArduino(port, bigHex);

    const progCmds = written.filter((w) => w[0] === Cmnd_STK_PROG_PAGE);
    expect(progCmds.length).toBe(2); // 256 bytes / 128 page size = 2 pages
  });

  it("uses word addresses (byte address >> 1)", async () => {
    // 256 bytes = 2 pages. Second page starts at byte 128, word 64.
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) {
      const addr = i * 16;
      const addrHex = addr.toString(16).padStart(4, "0");
      lines.push(`:10${addrHex}00${"BB".repeat(16)}00`);
    }
    lines.push(":00000001FF");

    const { port, written } = createMockPort();
    await flashArduino(port, lines.join("\n"));

    const addrCmds = written.filter((w) => w[0] === Cmnd_STK_LOAD_ADDRESS);
    expect(addrCmds.length).toBe(2);
    // Page 0: word addr 0
    expect(addrCmds[0][1]).toBe(0x00);
    expect(addrCmds[0][2]).toBe(0x00);
    // Page 1: word addr 64 (0x40)
    expect(addrCmds[1][1]).toBe(0x40);
    expect(addrCmds[1][2]).toBe(0x00);
  });
});
