// STM32G0 peripheral base-address → name map, for diagnosing which IP block an
// unmapped access belongs to. Bases from the STM32G0x1 reference manual memory
// map; granularity is the 0x400 register window each peripheral occupies.

const G0_PERIPHERALS: Array<[number, string]> = [
  [0x40000000, "TIM2"],
  [0x40000400, "TIM3"],
  [0x40001000, "TIM6"],
  [0x40001400, "TIM7"],
  [0x40002800, "RTC"],
  [0x40002c00, "WWDG"],
  [0x40003000, "IWDG"],
  [0x40003800, "SPI2"],
  [0x40004400, "USART2"],
  [0x40004800, "USART3"],
  [0x40004c00, "USART4"],
  [0x40005400, "I2C1"],
  [0x40005800, "I2C2"],
  [0x40005c00, "USB"],
  [0x40006400, "FDCAN1"],
  [0x40007000, "PWR"],
  [0x40007400, "DAC1"],
  [0x40007800, "LPTIM1"],
  [0x40007c00, "LPUART1"],
  [0x40008000, "LPTIM2"],
  [0x40009400, "UCPD1"],
  [0x40009800, "UCPD2"],
  [0x40010000, "SYSCFG"],
  [0x40010200, "VREFBUF"],
  [0x40012400, "ADC1"],
  [0x40012c00, "TIM1"],
  [0x40013000, "SPI1"],
  [0x40013800, "USART1"],
  [0x40014000, "TIM14"],
  [0x40014400, "TIM15"],
  [0x40014800, "TIM16"],
  [0x40014c00, "TIM17"],
  [0x40015800, "DBG"],
  [0x40020000, "DMA1"],
  [0x40020400, "DMA2"],
  [0x40021000, "RCC"],
  [0x40021800, "EXTI"],
  [0x40022000, "FLASH"],
  [0x40023000, "CRC"],
  [0x50000000, "GPIOA"],
  [0x50000400, "GPIOB"],
  [0x50000800, "GPIOC"],
  [0x50000c00, "GPIOD"],
  [0x50001000, "GPIOE"],
  [0x50001400, "GPIOF"],
];

/** Window base (0x400-aligned) an address falls in, plus the peripheral name. */
export function peripheralAt(addr: number): { base: number; name: string } {
  const base = addr & ~0x3ff;
  for (const [b, name] of G0_PERIPHERALS) {
    if (addr >= b && addr < b + 0x400) return { base: b, name };
  }
  return { base, name: `0x${base.toString(16)}` };
}
