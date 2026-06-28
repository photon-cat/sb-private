import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Diagram } from "@/lib/diagram-parser";
import { findMCUs } from "@/lib/diagram-parser";
import { mapArduinoPin, mapAtmega328Pin } from "@/lib/pin-mapping";
import {
  wireComponents,
  cleanupWiring,
  type WiredComponent,
} from "@/lib/wire-components";
import { wireComponentsStm32 } from "@/lib/wire-components-stm32";
import { type SimRunner, isStm32Runner } from "@/lib/sim/sim-runner";
import type { I2CBus } from "@/lib/i2c-bus";
import type { CustomChipConfig, CustomChipRuntime } from "@/lib/chip-runtime";

interface UseSimulationWiringParams {
  runner: SimRunner | null;
  diagram: Diagram | null;
  elementsRef: MutableRefObject<Map<string, HTMLElement>>;
  chipConfigs?: Map<string, CustomChipConfig> | null;
  mcuId?: string;
  onChipRuntimesReady?: (runtimes: Map<string, CustomChipRuntime>) => void;
  onWiredComponentsChange?: (wired: Map<string, WiredComponent>) => void;
}

interface SensorEntry {
  id: string;
  type: string;
  wc: WiredComponent;
}

export function useSimulationWiring({
  runner,
  diagram,
  elementsRef,
  chipConfigs,
  mcuId,
  onChipRuntimesReady,
  onWiredComponentsChange,
}: UseSimulationWiringParams) {
  const wiredRef = useRef<Map<string, WiredComponent>>(new Map());
  const [sensorEntries, setSensorEntries] = useState<SensorEntry[]>([]);

  useEffect(() => {
    if (!runner || !diagram || elementsRef.current.size === 0) return;
    cleanupWiring(wiredRef.current);
    let wired: Map<string, WiredComponent>;
    let i2cBus: I2CBus | undefined;
    if (isStm32Runner(runner)) {
      ({ wired } = wireComponentsStm32(runner, diagram, mcuId));
    } else {
      ({ wired, i2cBus } = wireComponents(runner, diagram, mcuId));
    }
    wiredRef.current = wired;

    if (!isStm32Runner(runner) && i2cBus && chipConfigs && chipConfigs.size > 0) {
      const mcus = findMCUs(diagram);
      const target = mcus.find((m) => m.id === mcuId) || mcus.find((m) => m.simulatable);
      const pinMapper = target?.pinStyle === "avr-port" ? mapAtmega328Pin : mapArduinoPin;
      import("@/lib/chip-runtime").then(({ wireCustomChipsAsync }) => {
        wireCustomChipsAsync(
          runner,
          diagram,
          mcuId || target?.id || "uno",
          pinMapper,
          wired,
          chipConfigs,
          i2cBus,
        ).then((runtimes) => {
          onChipRuntimesReady?.(runtimes);
        });
      });
    } else {
      onChipRuntimesReady?.(new Map());
    }

    const sensors: SensorEntry[] = [];
    for (const [id, wc] of wired) {
      if (wc.part.type === "wokwi-dht22" || wc.part.type === "wokwi-mpu6050" || wc.part.type === "wokwi-bmp180") {
        sensors.push({ id, type: wc.part.type, wc });
      }
    }
    setSensorEntries(sensors);
    onWiredComponentsChange?.(wired);

    for (const [id, wc] of wired) {
      const el = elementsRef.current.get(id);
      if (!el) continue;
      if (wc.part.type === "wokwi-led") wc.onStateChange = (high) => { (el as any).value = high; };
      else if (wc.part.type === "wokwi-buzzer") wc.onStateChange = (high) => { (el as any).hasSignal = high; };
      else if (wc.part.type === "wokwi-arduino-uno") (el as any).ledPower = true;
      else if (wc.part.type === "wokwi-servo") {
        wc.onAngleChange = (angle) => { (el as any).angle = angle; };
      } else if (wc.part.type === "wokwi-7segment") {
        wc.onSegmentChange = (values) => { (el as any).values = values; };
      }
      if (wc.ssd1306) {
        wc.ssd1306.onFrameReady = (imageData) => {
          (el as any).imageData = imageData;
          (el as any).redraw?.();
        };
      }
      if (wc.lcd1602) {
        (el as any).characters = wc.lcd1602.characters;
        wc.lcd1602.onCharactersChange = (chars) => {
          (el as any).characters = new Uint8Array(chars);
        };
      }
    }

    for (const [id, wc] of wired) {
      if (wc.part.type !== "wokwi-pushbutton") continue;
      const el = elementsRef.current.get(id);
      if (!el) continue;
      const onPress = () => wc.setPressed?.(true);
      const onRelease = () => wc.setPressed?.(false);
      el.addEventListener("button-press", onPress);
      el.addEventListener("button-release", onRelease);
      const wrapper = el.parentElement;
      if (wrapper) {
        wrapper.addEventListener("pointerdown", onPress);
        wrapper.addEventListener("pointerup", onRelease);
        wrapper.addEventListener("pointerleave", onRelease);
      }
    }

    for (const [id, wc] of wired) {
      if (wc.part.type !== "wokwi-slide-switch" || !wc.setState) continue;
      const el = elementsRef.current.get(id);
      if (!el) continue;
      let toggled = false;
      const onClick = (e: Event) => {
        e.stopPropagation();
        toggled = !toggled;
        (el as any).value = toggled ? 1 : 0;
        wc.setState!(toggled);
      };
      const wrapper = el.parentElement;
      if (wrapper) {
        wrapper.addEventListener("click", onClick);
        wrapper.style.cursor = "pointer";
      }
    }

    for (const [id, wc] of wired) {
      if ((wc.part.type !== "wokwi-potentiometer" && wc.part.type !== "wokwi-slide-potentiometer") || !wc.setValue) continue;
      const el = elementsRef.current.get(id);
      if (!el) continue;
      const onInput = () => {
        wc.setValue!(Math.round((el as any).value));
      };
      el.addEventListener("input", onInput);
    }

    for (const [id, wc] of wired) {
      if (wc.part.type !== "wokwi-ky-040") continue;
      const el = elementsRef.current.get(id);
      if (!el) continue;
      el.addEventListener("rotate-cw", () => wc.stepCW?.());
      el.addEventListener("rotate-ccw", () => wc.stepCCW?.());
      el.addEventListener("button-press", () => wc.pressEncoderButton?.());
      el.addEventListener("button-release", () => wc.releaseEncoderButton?.());
    }

    const keyMap = new Map<string, WiredComponent>();
    for (const [, wc] of wired) {
      if (wc.part.type !== "wokwi-pushbutton") continue;
      const key = wc.part.attrs.key;
      if (key) keyMap.set(key, wc);
    }
    const inEditor = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || !!el.closest(".monaco-editor");
    };
    const handleKeyDown = (e: KeyboardEvent) => { if (inEditor(e)) return; const wc = keyMap.get(e.key); if (wc) wc.setPressed?.(true); };
    const handleKeyUp = (e: KeyboardEvent) => { if (inEditor(e)) return; const wc = keyMap.get(e.key); if (wc) wc.setPressed?.(false); };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    const wiredForCleanup = wiredRef.current;
    const elementsForCleanup = elementsRef.current;
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      for (const [id, wc] of wiredForCleanup) {
        const el = elementsForCleanup.get(id);
        if (!el) continue;
        if (wc.part.type === "wokwi-led") (el as any).value = false;
        else if (wc.part.type === "wokwi-buzzer") (el as any).hasSignal = false;
        else if (wc.part.type === "wokwi-arduino-uno") (el as any).ledPower = false;
        else if (wc.part.type === "wokwi-slide-switch") (el as any).value = 0;
      }
      cleanupWiring(wiredForCleanup);
      setSensorEntries([]);
      onWiredComponentsChange?.(new Map());
    };
  }, [runner, diagram, chipConfigs, elementsRef, mcuId, onChipRuntimesReady, onWiredComponentsChange]);

  return { sensorEntries, wiredRef };
}
