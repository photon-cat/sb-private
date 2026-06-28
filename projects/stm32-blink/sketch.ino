#include <Arduino.h>

// STM32F103 "Blue Pill" blink — PC13 (on-board LED).
//
// Uses a custom main() with a busy-loop delay instead of setup()/loop()+delay().
// On the in-browser unicorn.js core there is no Cortex-M NVIC yet, so SysTick
// interrupts don't fire and HAL's delay() (HAL_GetTick) would never advance.
// A counted nop loop keeps the blink purely instruction-driven, so it runs on
// the browser core today. (On real silicon and the QEMU oracle it blinks too.)
int main(void) {
  pinMode(PC13, OUTPUT);
  volatile uint32_t i;
  for (;;) {
    digitalWrite(PC13, HIGH);
    for (i = 0; i < 200000; i++) { __asm__ volatile("nop"); }
    digitalWrite(PC13, LOW);
    for (i = 0; i < 200000; i++) { __asm__ volatile("nop"); }
  }
}
