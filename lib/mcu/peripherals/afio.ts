// STM32 AFIO (Alternate Function I/O), F1-only. Holds the EXTI line→port mux
// (EXTICR1..4) and peripheral remap config (MAPR). We don't model remapping
// behavior, but the block must exist as plain read/write memory so HAL's
// clock-enabled writes to EXTICR/MAPR don't fault on the strict (unicorn) bus.

import { RegisterPeripheral } from "../peripheral";

export class STM32AfioF1 extends RegisterPeripheral {}
