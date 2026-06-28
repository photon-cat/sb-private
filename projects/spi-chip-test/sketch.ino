#include <SPI.h>
void setup() {
  Serial.begin(9600);
  pinMode(SS, OUTPUT);
  digitalWrite(SS, HIGH);
  SPI.begin();
  SPI.setClockDivider(SPI_CLOCK_DIV16);
  Serial.println("READY");
  delay(50);

  digitalWrite(SS, LOW);
  delay(1);
  uint8_t a = SPI.transfer(0x0F);  // expect initial 0x42
  uint8_t b = SPI.transfer(0x00);  // expect 0x0F ^ 0xFF = 0xF0
  digitalWrite(SS, HIGH);

  Serial.print("A="); Serial.println(a, HEX);
  Serial.print("B="); Serial.println(b, HEX);
}
void loop() {}
