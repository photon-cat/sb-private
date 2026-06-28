#include <Arduino.h>
void setup() {
  pinMode(15, OUTPUT);
  Serial.begin(115200);
}
void loop() {
  digitalWrite(15, HIGH);
  Serial.println("on");
  delay(100);
  digitalWrite(15, LOW);
  Serial.println("off");
  delay(100);
}
