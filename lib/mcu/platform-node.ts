// Node-only platform helpers. Kept out of platform.ts so that browser bundles
// (which import platform.ts for the model registries) never see a `require("fs")`
// — webpack/Turbopack would try to resolve the Node builtin and fail.

import { readFileSync } from "fs";
import { buildPlatform, type Platform, type BuildPlatformOptions } from "./platform";

/** Convenience: build a platform from an SVD file path (Node only). */
export function buildPlatformFromFile(path: string, opts?: BuildPlatformOptions): Platform {
  const xml = readFileSync(path, "utf-8");
  return buildPlatform(xml, opts);
}
