void setup() {
  Serial.begin(9600);
  delay(100);
  Serial.write('A');        // 0x41 -> chip echoes 0x42 ('B')
  delay(60);
  int r = -1;
  if (Serial.available()) r = Serial.read();
  delay(10);
  Serial.print("R=");
  Serial.println(r, HEX);   // expect "R=42"
}
void loop() {}
