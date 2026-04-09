// LCD1602 "Hello, World!" demo using the LiquidCrystal_I2C library.
// Prints a greeting on row 0 and a counter on row 1.
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

int counter = 0;

void setup() {
  Serial.begin(9600);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello, World!");
  lcd.setCursor(0, 1);
  lcd.print("count=");
  Serial.println("READY");
}

void loop() {
  lcd.setCursor(6, 1);
  // Pad to three digits so the layout stays stable.
  if (counter < 10)  lcd.print("  ");
  else if (counter < 100) lcd.print(" ");
  lcd.print(counter);
  Serial.print("tick ");
  Serial.println(counter);
  counter++;
  delay(500);
}
