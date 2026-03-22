"use client";

import { useState, useRef, useCallback } from "react";
import type { FlashProgress } from "@/lib/stk500";

export interface UseWebFlashReturn {
  isSupported: boolean;
  isFlashing: boolean;
  progress: FlashProgress | null;
  flash: (hexString: string, board?: string) => Promise<void>;
}

export function useWebFlash(): UseWebFlashReturn {
  const [isFlashing, setIsFlashing] = useState(false);
  const [progress, setProgress] = useState<FlashProgress | null>(null);
  const portRef = useRef<SerialPort | null>(null);

  const isSupported =
    typeof navigator !== "undefined" && "serial" in navigator;

  const flash = useCallback(async (hexString: string, board = "uno") => {
    if (!isSupported) {
      setProgress({
        stage: "error",
        percent: 0,
        message: "Web Serial API not supported. Use Chrome or Edge.",
      });
      return;
    }

    setIsFlashing(true);
    setProgress({ stage: "connecting", percent: 0, message: "Select serial port..." });

    try {
      // Request port from user (browser shows picker)
      const port = await navigator.serial.requestPort({
        filters: [
          { usbVendorId: 0x2341 }, // Arduino SA
          { usbVendorId: 0x2a03 }, // Arduino.org
          { usbVendorId: 0x1a86 }, // CH340 (clone boards — very common for Nano)
          { usbVendorId: 0x0403 }, // FTDI
          { usbVendorId: 0x10c4 }, // CP210x
        ],
      });
      portRef.current = port;

      const { flashArduino, getBaudRate } = await import("@/lib/stk500");
      const baudRate = getBaudRate(board);
      await flashArduino(port, hexString, setProgress, baudRate);
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        // User cancelled the port picker
        setProgress(null);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setProgress({ stage: "error", percent: 0, message: `Flash failed: ${msg}` });
      }
    } finally {
      setIsFlashing(false);
      portRef.current = null;
    }
  }, [isSupported]);

  return { isSupported, isFlashing, progress, flash };
}
