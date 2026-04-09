import { NextResponse } from "next/server";
import { isLocalDev, readLocalDiagram, writeLocalFile, localProjectExists } from "@/lib/local-projects";

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
      const data = await readLocalDiagram(id);
      if (!data) return NextResponse.json({ error: "Project not found" }, { status: 404 });
      return NextResponse.json(data);
    }

    const { authorizeProjectRead } = await import("@/lib/auth-middleware");
    const result = await authorizeProjectRead(id);
    if (result.error) return result.error;

    const project = result.project;
    return NextResponse.json({
      diagram: project.diagramJson,
      lastModified: project.updatedAt.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to read diagram: ${message}` }, { status: 500 });
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

    const body = await request.json();

    if (isLocalDev()) {
      if (!(await localProjectExists(id))) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      await writeLocalFile(id, "diagram.json", JSON.stringify(body, null, 2));
      return NextResponse.json({ success: true });
    }

    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { projects } = await import("@/lib/db/schema");
    const { uploadFile } = await import("@/lib/storage");
    const { authorizeProjectWrite } = await import("@/lib/auth-middleware");

    const result = await authorizeProjectWrite(id);
    if (result.error) return result.error;

    await db
      .update(projects)
      .set({ diagramJson: body, updatedAt: new Date() })
      .where(eq(projects.id, id));

    await uploadFile(id, "diagram.json", JSON.stringify(body, null, 2));

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to save diagram: ${message}` }, { status: 500 });
  }
}
