// Custom Chip Test: Inverter
// Drives pin 2 HIGH/LOW and reads inverted output on pin 3

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);  // Connected to inverter IN
  pinMode(3, INPUT);   // Connected to inverter OUT
  Serial.println("Inverter chip test");
}

void loop() {
  // Drive HIGH, expect LOW back
  digitalWrite(2, HIGH);
  delay(100);
  int val1 = digitalRead(3);
  Serial.print("IN=HIGH -> OUT=");
  Serial.println(val1 == LOW ? "LOW (correct)" : "HIGH (WRONG)");

  // Drive LOW, expect HIGH back
  digitalWrite(2, LOW);
  delay(100);
  int val2 = digitalRead(3);
  Serial.print("IN=LOW  -> OUT=");
  Serial.println(val2 == HIGH ? "HIGH (correct)" : "LOW (WRONG)");

  delay(2000);
}
