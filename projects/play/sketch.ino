#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>

#define DHTPIN 2
#define DHTTYPE DHT22

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
DHT dht(DHTPIN, DHTTYPE);

unsigned long lastRead = 0;
const unsigned long READ_INTERVAL = 2000;

float tempHigh = -999.0;
float tempLow = 999.0;

void setup() {
  Serial.begin(115200);
  Serial.println("DHT22 + SSD1306 Display starting...");

  dht.begin();

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 init failed!");
    while (1);
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(20, 28);
  display.print("Initializing...");
  display.display();

  Serial.println("Setup complete.");
}

void loop() {
  if (millis() - lastRead < READ_INTERVAL) return;
  lastRead = millis();

  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    Serial.println("DHT read failed!");
    return;
  }

  // Track high/low
  if (temp > tempHigh) tempHigh = temp;
  if (temp < tempLow) tempLow = temp;

  Serial.print("Temp: ");
  Serial.print(temp, 1);
  Serial.print(" C  Hum: ");
  Serial.print(hum, 1);
  Serial.print(" %  Hi: ");
  Serial.print(tempHigh, 1);
  Serial.print("  Lo: ");
  Serial.println(tempLow, 1);

  display.clearDisplay();

  // Title
  display.setTextSize(1);
  display.setCursor(20, 0);
  display.print("Temp & Humidity");

  // Horizontal divider
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  // Current temperature - large
  display.setTextSize(2);
  display.setCursor(0, 14);
  display.print(temp, 1);
  display.setTextSize(1);
  display.setCursor(display.getCursorX(), 14);
  display.print(" C");

  // Current humidity - large
  display.setTextSize(2);
  display.setCursor(0, 34);
  display.print(hum, 1);
  display.setTextSize(1);
  display.setCursor(display.getCursorX(), 34);
  display.print(" %");

  // Divider above hi/lo
  display.drawLine(0, 53, 127, 53, SSD1306_WHITE);

  // High / Low line
  display.setTextSize(1);
  display.setCursor(0, 56);
  display.print("Hi:");
  display.print(tempHigh, 1);
  display.print("C  Lo:");
  display.print(tempLow, 1);
  display.print("C");

  display.display();
}
