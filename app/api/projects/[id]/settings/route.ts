import { NextResponse } from "next/server";
import { isLocalDev, localProjectExists } from "@/lib/local-projects";

/**
 * GET /api/projects/:id/settings — project metadata (isPublic, isOwner, title)
 */
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
      return NextResponse.json({
        id,
        slug: id,
        title: id,
        isPublic: true,
        isOwner: true,
        ownerUsername: "local",
      });
    }

    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { projects, users } = await import("@/lib/db/schema");
    const { getServerSession, isProjectOwner } = await import("@/lib/auth-middleware");

    const rows = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        title: projects.title,
        isPublic: projects.isPublic,
        ownerId: projects.ownerId,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const project = rows[0];

    let userId: string | null = null;
    try {
      const session = await getServerSession();
      if (session?.user) userId = session.user.id;
    } catch { /* unauthenticated */ }

    const isOwner = !!userId && await isProjectOwner(id, userId);

    if (!project.isPublic && !isOwner) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    let ownerUsername: string | null = null;
    if (project.ownerId) {
      const ownerRows = await db
        .select({ username: users.username, name: users.name })
        .from(users)
        .where(eq(users.id, project.ownerId))
        .limit(1);
      if (ownerRows.length > 0) {
        ownerUsername = ownerRows[0].username || ownerRows[0].name;
      }
    }

    return NextResponse.json({
      id: project.id,
      slug: project.slug,
      title: project.title,
      isPublic: project.isPublic,
      isOwner,
      ownerUsername,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH /api/projects/:id/settings — update project settings (visibility, title)
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
    }

    if (isLocalDev()) {
      // No-op in local dev — no DB to update
      return NextResponse.json({ success: true });
    }

    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { projects } = await import("@/lib/db/schema");
    const { authorizeProjectWrite } = await import("@/lib/auth-middleware");
    const { logActivity } = await import("@/lib/logger");

    const result = await authorizeProjectWrite(id);
    if (result.error) return result.error;

    const body = await request.json();
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (typeof body.isPublic === "boolean") {
      updates.isPublic = body.isPublic;
    }
    if (typeof body.title === "string" && body.title.trim()) {
      updates.title = body.title.trim();
      const newSlug = body.title.trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      if (newSlug) {
        updates.slug = newSlug;
      }
    }

    await db.update(projects).set(updates).where(eq(projects.id, id));

    logActivity("project.update", {
      userId: result.project.ownerId,
      projectId: id,
      metadata: { fields: Object.keys(updates).filter(k => k !== "updatedAt") },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/projects/:id/settings — delete project (owner only)
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
    }

    if (isLocalDev()) {
      // Don't allow deleting local projects via API for safety
      return NextResponse.json({ error: "Delete not supported in local dev" }, { status: 403 });
    }

    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { projects } = await import("@/lib/db/schema");
    const { authorizeProjectWrite } = await import("@/lib/auth-middleware");
    const { listProjectFiles, deleteFile } = await import("@/lib/storage");
    const { logger, logActivity } = await import("@/lib/logger");
    const { destroyProjectSandbox } = await import("@/lib/sandbox");

    const result = await authorizeProjectWrite(id);
    if (result.error) return result.error;

    destroyProjectSandbox(id).catch(() => {});

    try {
      const files = await listProjectFiles(id);
      for (const file of files) {
        await deleteFile(id, file);
      }
    } catch (err) {
      logger.error("[delete-project] Failed to delete files", { projectId: id, error: String(err) });
    }

    logActivity("project.delete", {
      userId: result.project.ownerId,
      projectId: id,
    });

    await db.delete(projects).where(eq(projects.id, id));

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
