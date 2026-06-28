#include <Wire.h>
#define ADDR 0x3C
void cmd(uint8_t c){ Wire.beginTransmission(ADDR); Wire.write(0x00); Wire.write(c); Wire.endTransmission(); }
void setColPage(uint8_t c0,uint8_t c1,uint8_t p0,uint8_t p1){
  Wire.beginTransmission(ADDR); Wire.write(0x00);
  Wire.write(0x21); Wire.write(c0); Wire.write(c1);
  Wire.write(0x22); Wire.write(p0); Wire.write(p1);
  Wire.endTransmission();
}
void fill(uint8_t c0,uint8_t c1,uint8_t val){
  setColPage(c0,c1,0,7);
  long n=(long)(c1-c0+1)*8;
  for(long i=0;i<n;){
    Wire.beginTransmission(ADDR); Wire.write(0x40);
    for(int k=0;k<16 && i<n;k++,i++) Wire.write(val);
    Wire.endTransmission();
  }
}
void setup(){
  Wire.begin();
  cmd(0xAE); { Wire.beginTransmission(ADDR); Wire.write(0x00); Wire.write(0x20); Wire.write(0x00); Wire.endTransmission(); } cmd(0xAF);
  fill(0,63,0xFF);    // left half ON
  fill(64,127,0x00);  // right half OFF
  Serial.begin(9600); Serial.println("DONE");
}
void loop(){}
