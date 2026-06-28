"use client";

/**
 * Phase 1 spike — In-browser AVR compilation test.
 *
 * Drives a real clang.wasm entirely in the browser via @wasmer/sdk to answer one
 * question for the roadmap: can we compile AVR firmware client-side today?
 *
 * Empirical result this page demonstrates:
 *   - Running clang in the browser WORKS end-to-end (cross-origin isolation +
 *     @wasmer/sdk + ~100 MB clang.wasm; compiles C to wasm32 fine).            ✅
 *   - The only off-the-shelf clang.wasm (Wasmer `clang/clang`) is built with
 *     LLVM_TARGETS_TO_BUILD=WebAssembly only — registered targets are wasm32/
 *     wasm64, so the AVR backend is NOT present and --target=avr cannot work.  ⛔
 *   - GO is feasible but gated on building our own AVR-enabled clang.wasm.
 *
 * So the page: loads clang, probes its registered targets, runs the AVR stages
 * if (and only if) the AVR backend is present, and otherwise runs a C→wasm
 * "positive control" to prove the in-browser toolchain itself works — isolating
 * the gap precisely to the missing AVR backend in the artifact.
 *
 * See docs/roadmap-in-browser-compile.md and docs/phase1-avr-wasm-spike.md.
 */

import { useCallback, useRef, useState } from "react";

const WASMER_SDK_URL = "https://unpkg.com/@wasmer/sdk@0.10.0/dist/index.mjs";

const DEFAULT_SOURCE = `#include <stdint.h>

// ATmega328P registers (Arduino Uno). PB5 == Arduino digital pin 13 (onboard LED).
#define DDRB  (*(volatile uint8_t *)0x24)
#define PORTB (*(volatile uint8_t *)0x25)

static void delay(void) {
  for (volatile uint32_t i = 0; i < 50000UL; i++) { }
}

int main(void) {
  DDRB |= (1 << 5);      // PB5 as output
  for (;;) {
    PORTB ^= (1 << 5);   // toggle the LED
    delay();
  }
  return 0;
}
`;

type StageStatus = "pending" | "running" | "pass" | "fail" | "blocked";

interface Stage {
  id: string;
  label: string;
  status: StageStatus;
  detail: string;
}

const INITIAL_STAGES: Stage[] = [
  { id: "load", label: "Load clang.wasm (@wasmer/sdk, ~100 MB first run)", status: "pending", detail: "" },
  { id: "targets", label: "Probe clang -print-targets (is AVR backend present?)", status: "pending", detail: "" },
  { id: "avr", label: "clang --target=avr -mmcu=atmega328p -c  (C → AVR object)", status: "pending", detail: "" },
  { id: "control", label: "Positive control: clang C → wasm32 (toolchain works?)", status: "pending", detail: "" },
];

// Minimal structural types for the @wasmer/sdk surface we use.
interface WasmerOutput {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}
interface WasmerInstance {
  wait(): Promise<WasmerOutput>;
}
interface WasmerCommand {
  run(opts: { args: string[]; mount: Record<string, unknown> }): Promise<WasmerInstance>;
}
interface WasmerPackage {
  entrypoint: WasmerCommand;
}
interface WasmerDirectory {
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
}
interface WasmerSdk {
  init: () => Promise<unknown>;
  Wasmer: { fromRegistry: (pkg: string) => Promise<WasmerPackage> };
  Directory: new () => WasmerDirectory;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function AvrWasmTestPage() {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [stages, setStages] = useState<Stage[]>(INITIAL_STAGES);
  const [log, setLog] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [isolated] = useState<boolean>(
    typeof window !== "undefined" &&
      (window as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
  );
  const startedAt = useRef<number>(0);

  const append = useCallback((line: string) => setLog((prev) => prev + line + "\n"), []);
  const setStage = useCallback((id: string, status: StageStatus, detail = "") => {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, status, detail } : s)));
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setStages(INITIAL_STAGES.map((s) => ({ ...s })));
    setLog("");
    startedAt.current = performance.now();

