// Actuator test: drives LEDs, a buzzer, and an SSD1306 OLED in a deterministic
// pattern, then prints the resulting state of each pin so the oracle test can
// verify SparkBench's avr8js simulation produces the same actuator state as
// the official Wokwi simulator.
//
// The sketch never reads any inputs — it only drives outputs, so the output
// depends purely on the firmware and the simulator's GPIO model.
#include <Wire.h>
#include <Adafruit_SSD1306.h>

const int LED_R = 11;
const int LED_G = 12;
const int LED_B = 13;
const int BUZZ  = 8;

Adafruit_SSD1306 oled(128, 64, &Wire, -1);

int frame = 0;

void printState(const char *tag) {
  // Read back the actual pin states from the AVR ports.
  int r = digitalRead(LED_R);
  int g = digitalRead(LED_G);
  int b = digitalRead(LED_B);
  int z = digitalRead(BUZZ);
  Serial.print(tag);
  Serial.print(" R=");  Serial.print(r);
  Serial.print(" G=");  Serial.print(g);
  Serial.print(" B=");  Serial.print(b);
  Serial.print(" BUZZ=");Serial.println(z);
}

void setup() {
  Serial.begin(9600);
  pinMode(LED_R, OUTPUT);
  pinMode(LED_G, OUTPUT);
  pinMode(LED_B, OUTPUT);
  pinMode(BUZZ,  OUTPUT);
  Wire.begin();
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print(F("ACTUATORS"));
  oled.display();
  Serial.println("READY");
}

void loop() {
  // Pattern: walk through 8 states (3-bit binary 000..111) on the LEDs.
  // Buzzer toggles every other frame so we exercise it independently.
  int s = frame & 0x7;
  digitalWrite(LED_R, (s & 1) ? HIGH : LOW);
  digitalWrite(LED_G, (s & 2) ? HIGH : LOW);
  digitalWrite(LED_B, (s & 4) ? HIGH : LOW);
  digitalWrite(BUZZ,  (frame & 1) ? HIGH : LOW);

  // Update the OLED with the frame counter.
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.print(F("ACTUATORS"));
  oled.setCursor(0, 16);
  oled.print(F("frame="));
  oled.print(frame);
  oled.display();

  printState("step");
  frame++;
  delay(100);
}
