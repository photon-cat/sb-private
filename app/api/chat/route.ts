import { getProvider } from "@/lib/ai/types";
import { streamAnthropicChat } from "@/lib/ai/anthropic";
import { streamOpenRouterChat } from "@/lib/ai/openrouter";
import { streamAgentChat } from "@/lib/ai/agent-sdk";
import type { ChatMessage, StreamCallbacks } from "@/lib/ai/types";

export async function POST(request: Request) {
  const body = await request.json();
  const { messages, model, systemPrompt } = body as {
    messages: ChatMessage[];
    model?: string;
    systemPrompt?: string;
  };

  if (!messages?.length) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  const provider = getProvider();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const write = (data: Record<string, any>) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      const callbacks: StreamCallbacks = {
        onToken: (token) => write({ type: "text_delta", content: token }),
        onToolUse: (name, detail) => write({ type: "tool", name, detail }),
        onDone: (meta) => write({ type: "done", ...meta }),
        onError: (error) => write({ type: "error", message: error }),
      };

      try {
        switch (provider) {
          case "anthropic":
            await streamAnthropicChat(messages, callbacks, { model, systemPrompt });
            break;

          case "openrouter":
            await streamOpenRouterChat(messages, callbacks, { model, systemPrompt });
            break;

          case "agent-sdk": {
            // Agent SDK takes a single prompt, not a message array
            const lastUserMsg = messages.filter((m) => m.role === "user").pop();
            if (!lastUserMsg) {
              callbacks.onError("No user message found");
              break;
            }
            await streamAgentChat(lastUserMsg.content, callbacks, {
              model,
              systemPrompt,
            });
            break;
          }
        }
      } catch (err: any) {
        write({ type: "error", message: err.message || "Unknown error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
