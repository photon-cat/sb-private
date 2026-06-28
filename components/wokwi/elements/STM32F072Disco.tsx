import React from "react";

interface STM32F072DiscoProps {
  /** User LED states: [LD3 red, LD4 blue, LD5 orange, LD6 green]. */
  leds?: [boolean, boolean, boolean, boolean];
  width?: number;
  height?: number;
}

const LED_OFF = ["#5a1a1a", "#16263a", "#5a3a12", "#1c3a16"];
const LED_ON = ["#ff5252", "#448aff", "#ffa726", "#69f0ae"];

/**
 * Detailed STM32F072B-DISCO element (part type `wokwi-stm32-disco-f072rb`,
 * Cortex-M0 @48 MHz). Shows the ST-LINK section, the STM32F072 LQFP chip, the
 * four user LEDs in their cross layout, the USER/RESET buttons and side headers.
 */
export function STM32F072Disco({
  leds = [false, false, false, false],
  width = 150,
  height = 230,
}: STM32F072DiscoProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 150 230"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="STM32F072B-DISCO board"
    >
      {/* PCB body (ST green) */}
      <rect x="8" y="5" width="134" height="220" rx="5" fill="#0b5a3c" stroke="#063d28" strokeWidth="1.5" />

      {/* ── ST-LINK section (top), separated by a snap line ── */}
      <rect x="8" y="5" width="134" height="48" rx="5" fill="#0a4f35" />
      <line x1="8" y1="53" x2="142" y2="53" stroke="#063d28" strokeWidth="1" strokeDasharray="3 3" />
      {/* Mini-USB */}
      <rect x="58" y="0" width="34" height="12" rx="2" fill="#bdbdbd" stroke="#8d8d8d" strokeWidth="0.8" />
      {/* ST-LINK MCU */}
      <rect x="55" y="22" width="24" height="24" rx="2" fill="#1a1a1a" />
      <text x="67" y="36" fontSize="5" fill="#fff" textAnchor="middle" fontFamily="monospace">ST-LINK</text>
      {/* ST-LINK LED */}
      <circle cx="100" cy="34" r="3.5" fill="#76ff03" />
      <text x="100" y="48" fontSize="4.5" fill="#a5d6a7" textAnchor="middle" fontFamily="monospace">LD1</text>

      {/* Header pins (left + right) */}
      {Array.from({ length: 12 }, (_, i) => (
        <rect key={`l${i}`} x="2" y={62 + i * 13} width="6" height="6" rx="1" fill="#ffd54f" />
      ))}
      {Array.from({ length: 12 }, (_, i) => (
        <rect key={`r${i}`} x="142" y={62 + i * 13} width="6" height="6" rx="1" fill="#ffd54f" />
      ))}

      {/* STM32F072 LQFP64 chip */}
      <rect x="52" y="95" width="46" height="46" rx="2" fill="#16161c" stroke="#000" strokeWidth="0.5" />
      {Array.from({ length: 14 }, (_, i) => (
        <React.Fragment key={`p${i}`}>
          <rect x={54 + i * 3.1} y="92" width="1.4" height="3" fill="#cfcfcf" />
          <rect x={54 + i * 3.1} y="141" width="1.4" height="3" fill="#cfcfcf" />
          <rect x="49" y={98 + i * 3.1} width="3" height="1.4" fill="#cfcfcf" />
          <rect x="98" y={98 + i * 3.1} width="3" height="1.4" fill="#cfcfcf" />
        </React.Fragment>
      ))}
      <circle cx="58" cy="101" r="1.5" fill="#555" />
      <text x="75" y="116" fontSize="6.5" fill="#fff" textAnchor="middle" fontFamily="monospace">STM32</text>
      <text x="75" y="126" fontSize="6" fill="#bdbdbd" textAnchor="middle" fontFamily="monospace">F072</text>

      {/* Four user LEDs in a cross/diamond (LD3 up, LD6 right, LD4 down, LD5 left) */}
      <circle cx="75" cy="160" r="5" fill={leds[0] ? LED_ON[0] : LED_OFF[0]} />
      <circle cx="92" cy="177" r="5" fill={leds[3] ? LED_ON[3] : LED_OFF[3]} />
      <circle cx="75" cy="194" r="5" fill={leds[1] ? LED_ON[1] : LED_OFF[1]} />
      <circle cx="58" cy="177" r="5" fill={leds[2] ? LED_ON[2] : LED_OFF[2]} />
      <text x="75" y="150" fontSize="4" fill="#cfd8dc" textAnchor="middle" fontFamily="monospace">LD3</text>
      <text x="105" y="180" fontSize="4" fill="#cfd8dc" textAnchor="middle" fontFamily="monospace">LD6</text>
      <text x="75" y="206" fontSize="4" fill="#cfd8dc" textAnchor="middle" fontFamily="monospace">LD4</text>
      <text x="45" y="180" fontSize="4" fill="#cfd8dc" textAnchor="middle" fontFamily="monospace">LD5</text>

      {/* USER (blue) + RESET (black) buttons */}
      <rect x="18" y="150" width="18" height="14" rx="2" fill="#1565c0" stroke="#0d47a1" strokeWidth="0.6" />
      <text x="27" y="172" fontSize="4.5" fill="#90caf9" textAnchor="middle" fontFamily="monospace">USER</text>
      <rect x="114" y="150" width="18" height="14" rx="2" fill="#212121" stroke="#000" strokeWidth="0.6" />
      <text x="123" y="172" fontSize="4.5" fill="#bdbdbd" textAnchor="middle" fontFamily="monospace">RST</text>

      {/* Silkscreen */}
      <text x="75" y="220" fontSize="5.5" fill="#a5d6a7" textAnchor="middle" fontFamily="monospace">⚡ F072B-DISCO</text>
    </svg>
  );
}
