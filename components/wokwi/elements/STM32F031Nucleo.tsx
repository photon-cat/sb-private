import React from "react";

interface STM32F031NucleoProps {
  /** User LED LD3 (green) state. */
  led?: boolean;
  width?: number;
  height?: number;
}

/**
 * Detailed ST Nucleo-32 (STM32F031K6) element (part type
 * `wokwi-stm32-nucleo-f031k6`, Cortex-M0 @48 MHz). Nucleo-32 form factor:
 * a mini ST-LINK at the top, the LQFP32 STM32F031 chip, the green LD3 user LED,
 * the power LED, and the two Nano-style pin headers.
 */
export function STM32F031Nucleo({ led = false, width = 90, height = 240 }: STM32F031NucleoProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 90 240"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="ST Nucleo-32 STM32F031K6 board"
    >
      {/* PCB body (Nucleo white) */}
      <rect x="14" y="5" width="62" height="230" rx="4" fill="#f5f5f5" stroke="#bdbdbd" strokeWidth="1.5" />

      {/* ── ST-LINK section (top), snap-off line ── */}
      <rect x="14" y="5" width="62" height="52" rx="4" fill="#eceff1" />
      <line x1="14" y1="57" x2="76" y2="57" stroke="#bdbdbd" strokeWidth="1" strokeDasharray="3 3" />
      {/* Micro-USB */}
      <rect x="33" y="0" width="24" height="11" rx="2" fill="#9e9e9e" stroke="#757575" strokeWidth="0.8" />
      {/* ST-LINK MCU */}
      <rect x="30" y="22" width="20" height="20" rx="2" fill="#1a1a1a" />
      <text x="40" y="34" fontSize="4.5" fill="#fff" textAnchor="middle" fontFamily="monospace">ST-LINK</text>
      {/* COM LED */}
      <circle cx="60" cy="32" r="3" fill="#76ff03" />
      <text x="60" y="46" fontSize="4" fill="#558b2f" textAnchor="middle" fontFamily="monospace">LD1</text>

      {/* Header pins (Nano-style, 15 per side) */}
      {Array.from({ length: 15 }, (_, i) => (
        <rect key={`l${i}`} x="6" y={66 + i * 11} width="7" height="7" rx="1" fill="#212121" />
      ))}
      {Array.from({ length: 15 }, (_, i) => (
        <rect key={`r${i}`} x="77" y={66 + i * 11} width="7" height="7" rx="1" fill="#212121" />
      ))}

      {/* STM32F031K6 LQFP32 chip */}
      <rect x="28" y="120" width="34" height="34" rx="2" fill="#16161c" stroke="#000" strokeWidth="0.5" />
      {Array.from({ length: 8 }, (_, i) => (
        <React.Fragment key={`p${i}`}>
          <rect x={31 + i * 3.7} y="117" width="1.4" height="3" fill="#cfcfcf" />
          <rect x={31 + i * 3.7} y="154" width="1.4" height="3" fill="#cfcfcf" />
          <rect x="25" y={123 + i * 3.7} width="3" height="1.4" fill="#cfcfcf" />
          <rect x="62" y={123 + i * 3.7} width="3" height="1.4" fill="#cfcfcf" />
        </React.Fragment>
      ))}
      <circle cx="33" cy="125" r="1.4" fill="#555" />
      <text x="45" y="135" fontSize="5.5" fill="#fff" textAnchor="middle" fontFamily="monospace">STM32</text>
      <text x="45" y="146" fontSize="5" fill="#bdbdbd" textAnchor="middle" fontFamily="monospace">F031</text>

      {/* Power LED (red) + user LED LD3 (green, on PB3) */}
      <circle cx="32" cy="170" r="3.5" fill="#e53935" />
      <text x="32" y="184" fontSize="4" fill="#b71c1c" textAnchor="middle" fontFamily="monospace">PWR</text>
      <circle cx="58" cy="170" r="4" fill={led ? "#69f0ae" : "#1c3a16"} />
      <text x="58" y="184" fontSize="4" fill="#2e7d32" textAnchor="middle" fontFamily="monospace">LD3</text>

      {/* Reset button */}
      <rect x="36" y="196" width="18" height="12" rx="2" fill="#212121" />
      <text x="45" y="204.5" fontSize="4.5" fill="#fff" textAnchor="middle" fontFamily="monospace">RST</text>

      {/* Silkscreen */}
      <text x="45" y="222" fontSize="5" fill="#616161" textAnchor="middle" fontFamily="monospace">NUCLEO-F031</text>
      <text x="45" y="231" fontSize="4.5" fill="#9e9e9e" textAnchor="middle" fontFamily="monospace">⚡SparkBench</text>
    </svg>
  );
}
