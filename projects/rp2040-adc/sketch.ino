// RP2040 analog input demo: read a potentiometer on GP26 (ADC0) and light an
// LED on GP15 when the reading crosses half-scale. Exercises the headless ADC
// path (RP2040Runner.setAdcChannel via the potentiometer wiring).
#include <Arduino.h>

const int LED = 15;
const int POT = 26; // GP26 = ADC channel 0

void setup() {
  pinMode(LED, OUTPUT);
  analogReadResolution(12); // 0..4095, so the threshold is deterministic
}

void loop() {
  int v = analogRead(POT);
  digitalWrite(LED, v > 2000 ? HIGH : LOW);
  delay(10);
}
