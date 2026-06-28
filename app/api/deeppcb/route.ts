import { NextResponse } from "next/server";
import { DeepPCBClient } from "@/lib/deeppcb-client";
import { isLocalDev, readLocalFile, writeLocalFile } from "@/lib/local-projects";
import { validateKiCadPcbForAutoroute } from "@/lib/pcb-pipeline";

// Allow long-running routing jobs (up to 2 hours)
export const maxDuration = 7200;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let projectId: string;
  try {
    const body = await request.json();
    projectId = body.projectId;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
  }

  let storageProjectId = projectId;
  let fileManifest: string[] = [];
  let pcbContent: string | null;

  if (isLocalDev()) {
    pcbContent = await readLocalFile(projectId, "board.kicad_pcb");
  } else {
    const { authorizeProjectWrite, getServerSession } = await import("@/lib/auth-middleware");
    const { downloadFile } = await import("@/lib/storage");

    const session = await getServerSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }

    const writeResult = await authorizeProjectWrite(projectId);
    if (writeResult.error) return writeResult.error;
    storageProjectId = writeResult.project.id;
    fileManifest = (writeResult.project.fileManifest as string[]) || [];
    pcbContent = await downloadFile(storageProjectId, "board.kicad_pcb");
  }

  const apiKey = process.env.DEEPPCB_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "PCB routing is not configured." },
      { status: 500 },
    );
  }

  if (!pcbContent) {
    return NextResponse.json(
      { error: "No board.kicad_pcb found for this project. Generate a PCB layout first." },
      { status: 404 },
    );
  }

  const validationIssues = validateKiCadPcbForAutoroute(pcbContent);
  if (validationIssues.length > 0) {
    return NextResponse.json(
      { error: "Board is not ready for autorouting.", issues: validationIssues },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const write = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      try {
        const client = new DeepPCBClient(apiKey);

        const routedPcb = await client.autoroute(pcbContent, (progress) => {
          write({
            type: "progress",
            step: progress.step,
            message: progress.message,
            percent: progress.percent,
          });
        });

        const resultIssues = validateKiCadPcbForAutoroute(routedPcb);
        if (resultIssues.length > 0) {
          throw new Error(`DeepPCB returned an invalid board: ${resultIssues.join(" ")}`);
        }

        if (isLocalDev()) {
          await writeLocalFile(storageProjectId, "board.kicad_pcb", routedPcb);
        } else {
          const { eq } = await import("drizzle-orm");
          const { db } = await import("@/lib/db");
          const { projects } = await import("@/lib/db/schema");
          const { uploadFile } = await import("@/lib/storage");
          await uploadFile(storageProjectId, "board.kicad_pcb", routedPcb);
          const manifest = new Set(fileManifest);
          manifest.add("board.kicad_pcb");
          await db
            .update(projects)
            .set({ fileManifest: Array.from(manifest), updatedAt: new Date() })
            .where(eq(projects.id, storageProjectId));
        }

        write({ type: "done", message: "Routing complete! Board updated." });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        write({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
