.syntax unified
.cpu cortex-m3
.thumb
.section .vectors,"a"
.word 0x20005000          @ [0x08000000] initial SP
.word reset+1             @ [0x08000004] reset vector (thumb)
.text
.thumb_func
.global reset
reset:
  movs r0, #7
  movs r1, #6
  movs r2, #5
  mla  r3, r0, r1, r2      @ 7*6+5 = 47   (Thumb-2-only; faults on M0+)
  udiv r4, r3, r0          @ 47/7 = 6     (Thumb-2-only)
  ldr  r5, =0x20000000     @ SRAM base
  str  r3, [r5]            @ SRAM[0] = 47
  str  r4, [r5, #4]        @ SRAM[1] = 6
  ldr  r6, =0x40013804     @ a peripheral MMIO address (USART1 region)
  movs r0, #0x41           @ 'A'
  str  r0, [r6]            @ MMIO write -> bridged to MMIOBus
  ldr  r7, [r6]            @ MMIO read  -> bridged from MMIOBus (substituted)
  str  r7, [r5, #8]        @ SRAM[2] = value the bus returned
hang:
  b hang
