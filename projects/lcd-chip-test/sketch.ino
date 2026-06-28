#include <SPI.h>
void setup() {
  Serial.begin(9600);
  pinMode(SS, OUTPUT);
  digitalWrite(SS, HIGH);
  SPI.begin();
  SPI.setClockDivider(SPI_CLOCK_DIV16);
  delay(50);
  digitalWrite(SS, LOW);
  delay(1);
  SPI.transfer(0xFF);   // clear
  SPI.transfer('H');    // cell 0
  SPI.transfer('I');    // cell 1
  digitalWrite(SS, HIGH);
  Serial.println("DONE");
}
void loop() {}
