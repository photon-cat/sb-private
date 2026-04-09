// Generic DIP chip — does nothing at runtime. The purpose of this chip
// is purely to demonstrate diagram.json-driven pin count: three instances
// of chip-genericdip are placed with attrs.pins = "8", "16", "20".
#include "wokwi-api.h"
#include <stdio.h>
void chip_init(void) {
  printf("genericdip ready\n");
}
