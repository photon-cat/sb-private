import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { writeFile, readFile, mkdir, rm } from "fs/promises";
import path from "path";
import os from "os";
import { nanoid } from "nanoid";
import { isLocalDev, localProjectExists } from "@/lib/local-projects";

const WOKWI_CLI = process.env.WOKWI_CLI_PATH || findLocalWokwiCli();

function findLocalWokwiCli(): string {
  // Check common install locations (synchronous since this runs at module load)
  const fs = require("fs");
  const candidates = [
    path.join(os.homedir(), "bin/wokwi-cli"),
    path.join(os.homedir(), ".wokwi/bin/wokwi-cli"),
    "/opt/homebrew/bin/wokwi-cli",
    "/usr/local/bin/wokwi-cli",
  ];
  for (const p of candidates) {
    try { fs.accessSync(p); return p; } catch { /* next */ }
  }
  return "wokwi-cli";
}
const VALID_CHIP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid project ID" },
        { status: 400 },
      );
    }

    if (isLocalDev()) {
      if (!(await localProjectExists(id))) {
        return NextResponse.json(
          { success: false, error: "Project not found" },
          { status: 404 },
        );
      }
    } else {
      const { getServerSession, authorizeProjectRead } = await import("@/lib/auth-middleware");
      const session = await getServerSession();
      if (!session?.user) {
        return NextResponse.json(
          { success: false, error: "Sign in to compile chips" },
          { status: 401 },
        );
      }
      const readResult = await authorizeProjectRead(id);
      if (readResult.error) return readResult.error;
    }

    const data = await request.json();
    const chipName: string = data.chipName || "";
    const source: string = data.source || "";

    if (!chipName || !VALID_CHIP_NAME.test(chipName)) {
      return NextResponse.json(
        { success: false, error: "Invalid chip name" },
        { status: 400 },
      );
    }
    if (!source.trim()) {
      return NextResponse.json(
        { success: false, error: "No source code provided" },
        { status: 400 },
      );
    }

    const BUILD_DIR = path.join(os.tmpdir(), `sparkbench-chip-${nanoid(8)}`);
    await mkdir(BUILD_DIR, { recursive: true });

    try {
      const srcFile = `${chipName}.c`;
      const outFile = `${chipName}.wasm`;
      await writeFile(path.join(BUILD_DIR, srcFile), source);

      // Write extra source files if provided (headers, etc.)
      const files: { name: string; content: string }[] = data.files || [];
      for (const f of files) {
        if (!f.name || !f.content) continue;
        const safeName = path.basename(f.name);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(safeName)) continue;
        await writeFile(path.join(BUILD_DIR, safeName), f.content);
      }

      const result = await new Promise<{
        code: number;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        execFile(
          WOKWI_CLI,
          ["chip", "compile", srcFile, "-o", outFile],
          { cwd: BUILD_DIR, timeout: 30_000 },
          (error, stdout, stderr) => {
            resolve({
              code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
              stdout: stdout || "",
              stderr: stderr || "",
            });
          },
        );
      });

      if (result.code !== 0) {
        return NextResponse.json({
          success: false,
          error: result.stderr || result.stdout || "Chip compilation failed",
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }

      const wasmBuffer = await readFile(path.join(BUILD_DIR, outFile));
      const wasmBase64 = wasmBuffer.toString("base64");

      return NextResponse.json({
        success: true,
        wasm: wasmBase64,
        size: wasmBuffer.length,
      });
    } finally {
      rm(BUILD_DIR, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    console.error("Chip compile error:", err);
    return NextResponse.json(
      { success: false, error: "Internal chip compilation error" },
      { status: 500 },
    );
  }
}
