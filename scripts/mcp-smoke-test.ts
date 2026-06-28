#!/usr/bin/env npx tsx
/**
 * Smoke test for the SparkBench stdio MCP server.
 *
 * Spawns scripts/sparkbench-mcp.ts as a child process, connects an MCP client
 * over stdio, and asserts the tool/resource/prompt surface is reachable. By
 * default it stays lightweight (no firmware compile). Pass --full to also run
 * the heavy flow: start_simulation → run_ms → read_serial → take_screenshot
 * (requires the PlatformIO toolchain for the project's board).
 *
 *   npx tsx scripts/mcp-smoke-test.ts [project-slug-or-dir] [--full]
 */

import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(__dirname, "..");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

async function main(): Promise<void> {
  const rest = process.argv.slice(2);
  const full = rest.includes("--full");
  const slug = rest.find((a) => !a.startsWith("--")) ?? "rp2040-i2c";
  const projectDir = path.isAbsolute(slug) || slug.includes(path.sep)
    ? path.resolve(slug)
    : path.join(ROOT, "projects", slug);

  console.log(`[smoke] project: ${projectDir}  full=${full}`);

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", path.join(ROOT, "scripts", "sparkbench-mcp.ts"), projectDir],
    cwd: ROOT,
    stderr: "inherit",
  });
  const client = new Client({ name: "sparkbench-smoke", version: "1.0.0" });
  await client.connect(transport);
  console.log("[smoke] connected");

  // Tools
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log(`[smoke] tools (${tools.length}): ${tools.join(", ")}`);
  for (const required of [
    "sparkbench_list_projects",
    "sparkbench_start_simulation",
    "sparkbench_run_ms",
    "sparkbench_read_serial",
    "sparkbench_read_pin",
    "sparkbench_set_control",
    "sparkbench_read_display_buffer",
    "sparkbench_take_screenshot",
  ]) {
    assert(tools.includes(required), `tool ${required} missing`);
  }

  // Resources
  const resources = (await client.listResources()).resources.map((r) => r.uri);
  console.log(`[smoke] resources: ${resources.join(", ")}`);
  assert(resources.includes("sparkbench://project/sketch.ino"), "sketch resource missing");
  const sketch = await client.readResource({ uri: "sparkbench://project/sketch.ino" });
  assert((sketch.contents[0]?.text ?? "").length > 0, "sketch resource empty");

  // Prompt
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert(prompts.includes("sparkbench_explore"), "explore prompt missing");

  // Idle status (no compile)
  const status = await client.callTool({ name: "sparkbench_get_status", arguments: {} });
  console.log(`[smoke] status: ${textOf(status as never)}`);

  const projects = await client.callTool({ name: "sparkbench_list_projects", arguments: {} });
  assert(textOf(projects as never).includes("projects"), "list_projects malformed");

  if (full) {
    console.log("[smoke] --full: starting simulation (this compiles firmware)…");
    const started = await client.callTool({ name: "sparkbench_start_simulation", arguments: {} });
    console.log(`[smoke] start: ${textOf(started as never)}`);
    assert(!(started as { isError?: boolean }).isError, "start_simulation errored");

    await client.callTool({ name: "sparkbench_run_ms", arguments: { ms: 1000 } });
    const serial = await client.callTool({ name: "sparkbench_read_serial", arguments: {} });
    console.log(`[smoke] serial bytes: ${textOf(serial as never).length}`);

    const parts = await client.callTool({ name: "sparkbench_list_parts", arguments: {} });
    const displays = JSON.parse(textOf(parts as never)).displays as { id: string }[];
    if (displays.length > 0) {
      const shot = await client.callTool({
        name: "sparkbench_take_screenshot",
        arguments: { partId: displays[0].id },
      });
      const img = (shot as { content: Array<{ type: string; data?: string }> }).content.find(
        (c) => c.type === "image",
      );
      assert(img?.data && img.data.length > 100, "screenshot returned no image data");
      console.log(`[smoke] screenshot ${displays[0].id}: ${img!.data!.length} base64 chars`);
    }
  }

  await client.close();
  console.log("[smoke] PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(`[smoke] FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
