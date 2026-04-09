// CD4051B 8-channel analog multiplexer demo.
//
// Cycles through channels 0..7, reads the muxed voltage on A0, prints to
// Serial, and shows the current channel + value on the LCD1602.
//
// Expected Serial output (with default pot values 100, 200, ..., 800):
//   ch=0 v=100
//   ch=1 v=200
//   ...
//   ch=7 v=800
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

const int PIN_A   = 4;
const int PIN_B   = 5;
const int PIN_C   = 6;
const int PIN_OUT = A0;

LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  Serial.begin(9600);
  pinMode(PIN_A, OUTPUT);
  pinMode(PIN_B, OUTPUT);
  pinMode(PIN_C, OUTPUT);
  pinMode(PIN_OUT, INPUT);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("CD4051B Mux");
  Serial.println("READY");
}

void selectChannel(int ch) {
  digitalWrite(PIN_A, (ch & 1) ? HIGH : LOW);
  digitalWrite(PIN_B, (ch & 2) ? HIGH : LOW);
  digitalWrite(PIN_C, (ch & 4) ? HIGH : LOW);
}

void loop() {
  for (int ch = 0; ch < 8; ch++) {
    selectChannel(ch);
    delay(5);
    int v = analogRead(PIN_OUT);
    Serial.print("ch=");
    Serial.print(ch);
    Serial.print(" v=");
    Serial.println(v);

    lcd.setCursor(0, 1);
    lcd.print("ch=");
    lcd.print(ch);
    lcd.print(" v=   ");
    lcd.setCursor(7, 1);
    lcd.print(v);
    lcd.print("   ");
  }
  delay(500);
}
