void setup() {
  Serial.begin(9600);
  Serial.println("READY");
}
void loop() {
  Serial.println("tick");
  delay(1000);
}
