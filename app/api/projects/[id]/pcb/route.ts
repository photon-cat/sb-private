import { NextResponse } from "next/server";
import { isLocalDev, readLocalFile, writeLocalFile, localProjectExists } from "@/lib/local-projects";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
    }

    if (isLocalDev()) {
      const content = await readLocalFile(id, "board.kicad_pcb");
      if (content === null) return new NextResponse(null, { status: 404 });
      return new NextResponse(content, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const { downloadFile } = await import("@/lib/storage");
    const { authorizeProjectRead } = await import("@/lib/auth-middleware");

    const readResult = await authorizeProjectRead(id);
    if (readResult.error) return readResult.error;

    const project = readResult.project;
    const content = await downloadFile(project.id, "board.kicad_pcb");

    if (content === null) {
      return new NextResponse(null, { status: 404 });
    }

    return new NextResponse(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Last-Modified": project.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to read PCB: ${message}` }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
    }

    const body = await request.text();

    if (isLocalDev()) {
      if (!(await localProjectExists(id))) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      await writeLocalFile(id, "board.kicad_pcb", body);
      return NextResponse.json({ success: true });
    }

    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { projects } = await import("@/lib/db/schema");
    const { uploadFile } = await import("@/lib/storage");
    const { authorizeProjectWrite } = await import("@/lib/auth-middleware");

    const writeResult = await authorizeProjectWrite(id);
    if (writeResult.error) return writeResult.error;

    const project = writeResult.project;

    await uploadFile(project.id, "board.kicad_pcb", body);

    const manifest = new Set((project.fileManifest as string[]) || []);
    manifest.add("board.kicad_pcb");
    await db
      .update(projects)
      .set({ fileManifest: Array.from(manifest), updatedAt: new Date() })
      .where(eq(projects.id, project.id));

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to save PCB: ${message}` }, { status: 500 });
  }
}
