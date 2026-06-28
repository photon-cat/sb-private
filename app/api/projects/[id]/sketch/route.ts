import { NextResponse } from "next/server";
import { isLocalDev, readLocalFile, writeLocalFile, listLocalProjectFiles, deleteLocalFile, localProjectExists } from "@/lib/local-projects";

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
      if (!(await localProjectExists(id))) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      const sketch = (await readLocalFile(id, "sketch.ino")) || "";
      const allFiles = await listLocalProjectFiles(id);
      const files: { name: string; content: string }[] = [];
      for (const name of allFiles) {
        if (name !== "sketch.ino" && (name.endsWith(".h") || name.endsWith(".cpp") || name.endsWith(".c") || name.endsWith(".chip.json") || name.endsWith(".chip.svg"))) {
          const content = await readLocalFile(id, name);
          if (content !== null) files.push({ name, content });
        }
      }
      return NextResponse.json({ sketch, files });
    }

    const { downloadFile, listProjectFiles } = await import("@/lib/storage");
    const { authorizeProjectRead } = await import("@/lib/auth-middleware");

    const readResult = await authorizeProjectRead(id);
    if (readResult.error) return readResult.error;

    const sketch = (await downloadFile(id, "sketch.ino")) || "";

    const allFiles = await listProjectFiles(id);
    const files: { name: string; content: string }[] = [];
    for (const name of allFiles) {
      if (name !== "sketch.ino" && (name.endsWith(".h") || name.endsWith(".cpp") || name.endsWith(".c") || name.endsWith(".chip.json") || name.endsWith(".chip.svg"))) {
        const content = await downloadFile(id, name);
        if (content !== null) files.push({ name, content });
      }
    }

    return NextResponse.json({ sketch, files });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to read sketch: ${message}` }, { status: 500 });
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

    const { sketch, files } = await request.json();

    if (isLocalDev()) {
      if (!(await localProjectExists(id))) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      await writeLocalFile(id, "sketch.ino", sketch);
      if (Array.isArray(files)) {
        const existing = await listLocalProjectFiles(id);
        const existingExtra = new Set(existing.filter((e) => e.endsWith(".h") || e.endsWith(".cpp") || e.endsWith(".c") || e.endsWith(".chip.json") || e.endsWith(".chip.svg")));
        const newNames = new Set(files.map((f: { name: string }) => f.name));
        for (const old of existingExtra) {
          if (!newNames.has(old)) await deleteLocalFile(id, old);
        }
        for (const f of files as { name: string; content: string }[]) {
          if (/^[a-zA-Z0-9_.-]+$/.test(f.name)) await writeLocalFile(id, f.name, f.content);
        }
      }
      return NextResponse.json({ success: true });
    }

    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { projects } = await import("@/lib/db/schema");
    const { uploadFile, deleteFile, listProjectFiles } = await import("@/lib/storage");
    const { authorizeProjectWrite } = await import("@/lib/auth-middleware");

    const writeResult = await authorizeProjectWrite(id);
    if (writeResult.error) return writeResult.error;

    const project = writeResult.project;

    await uploadFile(id, "sketch.ino", sketch);

    if (Array.isArray(files)) {
      const allFiles = await listProjectFiles(id);
      const existingExtra = new Set(allFiles.filter((e) => e.endsWith(".h") || e.endsWith(".cpp") || e.endsWith(".c") || e.endsWith(".chip.json") || e.endsWith(".chip.svg")));
      const newFileNames = new Set(files.map((f: { name: string }) => f.name));

      for (const old of existingExtra) {
        if (!newFileNames.has(old)) await deleteFile(id, old);
      }

      for (const f of files as { name: string; content: string }[]) {
        if (/^[a-zA-Z0-9_.-]+$/.test(f.name)) await uploadFile(id, f.name, f.content);
      }

      const manifestSet = new Set((project.fileManifest as string[]) || []);
      manifestSet.add("sketch.ino");
      for (const old of existingExtra) { if (!newFileNames.has(old)) manifestSet.delete(old); }
      for (const f of files as { name: string }[]) { if (/^[a-zA-Z0-9_.-]+$/.test(f.name)) manifestSet.add(f.name); }

      await db.update(projects).set({ fileManifest: Array.from(manifestSet), updatedAt: new Date() }).where(eq(projects.id, id));
    } else {
      await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to save sketch: ${message}` }, { status: 500 });
  }
}
