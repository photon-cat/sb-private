import type { ChatMessage, StreamCallbacks } from "./types";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

export async function streamOpenRouterChat(
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  options?: { model?: string; systemPrompt?: string },
) {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const model = options?.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  const systemMessages = messages.filter((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  const systemPrompt = options?.systemPrompt
    || systemMessages.map((m) => m.content).join("\n\n")
    || "You are a helpful assistant.";

  const body = {
    model,
    stream: true,
    messages: [
      { role: "system", content: systemPrompt },
      ...chatMessages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
        "X-Title": "SparkStack",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      callbacks.onError(`OpenRouter error ${response.status}: ${err}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      callbacks.onError("No response body");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            callbacks.onToken(delta);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    callbacks.onDone();
  } catch (err: any) {
    callbacks.onError(err.message || "OpenRouter API error");
  }
}
