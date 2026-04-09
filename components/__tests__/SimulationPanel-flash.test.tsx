import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SimulationPanel from "../SimulationPanel";
import type { FlashProgress } from "@/lib/stk500";

// Mock heavy dynamic imports that aren't relevant to flash UI tests
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Stub = () => null;
    Stub.displayName = "DynamicStub";
    return Stub;
  },
}));

// Track useWebFlash state for test control
let mockWebFlash = {
  isSupported: false,
  isFlashing: false,
  progress: null as FlashProgress | null,
  flash: vi.fn(),
};

vi.mock("@/hooks/useWebFlash", () => ({
  useWebFlash: () => mockWebFlash,
}));

// Mock DiagramCanvas (heavy WebGL component)
vi.mock("../DiagramCanvas", () => ({
  __esModule: true,
  default: () => <div data-testid="diagram-canvas" />,
}));

// Mock SimulationControls
vi.mock("../SimulationControls", () => ({
  __esModule: true,
  default: () => <div data-testid="sim-controls" />,
}));

// Mock SerialMonitor
vi.mock("../SerialMonitor", () => ({
  __esModule: true,
  default: () => <div data-testid="serial-monitor" />,
}));

// Mock Tabs
vi.mock("../Tabs", () => ({
  __esModule: true,
  default: ({ tabs, activeId, onTabChange }: { tabs: { id: string; label: string }[]; activeId: string; onTabChange: (id: string) => void }) => (
    <div data-testid="tabs">
      {tabs.map((t) => (
        <button key={t.id} data-testid={`tab-${t.id}`} onClick={() => onTabChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  ),
}));

const SAMPLE_HEX = ":04000000DEADBEEF9E\n:00000001FF\n";

function defaultProps(overrides: Partial<Parameters<typeof SimulationPanel>[0]> = {}) {
  return {
    diagram: { parts: [], connections: [] },
    runner: null,
    status: "idle" as const,
    serialOutput: "",
    pcbText: null,
    onPcbSave: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onAddPart: vi.fn(),
    onPartMove: vi.fn(),
    onAddConnection: vi.fn(),
    onUpdateConnection: vi.fn(),
    onDeleteConnection: vi.fn(),
    onWireColorChange: vi.fn(),
    selectedPartId: null,
    onPartSelect: vi.fn(),
    onDeletePart: vi.fn(),
    onPartRotate: vi.fn(),
    onDuplicatePart: vi.fn(),
    onPartAttrChange: vi.fn(),
    placingPartId: null,
    onFinishPlacing: vi.fn(),
    showGrid: true,
    onUpdateFromDiagram: vi.fn(),
    onSaveOutline: vi.fn(),
    ...overrides,
  };
}

describe("SimulationPanel — Flash UI", () => {
  beforeEach(() => {
    mockWebFlash = {
      isSupported: false,
      isFlashing: false,
      progress: null,
      flash: vi.fn(),
    };
  });

  it("hides flash button when Web Serial is not supported", () => {
    mockWebFlash.isSupported = false;
    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.queryByText("Flash to Arduino")).not.toBeInTheDocument();
  });

  it("hides flash button when no firmware hex is available", () => {
    mockWebFlash.isSupported = true;
    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareHex: null })} />);
    expect(screen.queryByText("Flash to Arduino")).not.toBeInTheDocument();
  });

  it("hides flash button when status is idle", () => {
    mockWebFlash.isSupported = true;
    render(<SimulationPanel {...defaultProps({ status: "idle", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.queryByText("Flash to Arduino")).not.toBeInTheDocument();
  });

  it("hides flash button when status is compiling", () => {
    mockWebFlash.isSupported = true;
    render(<SimulationPanel {...defaultProps({ status: "compiling", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.queryByText("Flash to Arduino")).not.toBeInTheDocument();
  });

  it("shows flash button when compiled and Web Serial is supported", () => {
    mockWebFlash.isSupported = true;
    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.getByText("Flash to Arduino")).toBeInTheDocument();
  });

  it("shows flash button when running", () => {
    mockWebFlash.isSupported = true;
    render(<SimulationPanel {...defaultProps({ status: "running", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.getByText("Flash to Arduino")).toBeInTheDocument();
  });

  it("shows flash button when paused", () => {
    mockWebFlash.isSupported = true;
    render(<SimulationPanel {...defaultProps({ status: "paused", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.getByText("Flash to Arduino")).toBeInTheDocument();
  });

  it("calls flash with hex and board when clicked", () => {
    mockWebFlash.isSupported = true;
    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareHex: SAMPLE_HEX, board: "nano" })} />);

    fireEvent.click(screen.getByText("Flash to Arduino"));
    expect(mockWebFlash.flash).toHaveBeenCalled();
  });

  it("shows flashing percentage during flash", () => {
    mockWebFlash.isSupported = true;
    mockWebFlash.isFlashing = true;
    mockWebFlash.progress = { stage: "programming", percent: 45, message: "Programming page 3/8..." };

    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.getByText("Flashing 45%")).toBeInTheDocument();
  });

  it("disables flash button while flashing", () => {
    mockWebFlash.isSupported = true;
    mockWebFlash.isFlashing = true;
    mockWebFlash.progress = { stage: "programming", percent: 10, message: "Programming..." };

    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareHex: SAMPLE_HEX })} />);
    const button = screen.getByText("Flashing 10%");
    expect(button).toBeDisabled();
  });

  it("shows error message on flash failure", () => {
    mockWebFlash.isSupported = true;
    mockWebFlash.progress = { stage: "error", percent: 0, message: "Flash failed: Serial read timeout" };

    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.getByText("Flash failed: Serial read timeout")).toBeInTheDocument();
  });

  it("shows success message when flash is done", () => {
    mockWebFlash.isSupported = true;
    mockWebFlash.progress = { stage: "done", percent: 100, message: "Flash complete! 224 bytes written." };

    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareHex: SAMPLE_HEX })} />);
    expect(screen.getByText("Flash complete! 224 bytes written.")).toBeInTheDocument();
  });

  it("shows download button when firmware binary is available", () => {
    render(<SimulationPanel {...defaultProps({ status: "compiled", firmwareBin: "AQID", firmwareName: "blink.bin" })} />);
    expect(screen.getByText("Download blink.bin")).toBeInTheDocument();
  });
});
