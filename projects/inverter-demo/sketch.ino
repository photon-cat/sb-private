// Inverter chip demo: drive pin 8 high/low, the custom Inverter chip
// inverts it onto pin 9, and we read pin 9 back to verify.
const int IN_PIN  = 8;
const int OUT_PIN = 9;

void setup() {
  Serial.begin(9600);
  pinMode(IN_PIN, OUTPUT);
  pinMode(OUT_PIN, INPUT);
  Serial.println("READY");
}

void loop() {
  digitalWrite(IN_PIN, HIGH);
  delay(50);
  int v1 = digitalRead(OUT_PIN);
  Serial.print("IN=HIGH OUT="); Serial.println(v1);

  digitalWrite(IN_PIN, LOW);
  delay(50);
  int v2 = digitalRead(OUT_PIN);
  Serial.print("IN=LOW OUT="); Serial.println(v2);

  delay(500);
}
