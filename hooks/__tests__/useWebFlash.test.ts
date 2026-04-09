import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebFlash } from "../useWebFlash";

// Mock the stk500 module
vi.mock("@/lib/stk500", () => ({
  flashArduino: vi.fn(),
  getBaudRate: vi.fn((board: string) => (board === "nano" ? 57600 : 115200)),
}));

const SAMPLE_HEX = ":04000000DEADBEEF9E\n:00000001FF\n";

describe("useWebFlash", () => {
  const originalNavigator = global.navigator;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    // Restore navigator
    Object.defineProperty(global, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  function setWebSerialSupported(supported: boolean) {
    const nav = { ...originalNavigator } as Record<string, unknown>;
    if (supported) {
      nav.serial = {
        requestPort: vi.fn(),
      };
    } else {
      delete nav.serial;
    }
    Object.defineProperty(global, "navigator", {
      value: nav,
      writable: true,
      configurable: true,
    });
  }

  it("reports isSupported=false when Web Serial is unavailable", () => {
    setWebSerialSupported(false);
    const { result } = renderHook(() => useWebFlash());
    expect(result.current.isSupported).toBe(false);
  });

  it("reports isSupported=true when Web Serial is available", () => {
    setWebSerialSupported(true);
    const { result } = renderHook(() => useWebFlash());
    expect(result.current.isSupported).toBe(true);
  });

  it("starts with isFlashing=false and no progress", () => {
    const { result } = renderHook(() => useWebFlash());
    expect(result.current.isFlashing).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it("sets error progress when Web Serial is not supported", async () => {
    setWebSerialSupported(false);
    const { result } = renderHook(() => useWebFlash());

    await act(async () => {
      await result.current.flash(SAMPLE_HEX);
    });

    expect(result.current.progress).toEqual({
      stage: "error",
      percent: 0,
      message: "Web Serial API not supported. Use Chrome or Edge.",
    });
  });

  it("clears progress when user cancels port picker", async () => {
    setWebSerialSupported(true);
    const cancelError = new DOMException("No port selected", "NotFoundError");
    (navigator.serial.requestPort as ReturnType<typeof vi.fn>).mockRejectedValue(cancelError);

    const { result } = renderHook(() => useWebFlash());

    await act(async () => {
      await result.current.flash(SAMPLE_HEX);
    });

    expect(result.current.progress).toBeNull();
    expect(result.current.isFlashing).toBe(false);
  });

  it("sets error progress on flash failure", async () => {
    setWebSerialSupported(true);
    const mockPort = {} as SerialPort;
    (navigator.serial.requestPort as ReturnType<typeof vi.fn>).mockResolvedValue(mockPort);

    const { flashArduino } = await import("@/lib/stk500");
    (flashArduino as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Serial read timeout"),
    );

    const { result } = renderHook(() => useWebFlash());

    await act(async () => {
      await result.current.flash(SAMPLE_HEX);
    });

    expect(result.current.progress?.stage).toBe("error");
    expect(result.current.progress?.message).toContain("Serial read timeout");
    expect(result.current.isFlashing).toBe(false);
  });

  it("calls flashArduino with correct board baud rate", async () => {
    setWebSerialSupported(true);
    const mockPort = {} as SerialPort;
    (navigator.serial.requestPort as ReturnType<typeof vi.fn>).mockResolvedValue(mockPort);

    const { flashArduino, getBaudRate } = await import("@/lib/stk500");
    (flashArduino as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useWebFlash());

    await act(async () => {
      await result.current.flash(SAMPLE_HEX, "nano");
    });

    expect(getBaudRate).toHaveBeenCalledWith("nano");
    expect(flashArduino).toHaveBeenCalledWith(
      mockPort,
      SAMPLE_HEX,
      expect.any(Function),
      57600,
    );
  });

  it("defaults to 'uno' board when none specified", async () => {
    setWebSerialSupported(true);
    const mockPort = {} as SerialPort;
    (navigator.serial.requestPort as ReturnType<typeof vi.fn>).mockResolvedValue(mockPort);

    const { flashArduino, getBaudRate } = await import("@/lib/stk500");
    (flashArduino as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useWebFlash());

    await act(async () => {
      await result.current.flash(SAMPLE_HEX);
    });

    expect(getBaudRate).toHaveBeenCalledWith("uno");
  });

  it("requests port with correct USB vendor ID filters", async () => {
    setWebSerialSupported(true);
    (navigator.serial.requestPort as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DOMException("", "NotFoundError"),
    );

    const { result } = renderHook(() => useWebFlash());

    await act(async () => {
      await result.current.flash(SAMPLE_HEX);
    });

    expect(navigator.serial.requestPort).toHaveBeenCalledWith({
      filters: [
        { usbVendorId: 0x2341 }, // Arduino SA
        { usbVendorId: 0x2a03 }, // Arduino.org
        { usbVendorId: 0x1a86 }, // CH340
        { usbVendorId: 0x0403 }, // FTDI
        { usbVendorId: 0x10c4 }, // CP210x
      ],
    });
  });

  it("isFlashing resets to false after successful flash", async () => {
    setWebSerialSupported(true);
    const mockPort = {} as SerialPort;
    (navigator.serial.requestPort as ReturnType<typeof vi.fn>).mockResolvedValue(mockPort);

    const { flashArduino } = await import("@/lib/stk500");
    (flashArduino as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useWebFlash());

    await act(async () => {
      await result.current.flash(SAMPLE_HEX);
    });

    expect(result.current.isFlashing).toBe(false);
  });
});
