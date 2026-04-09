// Magic-8 I2C demo sketch.
// Talks to the custom chip at 0x42 and prints the register values it reads.
#include <Wire.h>

const uint8_t ADDR = 0x42;

uint8_t readReg(uint8_t reg) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  Wire.endTransmission();
  Wire.requestFrom(ADDR, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0x00;
}

void writeReg(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

void setup() {
  Wire.begin();
  Serial.begin(9600);
  Serial.println("READY");
}

void loop() {
  uint8_t magic = readReg(0x00);
  uint8_t c1 = readReg(0x01);
  uint8_t c2 = readReg(0x01);
  uint8_t echoBefore = readReg(0x02);
  writeReg(0x03, 0x5A);
  uint8_t echoAfter = readReg(0x02);

  Serial.print("magic=0x");    Serial.println(magic, HEX);
  Serial.print("counter1=");   Serial.println(c1);
  Serial.print("counter2=");   Serial.println(c2);
  Serial.print("echoBefore=0x"); Serial.println(echoBefore, HEX);
  Serial.print("echoAfter=0x");  Serial.println(echoAfter, HEX);
  Serial.println("---");

  delay(2000);
}
