export type AIProvider = "anthropic" | "openrouter" | "agent-sdk";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolUse?: (name: string, detail: string) => void;
  onDone: (meta?: { turns?: number; cost?: number }) => void;
  onError: (error: string) => void;
}

export function getProvider(): AIProvider {
  if (process.env.AI_PROVIDER) {
    return process.env.AI_PROVIDER as AIProvider;
  }
  // Auto-detect from available keys
  if (process.env.ANTHROPIC_API_KEY && process.env.USE_AGENT_SDK === "true") {
    return "agent-sdk";
  }
  if (process.env.OPENROUTER_API_KEY) {
    return "openrouter";
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return "anthropic";
  }
  throw new Error("No AI provider configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env");
}
