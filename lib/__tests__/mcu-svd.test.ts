import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { parseSvd } from "../mcu";

const svdXml = readFileSync(path.join(__dirname, "fixtures", "stm32-mini.svd"), "utf-8");

describe("CMSIS-SVD loader", () => {
  const dev = parseSvd(svdXml);

  it("parses the device name and peripheral instances", () => {
    expect(dev.name).toBe("STM32F103_MINI");
    expect(dev.peripherals.map((p) => p.name).sort()).toEqual(["GPIOA", "GPIOB", "RCC", "USART1"]);
  });

  it("parses base addresses, sizes, and group names", () => {
    expect(dev.byName.get("RCC")!.baseAddress).toBe(0x40021000);
    expect(dev.byName.get("GPIOA")!.baseAddress).toBe(0x40010800);
    expect(dev.byName.get("USART1")!.baseAddress).toBe(0x40013800);
    expect(dev.byName.get("GPIOA")!.size).toBe(0x400);
    expect(dev.byName.get("USART1")!.group).toBe("USART");
  });

  it("parses interrupts", () => {
    expect(dev.byName.get("USART1")!.interrupts).toEqual([{ name: "USART1", value: 37 }]);
  });

  it("resolves derivedFrom: GPIOB inherits GPIOA's registers + group but keeps its own base", () => {
    const gpiob = dev.byName.get("GPIOB")!;
    expect(gpiob.baseAddress).toBe(0x40010c00);
    expect(gpiob.group).toBe("GPIO");
    expect(gpiob.registers.map((r) => r.name)).toContain("BSRR");
  });

  it("parses registers and fields", () => {
    const rcc = dev.byName.get("RCC")!;
    const apb2 = rcc.registers.find((r) => r.name === "APB2ENR")!;
    expect(apb2.addressOffset).toBe(0x18);
    expect(apb2.fields.find((f) => f.name === "USART1EN")).toEqual({
      name: "USART1EN",
      bitOffset: 14,
      bitWidth: 1,
    });
    const cr = rcc.registers.find((r) => r.name === "CR")!;
    expect(cr.resetValue).toBe(0x83);
  });
});
