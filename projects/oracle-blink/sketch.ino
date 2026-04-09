void setup() {
  Serial.begin(9600);
  Serial.println("READY");
  pinMode(LED_BUILTIN, OUTPUT);
}

int counter = 0;
void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.print("tick ");
  Serial.println(counter++);
  delay(100);
  digitalWrite(LED_BUILTIN, LOW);
  delay(100);
}
