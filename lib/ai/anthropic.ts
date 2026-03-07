import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, StreamCallbacks } from "./types";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export async function streamAnthropicChat(
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  options?: { model?: string; systemPrompt?: string },
) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const model = options?.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const systemMessages = messages.filter((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  const systemPrompt = options?.systemPrompt
    || systemMessages.map((m) => m.content).join("\n\n")
    || "You are a helpful assistant.";

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: chatMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        callbacks.onToken(event.delta.text);
      }
    }

    const finalMessage = await stream.finalMessage();
    callbacks.onDone({
      cost: (finalMessage.usage.input_tokens * 0.000003) +
            (finalMessage.usage.output_tokens * 0.000015),
    });
  } catch (err: any) {
    callbacks.onError(err.message || "Anthropic API error");
  }
}
