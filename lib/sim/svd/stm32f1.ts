// Client-shipped SVD for STM32F1 (Cortex-M3) — runs on the unicorn.js core via
// STM32F1_MODELS. Declares every peripheral with an F1 behavioral model: clock
// (RCC/FLASH), GPIO ports + AFIO, EXTI, the USARTs, SPI/I2C, the timers, and
// ADC1. Register-window sizes default to 0x400; the models use fixed offsets.

import { makeSvd } from "./make-svd";

export const STM32F1_SVD = makeSvd("STM32F103", [
  // Clock / flash
  { name: "FLASH", group: "FLASH", base: 0x40022000 },
  { name: "RCC", group: "RCC", base: 0x40021000 },

  // GPIO ports + alternate-function I/O (EXTI mux / remap)
  { name: "AFIO", group: "AFIO", base: 0x40010000 },
  { name: "GPIOA", group: "GPIO", base: 0x40010800 },
  { name: "GPIOB", group: "GPIO", base: 0x40010c00 },
  { name: "GPIOC", group: "GPIO", base: 0x40011000 },
  { name: "GPIOD", group: "GPIO", base: 0x40011400 },
  { name: "GPIOE", group: "GPIO", base: 0x40011800 },

  // External interrupts (model maps lines → NVIC vectors itself)
  { name: "EXTI", group: "EXTI", base: 0x40010400 },

  // USARTs
  { name: "USART1", group: "USART", base: 0x40013800, irq: 37 },
  { name: "USART2", group: "USART", base: 0x40004400, irq: 38 },
  { name: "USART3", group: "USART", base: 0x40004800, irq: 39 },

  // SPI
  { name: "SPI1", group: "SPI", base: 0x40013000 },
  { name: "SPI2", group: "SPI", base: 0x40003800 },

  // I2C (irq = the event vector)
  { name: "I2C1", group: "I2C", base: 0x40005400, irq: 31 },
  { name: "I2C2", group: "I2C", base: 0x40005800, irq: 33 },

  // Timers (irq = the update vector)
  { name: "TIM1", group: "TIM", base: 0x40012c00, irq: 25 },
  { name: "TIM2", group: "TIM", base: 0x40000000, irq: 28 },
  { name: "TIM3", group: "TIM", base: 0x40000400, irq: 29 },
  { name: "TIM4", group: "TIM", base: 0x40000800, irq: 30 },

  // ADC (irq = ADC1_2)
  { name: "ADC1", group: "ADC", base: 0x40012400, irq: 18 },
]);
