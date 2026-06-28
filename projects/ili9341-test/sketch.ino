#include <SPI.h>
#define TFT_CS 10
#define TFT_DC 9
#define W 120
#define H 80

static void wcmd(uint8_t c) { digitalWrite(TFT_DC, LOW);  SPI.transfer(c); }
static void wdat(uint8_t d) { digitalWrite(TFT_DC, HIGH); SPI.transfer(d); }

static void setWindow(int x0, int y0, int x1, int y1) {
  wcmd(0x2A); wdat(x0 >> 8); wdat(x0 & 0xFF); wdat(x1 >> 8); wdat(x1 & 0xFF);
  wcmd(0x2B); wdat(y0 >> 8); wdat(y0 & 0xFF); wdat(y1 >> 8); wdat(y1 & 0xFF);
  wcmd(0x2C);
}

static void fillRect(int x, int y, int w, int h, uint16_t color) {
  setWindow(x, y, x + w - 1, y + h - 1);
  uint8_t hi = color >> 8, lo = color & 0xFF;
  for (long i = 0; i < (long)w * h; i++) { wdat(hi); wdat(lo); }
}

void setup() {
  Serial.begin(9600);
  pinMode(TFT_CS, OUTPUT); pinMode(TFT_DC, OUTPUT);
  digitalWrite(TFT_CS, HIGH);
  SPI.begin();
  SPI.setClockDivider(SPI_CLOCK_DIV2);

  digitalWrite(TFT_CS, LOW);
  fillRect(0,  0, 40, H, 0xF800);  // red bar
  fillRect(40, 0, 40, H, 0x07E0);  // green bar
  fillRect(80, 0, 40, H, 0x001F);  // blue bar
  digitalWrite(TFT_CS, HIGH);

  Serial.println("DONE");
}
void loop() {}
