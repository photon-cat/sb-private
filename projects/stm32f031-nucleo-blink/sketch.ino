// ST Nucleo-32 STM32F031K6 (wokwi-stm32-nucleo-f031k6) blink.
// LD3 (green) is on PB3. Proves the F031 board part-type builds (nucleo_f031k6)
// and runs on the Cortex-M0 core.
#include <Arduino.h>

void setup() {
  pinMode(PB3, OUTPUT);
}

void loop() {
  digitalWrite(PB3, HIGH);
  delay(100);
  digitalWrite(PB3, LOW);
  delay(100);
}
