// Client-shipped SVD for STM32G0/C0/L0 (Cortex-M0+) — runs on the rp2040js-
// derived CortexM0Host via STM32G0_MODELS, which has the full modern peripheral
// set (GPIO/RCC/USART/SPI/I2C/TIM/ADC/EXTI), so this exposes the breadth used by
// Phase 5 component wiring.

import { makeSvd } from "./make-svd";

export const STM32G0_SVD = makeSvd("STM32G0", [
  { name: "RCC", group: "RCC", base: 0x40021000 },
  { name: "FLASH", group: "FLASH", base: 0x40022000 },
  { name: "EXTI", group: "EXTI", base: 0x40021800 },
  { name: "GPIOA", group: "GPIO", base: 0x50000000 },
  { name: "GPIOB", group: "GPIO", base: 0x50000400 },
  { name: "GPIOC", group: "GPIO", base: 0x50000800 },
  { name: "GPIOD", group: "GPIO", base: 0x50000c00 },
  { name: "USART1", group: "USART", base: 0x40013800, irq: 27 },
  { name: "USART2", group: "USART", base: 0x40004400, irq: 28 },
  { name: "SPI1", group: "SPI", base: 0x40013000, irq: 25 },
  { name: "I2C1", group: "I2C", base: 0x40005400, irq: 23 },
  { name: "TIM2", group: "TIM", base: 0x40000000, irq: 15 },
  { name: "TIM3", group: "TIM", base: 0x40000400, irq: 16 },
  { name: "ADC1", group: "ADC", base: 0x40012400, irq: 12 },
]);
