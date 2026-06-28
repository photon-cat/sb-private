import React from "react";

interface RP2040Props {
  /** Onboard RGB/NeoPixel LED state (lights green when on). */
  led?: boolean;
  /** RGB color override for the onboard LED when `led` is true. */
  ledColor?: string;
  width?: number;
  height?: number;
}

// Castellated GPIO labels down each side of a generic RP2040 mini-module
// (RP2040-Zero / Tiny2040 style), distinct from the full Raspberry Pi Pico.
const LEFT_PINS = ["GP0", "GP1", "GP2", "GP3", "GP4", "GP5", "GP6", "GP7", "GP8"];
const RIGHT_PINS = ["GP29", "GP28", "GP27", "GP26", "GP15", "GP14", "GP13", "GP12", "GP11"];

/**
 * Detailed, simulator-wired generic RP2040 module element (part type
 * `wokwi-rp2040`). Renders a compact board with a QFN-56 RP2040, castellated
 * GPIO pads, USB-C, onboard RGB LED, BOOT/RESET buttons, crystal and flash.
 */
export function RP2040({ led = false, ledColor = "#76ff03", width = 150, height = 200 }: RP2040Props) {
  const padPitch = 18;
  const padTop = 30;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 150 200"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="RP2040 module"
    >
      {/* PCB body (deep purple, like an RP2040-Zero) */}
      <rect x="18" y="8" width="114" height="184" rx="8" fill="#4a148c" stroke="#2e0a57" strokeWidth="1.5" />

      {/* USB-C connector */}
      <rect x="55" y="2" width="40" height="14" rx="5" fill="#cfd8dc" stroke="#90a4ae" strokeWidth="1" />
      <rect x="62" y="5" width="26" height="8" rx="4" fill="#78909c" />
      <text x="75" y="26" fontSize="6" fill="#ce93d8" textAnchor="middle" fontFamily="monospace">USB-C</text>

      {/* Castellated pads + labels (left) */}
      {LEFT_PINS.map((p, i) => (
        <g key={`l${i}`}>
          <rect x="14" y={padTop + i * padPitch} width="10" height="11" rx="2" fill="#d4af37" />
          <path d={`M14 ${padTop + i * padPitch} a5.5 5.5 0 0 0 0 11`} fill="#b8860b" />
          <text x="30" y={padTop + i * padPitch + 9} fontSize="6" fill="#e1bee7" fontFamily="monospace">{p}</text>
        </g>
      ))}
      {/* Castellated pads + labels (right) */}
      {RIGHT_PINS.map((p, i) => (
        <g key={`r${i}`}>
          <rect x="126" y={padTop + i * padPitch} width="10" height="11" rx="2" fill="#d4af37" />
          <path d={`M136 ${padTop + i * padPitch} a5.5 5.5 0 0 1 0 11`} fill="#b8860b" />
          <text x="120" y={padTop + i * padPitch + 9} fontSize="6" fill="#e1bee7" textAnchor="end" fontFamily="monospace">{p}</text>
        </g>
      ))}

      {/* QFN-56 RP2040 chip */}
      <rect x="52" y="80" width="46" height="46" rx="3" fill="#15151a" stroke="#000" strokeWidth="0.5" />
      {/* QFN pin ticks */}
      {Array.from({ length: 13 }, (_, i) => (
        <React.Fragment key={`q${i}`}>
          <rect x={55 + i * 3.2} y="78" width="1.6" height="3" fill="#9e9e9e" />
          <rect x={55 + i * 3.2} y="126" width="1.6" height="3" fill="#9e9e9e" />
          <rect x="50" y={83 + i * 3.2} width="3" height="1.6" fill="#9e9e9e" />
          <rect x="97" y={83 + i * 3.2} width="3" height="1.6" fill="#9e9e9e" />
        </React.Fragment>
      ))}
      <circle cx="58" cy="86" r="1.6" fill="#616161" />
      <text x="75" y="100" fontSize="7" fill="#fff" textAnchor="middle" fontFamily="monospace">RP2040</text>
      <text x="75" y="110" fontSize="4.5" fill="#bdbdbd" textAnchor="middle" fontFamily="monospace">QFN-56</text>

      {/* QSPI flash chip */}
      <rect x="58" y="138" width="20" height="14" rx="1" fill="#212121" />
      <text x="68" y="148" fontSize="4" fill="#9e9e9e" textAnchor="middle" fontFamily="monospace">FLASH</text>

      {/* Crystal */}
      <rect x="84" y="138" width="16" height="9" rx="3" fill="#9e9e9e" stroke="#616161" strokeWidth="0.5" />
      <text x="92" y="145" fontSize="3.5" fill="#212121" textAnchor="middle" fontFamily="monospace">12M</text>

      {/* Onboard RGB LED */}
      <rect x="66" y="56" width="18" height="14" rx="2" fill={led ? ledColor : "#1b1b22"} stroke="#000" strokeWidth="0.5" />
      <text x="75" y="160" fontSize="5" fill="#ce93d8" textAnchor="middle" fontFamily="monospace">RGB</text>

      {/* BOOT + RESET buttons */}
      <rect x="30" y="160" width="20" height="16" rx="2" fill="#37474f" stroke="#263238" strokeWidth="0.5" />
      <text x="40" y="184" fontSize="5" fill="#b0bec5" textAnchor="middle" fontFamily="monospace">BOOT</text>
      <rect x="100" y="160" width="20" height="16" rx="2" fill="#37474f" stroke="#263238" strokeWidth="0.5" />
      <text x="110" y="184" fontSize="5" fill="#b0bec5" textAnchor="middle" fontFamily="monospace">RUN</text>

      {/* Silkscreen */}
      <text x="75" y="192" fontSize="5" fill="#ba68c8" textAnchor="middle" fontFamily="monospace">⚡ RP2040</text>
    </svg>
  );
}
