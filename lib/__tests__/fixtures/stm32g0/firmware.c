/*
 * Bare-metal STM32G0 (Cortex-M0+) firmware for SparkBench's Phase-3 acceptance.
 * Compiled with real arm-none-eabi-gcc; the resulting raw .bin is committed so
 * CI needs no toolchain. Exercises the SVD-driven peripheral bus end to end:
 *
 *   1. Enable GPIOA clock, set PA5 as output, drive it high.
 *   2. Enable + configure USART1, transmit "HI".
 *   3. Enable the USART1 RX interrupt in the NVIC; on RX, echo (byte + 1) to
 *      prove the interrupt vectored through the borrowed Cortex-M0+ core's NVIC.
 */
#include <stdint.h>

#define REG(a) (*(volatile uint32_t *)(a))

#define RCC_BASE 0x40021000u
#define RCC_IOPENR REG(RCC_BASE + 0x34)  /* GPIO port clock enable */
#define RCC_APBENR2 REG(RCC_BASE + 0x40) /* USART1 on APB2 */

#define GPIOA_BASE 0x50000000u
#define GPIOA_MODER REG(GPIOA_BASE + 0x00)
#define GPIOA_BSRR REG(GPIOA_BASE + 0x18)

#define USART1_BASE 0x40013800u
#define USART1_CR1 REG(USART1_BASE + 0x00)
#define USART1_BRR REG(USART1_BASE + 0x0c)
#define USART1_ISR REG(USART1_BASE + 0x1c)
#define USART1_RDR REG(USART1_BASE + 0x24)
#define USART1_TDR REG(USART1_BASE + 0x28)

#define ISR_RXNE (1u << 5)
#define ISR_TXE (1u << 7)
#define CR1_UE (1u << 0)
#define CR1_RE (1u << 2)
#define CR1_TE (1u << 3)
#define CR1_RXNEIE (1u << 5)

#define NVIC_ISER REG(0xe000e100u)
#define USART1_IRQn 27

static void uart_putc(char c) {
  while (!(USART1_ISR & ISR_TXE)) {
  }
  USART1_TDR = (uint8_t)c;
}

void Reset_Handler(void) {
  RCC_IOPENR |= (1u << 0); /* GPIOAEN */
  GPIOA_MODER = (GPIOA_MODER & ~(3u << 10)) | (1u << 10); /* PA5 = output */
  GPIOA_BSRR = (1u << 5);                                 /* PA5 high */

  RCC_APBENR2 |= (1u << 14); /* USART1EN */
  USART1_BRR = 139;          /* 16 MHz / 115200 (unused by the model) */
  USART1_CR1 = CR1_UE | CR1_TE | CR1_RE | CR1_RXNEIE;
  NVIC_ISER = (1u << USART1_IRQn);

  uart_putc('H');
  uart_putc('I');

  for (;;) {
  }
}

void USART1_IRQHandler(void) {
  if (USART1_ISR & ISR_RXNE) {
    uint8_t b = (uint8_t)USART1_RDR; /* read clears RXNE */
    uart_putc((char)(b + 1));        /* echo byte+1 */
  }
}

void Default_Handler(void) {
  for (;;) {
  }
}

extern uint32_t _estack;

__attribute__((section(".isr_vector"), used)) void (*const vectors[])(void) = {
    (void (*)(void))(&_estack), /* 0  initial SP */
    Reset_Handler,              /* 1  reset */
    Default_Handler,            /* 2  NMI */
    Default_Handler,            /* 3  HardFault */
    [11] = Default_Handler,     /* SVCall */
    [14] = Default_Handler,     /* PendSV */
    [15] = Default_Handler,     /* SysTick */
    [16 + USART1_IRQn] = USART1_IRQHandler,
};
