/**
 * Local filesystem project storage for development.
 * Used when DATABASE_URL is not set — reads/writes to the projects/ directory.
 */
import fs from "fs/promises";
import path from "path";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

export function isLocalDev(): boolean {
  return process.env.SPARKBENCH_LOCAL_DEV === "1" || !process.env.DATABASE_URL;
}

export interface LocalProjectMeta {
  id: string;
  slug: string;
  partCount: number;
  partTypes: string[];
  lineCount: number;
  hasPCB: boolean;
  hasTests: boolean;
  starCount: number;
  modifiedAt: string;
}

function projectDir(slug: string): string {
  // Prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`Invalid project slug: ${slug}`);
  }
  return path.join(PROJECTS_DIR, slug);
}

export async function listLocalProjects(params?: {
  q?: string;
  page?: number;
  limit?: number;
}): Promise<{ projects: LocalProjectMeta[]; total: number; page: number; pages: number }> {
  const page = params?.page ?? 1;
  const limit = params?.limit ?? 25;
  const q = params?.q?.toLowerCase() ?? "";

  let entries: string[];
  try {
    entries = await fs.readdir(PROJECTS_DIR);
  } catch {
    return { projects: [], total: 0, page: 1, pages: 0 };
  }

  // Filter to directories only, apply search
  const slugs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const stat = await fs.stat(path.join(PROJECTS_DIR, entry)).catch(() => null);
    if (!stat?.isDirectory()) continue;
    if (q && !entry.toLowerCase().includes(q)) continue;
    slugs.push(entry);
  }

  slugs.sort();

  // Build metadata for each project
  const allMetas: LocalProjectMeta[] = [];
  for (const slug of slugs) {
    const dir = projectDir(slug);
    const meta = await buildLocalMeta(slug, dir);
    allMetas.push(meta);
  }

  // Sort by modified date descending
  allMetas.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  const total = allMetas.length;
  const pages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const paginated = allMetas.slice(offset, offset + limit);

  return { projects: paginated, total, page, pages };
}

async function buildLocalMeta(slug: string, dir: string): Promise<LocalProjectMeta> {
  let partCount = 0;
  let partTypes: string[] = [];
  let modifiedAt = new Date().toISOString();

  // Read diagram.json for part info
  try {
    const diagramStr = await fs.readFile(path.join(dir, "diagram.json"), "utf-8");
    const diagram = JSON.parse(diagramStr);
    if (diagram?.parts) {
      partCount = diagram.parts.length;
      const typeSet = new Set<string>();
      for (const p of diagram.parts) {
        const t = (p.type || "")
          .replace(/^wokwi-/, "")
          .replace(/^board-/, "")
          .replace(/^sb-/, "");
        if (t && t !== "arduino-uno" && t !== "arduino-nano" && t !== "arduino-mega") {
          typeSet.add(t);
        }
      }
      partTypes = Array.from(typeSet).slice(0, 6);
    }
  } catch { /* no diagram */ }

  // Check for optional files
  const hasPCB = await fileExists(path.join(dir, "board.kicad_pcb"));
  const hasTests = await fileExists(path.join(dir, "test.scenario.yaml"));

  // Use directory mtime
  try {
    const stat = await fs.stat(dir);
    modifiedAt = stat.mtime.toISOString();
  } catch { /* use default */ }

  return {
    id: slug, // In local dev, slug = id
    slug,
    partCount,
    partTypes,
    lineCount: 0,
    hasPCB,
    hasTests,
    starCount: 0,
    modifiedAt,
  };
}

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}

export async function readLocalFile(slug: string, filename: string): Promise<string | null> {
  // Prevent path traversal in filename
  const normalized = path.normalize(filename);
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid filename: ${filename}`);
  }
  try {
    return await fs.readFile(path.join(projectDir(slug), normalized), "utf-8");
  } catch {
    return null;
  }
}

export async function writeLocalFile(slug: string, filename: string, content: string): Promise<void> {
  const normalized = path.normalize(filename);
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid filename: ${filename}`);
  }
  const dir = projectDir(slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, normalized), content, "utf-8");
}

export async function listLocalProjectFiles(slug: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(projectDir(slug));
    return entries.filter((e) => !e.startsWith("."));
  } catch {
    return [];
  }
}

export async function deleteLocalFile(slug: string, filename: string): Promise<void> {
  const normalized = path.normalize(filename);
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid filename: ${filename}`);
  }
  try {
    await fs.unlink(path.join(projectDir(slug), normalized));
  } catch { /* ignore if not found */ }
}

export async function localProjectExists(slug: string): Promise<boolean> {
  return fileExists(projectDir(slug));
}

export async function readLocalDiagram(slug: string): Promise<{ diagram: unknown; lastModified: string } | null> {
  const content = await readLocalFile(slug, "diagram.json");
  if (content === null) return null;
  let mtime = new Date().toISOString();
  try {
    const stat = await fs.stat(path.join(projectDir(slug), "diagram.json"));
    mtime = stat.mtime.toISOString();
  } catch { /* use default */ }
  return { diagram: JSON.parse(content), lastModified: mtime };
}

export async function createLocalProject(name: string): Promise<{ id: string; slug: string }> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error("Invalid project name");

  const dir = projectDir(slug);
  if (await fileExists(dir)) {
    throw new Error("A project with this name already exists");
  }

  await fs.mkdir(dir, { recursive: true });

  const defaultSketch = `void setup() {\n  // put your setup code here\n}\n\nvoid loop() {\n  // put your main code here\n}\n`;
  const defaultDiagram = {
    version: 1,
    author: "",
    editor: "sparkbench",
    parts: [{ type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0, attrs: {} }],
    connections: [],
  };

  await fs.writeFile(path.join(dir, "sketch.ino"), defaultSketch, "utf-8");
  await fs.writeFile(path.join(dir, "diagram.json"), JSON.stringify(defaultDiagram, null, 2), "utf-8");

  return { id: slug, slug };
}
