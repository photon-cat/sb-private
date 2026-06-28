// RP2040 I2C demo using only the built-in Wire library (no external deps).
// Probes the SSD1306 at 0x3C on I2C0 (GP4=SDA, GP5=SCL). When the simulated
// device ACKs the address, endTransmission() returns 0 and the LED lights —
// proving the rp2040js RPI2C ↔ SSD1306Controller bridge round-trips.
#include <Arduino.h>
#include <Wire.h>

const int LED = 15;

void setup() {
  pinMode(LED, OUTPUT);
  Wire.begin();
}

void loop() {
  Wire.beginTransmission(0x3C);
  uint8_t err = Wire.endTransmission(); // 0 = device ACKed
  digitalWrite(LED, err == 0 ? HIGH : LOW);
  delay(20);
}
