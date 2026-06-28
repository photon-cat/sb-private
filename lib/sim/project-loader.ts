import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { parseDiagram, findMCUs, type Diagram, type MCUInfo } from "../diagram-parser";

export interface ProjectFiles {
  root: string;
  slug: string;
  diagram: Diagram;
  sketch: string;
  librariesTxt: string;
  files: { name: string; content: string }[];
  mcus: MCUInfo[];
  target: MCUInfo | null;
}

export interface LoadOptions {
  projectDir?: string;
  diagramPath?: string;
  sketchPath?: string;
}

export function loadProject(slugOrOpts: string | LoadOptions, projectsRoot?: string): ProjectFiles {
  let root: string;
  let slug: string;
  let diagramPath: string;
  let sketchPath: string;

  if (typeof slugOrOpts === "string") {
    slug = slugOrOpts;
    root = projectsRoot
      ? path.join(projectsRoot, slug)
      : path.join(process.cwd(), "projects", slug);
    diagramPath = path.join(root, "diagram.json");
    sketchPath = path.join(root, "sketch.ino");
  } else {
    root = slugOrOpts.projectDir ?? process.cwd();
    slug = path.basename(root);
    diagramPath = slugOrOpts.diagramPath ?? path.join(root, "diagram.json");
    sketchPath = slugOrOpts.sketchPath ?? path.join(root, "sketch.ino");
  }

  if (!existsSync(root)) {
    throw new Error(`Project directory not found: ${root}`);
  }

  if (!existsSync(diagramPath)) {
    throw new Error(`Diagram not found: ${diagramPath}`);
  }

  if (!existsSync(sketchPath)) {
    throw new Error(`Sketch not found: ${sketchPath}`);
  }

  const diagramJson = JSON.parse(readFileSync(diagramPath, "utf-8"));
  const diagram = parseDiagram(diagramJson);

  let sketch = readFileSync(sketchPath, "utf-8");
  if (!sketch.includes("#include <Arduino.h>") && !sketch.includes('#include "Arduino.h"')) {
    sketch = "#include <Arduino.h>\n" + sketch;
  }

  let librariesTxt = "";
  const libsPath = path.join(root, "libraries.txt");
  if (existsSync(libsPath)) {
    librariesTxt = readFileSync(libsPath, "utf-8");
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch { /* empty */ }

  const files = entries
    .filter((n) => !n.startsWith(".") && n !== "diagram.json" && n !== "sketch.ino")
    .map((n) => {
      try {
        return { name: n, content: readFileSync(path.join(root, n), "utf-8") };
      } catch {
        return null;
      }
    })
    .filter((f): f is { name: string; content: string } => f !== null);

  const mcus = findMCUs(diagram);
  const target = mcus.find((m) => m.simulatable) ?? null;

  return { root, slug, diagram, sketch, librariesTxt, files, mcus, target };
}
