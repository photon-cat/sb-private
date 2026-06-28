// Generic RP2040 module (wokwi-rp2040) blink — proves the new board part-type
// builds (PlatformIO pico target) and runs on the rp2040js core.
#include <Arduino.h>

const int LED = 15;

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, HIGH);
  delay(100);
  digitalWrite(LED, LOW);
  delay(100);
}
