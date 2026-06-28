import { execFile } from "child_process";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { SpiceCircuit } from "./spice-netlist";
import { spiceCircuitToString } from "./spice-netlist";

export interface NgspiceResult {
  success: boolean;
  stdout: string;
  stderr: string;
  data?: SimulationData;
}

export interface SimulationData {
  variables: VariableInfo[];
  values: number[][];
}

export interface VariableInfo {
  index: number;
  name: string;
  type: string;
}

export interface NgspiceOptions {
  ngspicePath?: string;
  timeoutMs?: number;
  rawOutput?: boolean;
}

function exec(
  cmd: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode:
            typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      },
    );
  });
}

function parseRawOutput(raw: string): SimulationData | undefined {
  const lines = raw.split("\n");
  const variables: VariableInfo[] = [];
  const values: number[][] = [];
  let inVariables = false;
  let inValues = false;
  let currentPoint: number[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "Variables:") {
      inVariables = true;
      inValues = false;
      continue;
    }

    if (trimmed === "Values:") {
      inVariables = false;
      inValues = true;
      continue;
    }

    if (inVariables && trimmed) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 3) {
        variables.push({
          index: parseInt(parts[0], 10),
          name: parts[1],
          type: parts[2],
        });
      }
    }

    if (inValues && trimmed) {
      const numMatch = trimmed.match(/^(\d+)\s+([-\d.eE+]+)$/);
      if (numMatch) {
        if (currentPoint.length > 0) {
          values.push(currentPoint);
        }
        currentPoint = [parseFloat(numMatch[2])];
      } else {
        const valMatch = trimmed.match(/^([-\d.eE+]+)$/);
        if (valMatch) {
          currentPoint.push(parseFloat(valMatch[1]));
        }
      }
    }
  }

  if (currentPoint.length > 0) {
    values.push(currentPoint);
  }

  if (variables.length === 0) return undefined;
  return { variables, values };
}

function parsePrintOutput(stdout: string): SimulationData | undefined {
  const lines = stdout.split("\n");
  const variables: VariableInfo[] = [];
  const values: number[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const kvMatch = trimmed.match(/^(\S+)\s*=\s*([-\d.eE+]+)\s*$/);
    if (kvMatch) {
      const varName = kvMatch[1];
      const val = parseFloat(kvMatch[2]);
      if (!variables.find((v) => v.name === varName)) {
        variables.push({
          index: variables.length,
          name: varName,
          type: "voltage",
        });
      }
      if (values.length === 0) values.push([]);
      values[0].push(val);
    }
  }

  if (variables.length === 0) return undefined;
  return { variables, values };
}

export async function runNgspice(
  circuit: SpiceCircuit,
  options?: NgspiceOptions,
): Promise<NgspiceResult> {
  const ngspice = options?.ngspicePath ?? "ngspice";
  const timeout = options?.timeoutMs ?? 30_000;

  const workDir = await mkdtemp(path.join(tmpdir(), "sparkbench-spice-"));
  const cirPath = path.join(workDir, "circuit.cir");
  const outPath = path.join(workDir, "output.raw");

  try {
    let cirContent = spiceCircuitToString(circuit);

    const hasTransient = circuit.analyses.some((a) => a.type === "tran");
    if (hasTransient) {
      const endLine = cirContent.lastIndexOf(".end");
      const controlBlock = [
        ".control",
        "run",
        `wrdata "${outPath}" all`,
        "quit",
        ".endc",
      ].join("\n");
      cirContent =
        cirContent.slice(0, endLine) + controlBlock + "\n" + cirContent.slice(endLine);
    } else {
      const endLine = cirContent.lastIndexOf(".end");
      const controlBlock = [
        ".control",
        "run",
        "print all",
        "quit",
        ".endc",
      ].join("\n");
      cirContent =
        cirContent.slice(0, endLine) + controlBlock + "\n" + cirContent.slice(endLine);
    }

    await writeFile(cirPath, cirContent, "utf-8");

    const result = await exec(ngspice, ["-b", cirPath], { timeout });

    if (result.exitCode !== 0) {
      return {
        success: false,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    let data: SimulationData | undefined;

    if (hasTransient) {
      try {
        const rawContent = await readFile(outPath, "utf-8");
        data = parseRawOutput(rawContent);
      } catch {
        data = parsePrintOutput(result.stdout);
      }
    } else {
      data = parsePrintOutput(result.stdout);
    }

    return {
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      data,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkNgspiceAvailable(
  ngspicePath?: string,
): Promise<boolean> {
  const result = await exec(ngspicePath ?? "ngspice", ["--version"]);
  return result.exitCode === 0;
}