    try {
      // ---- Stage 0: load the SDK + clang package -------------------------------
      setStage("load", "running");
      append("Importing @wasmer/sdk from CDN…");
      const dynamicImport = new Function("u", "return import(u)") as (u: string) => Promise<unknown>;
      const sdk = (await dynamicImport(WASMER_SDK_URL)) as WasmerSdk;
      await sdk.init();
      append("Fetching clang/clang from the Wasmer registry (cached after first run)…");
      const clang = await sdk.Wasmer.fromRegistry("clang/clang");
      const dir = new sdk.Directory();
      await dir.writeFile("blink.c", source);
      setStage("load", "pass", `ready in ${((performance.now() - startedAt.current) / 1000).toFixed(1)}s`);

      const runClang = async (args: string[]): Promise<WasmerOutput> => {
        append("\n$ clang " + args.join(" "));
        const instance = await clang.entrypoint.run({ args, mount: { "/project": dir } });
        const out = await instance.wait();
        if (out.stdout.trim()) append(out.stdout.trim());
        if (out.stderr.trim()) append(out.stderr.trim());
        append(`exit ${out.code}`);
        return out;
      };

      // ---- Stage 1: probe registered targets -----------------------------------
      setStage("targets", "running");
      const ver = await runClang(["--version"]);
      const tgt = await runClang(["-print-targets"]);
      const hasAvr = /(^|\s)avr\b/i.test(tgt.stdout);
      const triple = (ver.stdout.match(/Target:\s*(\S+)/)?.[1]) ?? "unknown";
      setStage("targets", hasAvr ? "pass" : "fail", `${triple}; AVR backend ${hasAvr ? "present" : "ABSENT"}`);
      append(`\nclang triple: ${triple} — AVR backend ${hasAvr ? "present ✅" : "absent ⛔"}`);

      // ---- Stage 2: AVR object (only if the backend exists) ---------------------
      if (hasAvr) {
        setStage("avr", "running");
        const oOut = await runClang([
          "--target=avr", "-mmcu=atmega328p", "-Os", "-c",
          "/project/blink.c", "-o", "/project/blink.o",
        ]);
        if (oOut.ok) {
          const obj = await dir.readFile("blink.o");
          const isElf = obj[0] === 0x7f && obj[1] === 0x45 && obj[2] === 0x4c && obj[3] === 0x46;
          setStage("avr", "pass", `${obj.length} byte ${isElf ? "AVR ELF object" : "object"} — codegen works in-browser!`);
        } else {
          setStage("avr", "fail", `exit ${oOut.code} — see log`);
        }
      } else {
        setStage("avr", "blocked", "needs a custom AVR-enabled clang.wasm (this build is wasm-only)");
        append("\n⛔ This clang.wasm has no AVR backend, so --target=avr is impossible with it.");
        append("   Building our own clang.wasm with LLVM_TARGETS_TO_BUILD including AVR is the Phase 1 work.");
      }

      // ---- Stage 3: positive control — prove the in-browser toolchain runs ------
      // Use clang's known-working full compile+link path to wasm (the driver's
      // self-exec for a standalone `-c` step fails under WASIX, which is unrelated
      // to the AVR question).
      setStage("control", "running");
      append("\nPositive control: compile+link C to a wasm module to prove the in-browser toolchain works…");
      await dir.writeFile("control.c", '#include <stdio.h>\nint main(void){printf("ok");return 0;}\n');
      const cOut = await runClang(["/project/control.c", "-o", "/project/control.wasm"]);
      if (cOut.ok) {
        const w = await dir.readFile("control.wasm");
        const isWasm = w[0] === 0x00 && w[1] === 0x61 && w[2] === 0x73 && w[3] === 0x6d;
        setStage("control", isWasm ? "pass" : "fail", `${w.length} byte ${isWasm ? "wasm module" : "output"} — clang runs end-to-end in the browser ✅`);
      } else {
        setStage("control", "fail", `exit ${cOut.code}`);
      }

      append("\n— Spike complete. See the stage list above for the go/no-go signal. —");
    } catch (error: unknown) {
      append("\nERROR: " + getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [source, append, setStage]);

  const icon = (s: StageStatus) =>
    s === "pass" ? "✅" : s === "fail" ? "⛔" : s === "blocked" ? "🚧" : s === "running" ? "⏳" : "•";

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>In-Browser AVR Compile — Phase 1 Spike</h1>
      <p style={{ color: "#555", marginTop: 4 }}>
        Runs a real <code>clang</code> entirely in your browser via <code>@wasmer/sdk</code> and
        tests whether it can target AVR. Probes the toolchain&apos;s registered targets, runs the AVR
        stages if the backend is present, and runs a C→wasm positive control either way.
      </p>

      <div style={{ margin: "8px 0", fontSize: 13 }}>
        cross-origin isolated:{" "}
        <strong style={{ color: isolated ? "#15803d" : "#b91c1c" }}>{String(isolated)}</strong>
        {!isolated && " — threaded clang.wasm may not start (check COOP/COEP headers)."}
      </div>

      <textarea
        value={source}
        onChange={(e) => setSource(e.target.value)}
        spellCheck={false}
        style={{ width: "100%", height: 220, fontFamily: "ui-monospace, monospace", fontSize: 13, padding: 12, border: "1px solid #ccc", borderRadius: 8 }}
      />

      <button
        onClick={run}
        disabled={busy}
        style={{ marginTop: 12, padding: "10px 18px", fontSize: 14, fontWeight: 600, borderRadius: 8, border: 0, background: busy ? "#9ca3af" : "#2563eb", color: "white", cursor: busy ? "default" : "pointer" }}
      >
        {busy ? "Running in browser…" : "Run AVR compile spike"}
      </button>

      <ol style={{ marginTop: 16, paddingLeft: 0, listStyle: "none" }}>
        {stages.map((s) => (
          <li key={s.id} style={{ padding: "8px 12px", border: "1px solid #eee", borderRadius: 8, marginBottom: 6, display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ width: 18 }}>{icon(s.status)}</span>
            <span style={{ flex: 1, fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{s.label}</span>
            <span style={{ color: "#666", fontSize: 12 }}>{s.detail}</span>
          </li>
        ))}
      </ol>

      <h2 style={{ fontSize: 15, fontWeight: 600, marginTop: 16 }}>Toolchain log</h2>
      <pre style={{ background: "#111", color: "#9eff9e", padding: 12, borderRadius: 8, overflow: "auto", maxHeight: 360, fontSize: 12, whiteSpace: "pre-wrap" }}>{log || "(run the spike to see output)"}</pre>
    </main>
  );
}
