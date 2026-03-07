import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { StreamCallbacks } from "./types";

const DEFAULT_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a helpful AI assistant. You have access to tools for reading, writing, and editing files, as well as running shell commands. Use these tools to help the user with their tasks.

When working with files:
- Always read files before modifying them
- Use the Edit tool for targeted changes, Write for new files
- Explain what you changed and why`;

export async function streamAgentChat(
  userMessage: string,
  callbacks: StreamCallbacks,
  options?: {
    model?: string;
    systemPrompt?: string;
    cwd?: string;
    mcpServers?: Record<string, ReturnType<typeof createSdkMcpServer>>;
    allowedTools?: string[];
    maxTurns?: number;
  },
) {
  const model = options?.model || process.env.AGENT_MODEL || DEFAULT_MODEL;
  const cwd = options?.cwd || process.cwd();

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    // Allow all tools by default — override this for sandboxed use
    return { behavior: "allow" };
  };

  try {
    const q = query({
      prompt: userMessage,
      options: {
        model,
        systemPrompt: options?.systemPrompt || SYSTEM_PROMPT,
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: options?.allowedTools || [
          "Read", "Write", "Edit", "Bash", "Glob", "Grep",
        ],
        disallowedTools: [
          "TodoWrite", "TodoRead", "Task", "WebFetch", "WebSearch", "NotebookEdit",
        ],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        canUseTool,
        mcpServers: options?.mcpServers || {},
        cwd,
        maxTurns: options?.maxTurns || 20,
        includePartialMessages: true,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        stderr: () => {},
      },
    });

    for await (const msg of q) {
      switch (msg.type) {
        case "stream_event": {
          const evt = (msg as any).event;
          if (
            evt?.type === "content_block_delta" &&
            evt.delta?.type === "text_delta"
          ) {
            callbacks.onToken(evt.delta.text);
          }
          break;
        }
        case "assistant": {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              callbacks.onToolUse?.(block.name, summarizeTool(block.name, block.input as Record<string, any>));
            }
          }
          break;
        }
        case "result": {
          if (msg.subtype === "success" && !msg.is_error) {
            callbacks.onDone({
              turns: msg.num_turns,
              cost: msg.total_cost_usd,
            });
          } else {
            callbacks.onError(msg.subtype || "Agent query failed");
          }
          return;
        }
      }
    }
  } catch (err: any) {
    callbacks.onError(err.message || "Agent SDK error");
  }
}

function summarizeTool(name: string, input: Record<string, any>): string {
  switch (name) {
    case "Write":
    case "Read":
    case "Edit":
      return input.file_path?.split("/").pop() || "";
    case "Bash":
      return (input.command || "").slice(0, 80);
    case "Glob":
    case "Grep":
      return input.pattern || "";
    default:
      return "";
  }
}

// Helper to create custom MCP tools for your project
export { createSdkMcpServer, tool, z };
