// Read the amplifier chip's output on A0 and print it.
void setup() {
  Serial.begin(9600);
  pinMode(A0, INPUT);
  Serial.println("READY");
}

void loop() {
  int v = analogRead(A0);
  Serial.print("out=");
  Serial.println(v);
  delay(300);
}
