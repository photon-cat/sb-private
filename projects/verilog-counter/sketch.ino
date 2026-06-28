#define CLK 8
#define RST 9
const int Q[4] = {10, 11, 12, 13};
void setup() {
  Serial.begin(9600);
  pinMode(CLK, OUTPUT); pinMode(RST, OUTPUT);
  for (int i = 0; i < 4; i++) pinMode(Q[i], INPUT);
  digitalWrite(CLK, LOW);
  digitalWrite(RST, HIGH); digitalWrite(RST, LOW);   // reset to 0
  for (int i = 0; i < 5; i++) { digitalWrite(CLK, HIGH); digitalWrite(CLK, LOW); }
  int c = 0;
  for (int i = 0; i < 4; i++) if (digitalRead(Q[i])) c |= (1 << i);
  Serial.print("COUNT="); Serial.println(c);
}
void loop() {}
