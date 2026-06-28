import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const DEEPPCB_SSE_URL = "https://mcp.deeppcb.ai/agent/tools/sse";

export interface DeepPCBProgress {
  step: string;
  message: string;
  percent?: number;
}

export type ProgressCallback = (progress: DeepPCBProgress) => void;

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function extractText(result: ToolResult): string {
  return (
    result.content
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n") ?? ""
  );
}

function extractJobArgs(text: string): Record<string, unknown> {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text));
  } catch {
    // Tool output is often prose. Fall through to regex extraction.
  }

  const regexes = [
    /(?:job_id|jobId|routing_id|routingId|session_id|sessionId|board_id|boardId)["':=\s]+([a-zA-Z0-9_-]+)/,
    /\b([a-zA-Z0-9_-]{10,})\b/,
  ];
  for (const re of regexes) {
    const match = text.match(re);
    if (match?.[1]) candidates.push({ job_id: match[1] });
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;
    const value =
      obj.job_id ??
      obj.jobId ??
      obj.routing_id ??
      obj.routingId ??
      obj.session_id ??
      obj.sessionId ??
      obj.board_id ??
      obj.boardId;
    if (typeof value === "string" && value.length > 0) {
      return { job_id: value };
    }
  }
  return {};
}

function requireTool(
  tool: string | undefined,
  purpose: string,
  toolNames: string[],
): string {
  if (tool) return tool;
  throw new Error(`DeepPCB MCP server does not expose a ${purpose} tool. Available tools: ${toolNames.join(", ")}`);
}

export class DeepPCBClient {
  private client: Client;
  private apiKey: string;
  private connected = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new Client({ name: "sparkbench", version: "1.0.0" });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new SSEClientTransport(new URL(DEEPPCB_SSE_URL), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await this.client.callTool({ name, arguments: args });
    return result as ToolResult;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.close();
    } catch {
      // ignore close errors
    }
    this.connected = false;
  }

  /**
   * Discover tool names from the DeepPCB MCP server and match by substring patterns.
   */
  private findTool(
    tools: string[],
    patterns: string[],
  ): string | undefined {
    return tools.find((t) =>
      patterns.some((p) => t.toLowerCase().includes(p)),
    );
  }

  /**
   * Run the full autoroute workflow: extract constraints → validate → place → route → poll → retrieve.
   * Tool names are discovered dynamically since the exact API may evolve.
   */
  async autoroute(
    pcbContent: string,
    onProgress: ProgressCallback,
  ): Promise<string> {
    await this.connect();

    try {
      // Discover available tools
      const toolList = await this.listTools();
      const toolNames = toolList.map((t) => t.name);

      onProgress({
        step: "connected",
        message: `Connected to DeepPCB. Found ${toolNames.length} tools: ${toolNames.join(", ")}`,
      });

      const extractTool = this.findTool(toolNames, [
        "extract_constraint",
        "derive_constraint",
      ]);
      const validateTool = this.findTool(toolNames, ["validate"]);
      const placementTool = this.findTool(toolNames, [
        "start_placement",
        "place",
      ]);
      const routingTool = this.findTool(toolNames, [
        "start_rout",
        "route",
      ]);
      const statusTool = this.findTool(toolNames, [
        "check_status",
        "get_status",
        "status",
      ]);
      const resultTool = this.findTool(toolNames, [
        "get_best",
        "retrieve",
        "get_board",
        "best_board",
      ]);
      const requiredExtractTool = requireTool(extractTool, "constraint extraction", toolNames);
      const requiredRoutingTool = requireTool(routingTool, "routing", toolNames);
      const requiredResultTool = requireTool(resultTool, "board retrieval", toolNames);

      // Step 1: Extract constraints
      onProgress({
        step: "extracting",
        message: "Extracting constraints from board...",
        percent: 10,
      });
      const constraintResult = await this.callTool(requiredExtractTool, {
        board_content: pcbContent,
      });
      const constraintText = extractText(constraintResult);

      if (constraintResult.isError) {
        throw new Error(
          `Constraint extraction failed: ${constraintText}`,
        );
      }

      // Step 2: Validate constraints
      if (validateTool) {
        onProgress({
          step: "validating",
          message: "Validating constraints...",
          percent: 20,
        });
        const validationResult = await this.callTool(validateTool, {
          constraints: constraintText,
        });
        if (validationResult.isError) {
          throw new Error(
            `Validation failed: ${extractText(validationResult)}`,
          );
        }
      }

      // Step 3: Start placement
      let jobArgs: Record<string, unknown> = {};
      if (placementTool) {
        onProgress({
          step: "placing",
          message: "Starting component placement...",
          percent: 30,
        });
        const placementResult = await this.callTool(placementTool, {
          board_content: pcbContent,
          constraints: constraintText,
        });
        if (placementResult.isError) {
          throw new Error(
            `Placement failed: ${extractText(placementResult)}`,
          );
        }
        jobArgs = { ...jobArgs, ...extractJobArgs(extractText(placementResult)) };
      }

      // Step 4: Start routing
      onProgress({
        step: "routing",
        message: "Starting autorouting...",
        percent: 50,
      });
      const routingResult = await this.callTool(requiredRoutingTool, {
        board_content: pcbContent,
        constraints: constraintText,
        ...jobArgs,
      });
      const routingText = extractText(routingResult);
      if (routingResult.isError) {
        throw new Error(
          `Routing failed: ${routingText}`,
        );
      }
      jobArgs = { ...jobArgs, ...extractJobArgs(routingText) };

      // Step 5: Poll status until complete
      if (statusTool) {
        let complete = false;
        let pollCount = 0;
        const maxPolls = 720; // 5s * 720 = 1 hour max polling

        while (!complete && pollCount < maxPolls) {
          await new Promise((r) => setTimeout(r, 5000));
          pollCount++;

          const statusResult = await this.callTool(statusTool, jobArgs);
          const statusText = extractText(statusResult);

          const percent = Math.min(
            50 + Math.floor((pollCount / maxPolls) * 40),
            90,
          );
          onProgress({
            step: "routing",
            message: statusText || `Routing in progress... (poll ${pollCount})`,
            percent,
          });

          const lower = statusText.toLowerCase();
          if (
            lower.includes("complete") ||
            lower.includes("finished") ||
            lower.includes("done") ||
            lower.includes("ready")
          ) {
            complete = true;
          }
          if (
            lower.includes("failed") ||
            lower.includes("error") ||
            statusResult.isError
          ) {
            throw new Error(`Routing failed: ${statusText}`);
          }
        }

        if (!complete) {
          throw new Error("Routing timed out after 1 hour of polling");
        }
      }

      // Step 6: Retrieve the best routed board
      onProgress({
        step: "retrieving",
        message: "Retrieving routed board...",
        percent: 95,
      });
      const bestResult = await this.callTool(requiredResultTool, jobArgs);
      const boardText = extractText(bestResult);

      if (bestResult.isError || !boardText) {
        throw new Error(
          `Failed to retrieve board: ${extractText(bestResult)}`,
        );
      }

      onProgress({
        step: "done",
        message: "Routing complete!",
        percent: 100,
      });

      return boardText;
    } finally {
      await this.disconnect();
    }
  }
}
