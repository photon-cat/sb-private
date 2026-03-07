"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import CloseIcon from "@mui/icons-material/Close";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./Chat.module.css";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools?: { name: string; detail: string }[];
}

interface ChatProps {
  open: boolean;
  onClose: () => void;
  provider?: string;
  systemPrompt?: string;
  suggestions?: string[];
}

const DEFAULT_SUGGESTIONS = [
  "Help me get started",
  "Explain this project",
  "What can you do?",
  "Write some code",
];

export default function Chat({
  open,
  onClose,
  provider,
  systemPrompt,
  suggestions = DEFAULT_SUGGESTIONS,
}: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return;

      const userMsg: ChatMessage = { role: "user", content: text.trim() };
      const newMessages = [...messages, userMsg];
      setMessages(newMessages);
      setInput("");
      setStreaming(true);

      const assistantMsg: ChatMessage = { role: "assistant", content: "", tools: [] };
      setMessages([...newMessages, assistantMsg]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const apiMessages = newMessages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: apiMessages,
            systemPrompt,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Request failed" }));
          assistantMsg.content = `Error: ${err.error || res.statusText}`;
          setMessages([...newMessages, { ...assistantMsg }]);
          setStreaming(false);
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              switch (data.type) {
                case "text_delta":
                  assistantMsg.content += data.content;
                  setMessages([...newMessages, { ...assistantMsg, tools: [...(assistantMsg.tools || [])] }]);
                  break;
                case "tool":
                  assistantMsg.tools = [...(assistantMsg.tools || []), { name: data.name, detail: data.detail }];
                  setMessages([...newMessages, { ...assistantMsg }]);
                  break;
                case "error":
                  assistantMsg.content += `\n\n**Error:** ${data.message}`;
                  setMessages([...newMessages, { ...assistantMsg }]);
                  break;
                case "done":
                  break;
              }
            } catch {
              // skip malformed
            }
          }
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          assistantMsg.content += `\n\nConnection error: ${err.message}`;
          setMessages([...newMessages, { ...assistantMsg }]);
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [messages, streaming, systemPrompt],
  );

  const handleStop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  if (!open) return null;

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <AutoAwesomeIcon sx={{ fontSize: 18, color: "#f59e0b" }} />
          <span className={styles.title}>AI Chat</span>
          {provider && <span className={styles.providerBadge}>{provider}</span>}
        </div>
        <button className={styles.closeBtn} onClick={onClose}>
          <CloseIcon sx={{ fontSize: 18 }} />
        </button>
      </div>

      {/* Messages */}
      {messages.length === 0 ? (
        <div className={styles.empty}>
          <AutoAwesomeIcon className={styles.emptyIcon} sx={{ fontSize: 36 }} />
          <span style={{ fontSize: 13 }}>How can I help?</span>
          <div className={styles.suggestions}>
            {suggestions.map((s) => (
              <button key={s} className={styles.suggestion} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.messages}>
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "user" ? (
                <div className={`${styles.message} ${styles.messageUser}`}>
                  {msg.content}
                </div>
              ) : (
                <div className={`${styles.message} ${styles.messageAssistant}`}>
                  {msg.tools && msg.tools.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      {msg.tools.map((t, j) => (
                        <span key={j} className={styles.toolBadge}>
                          <span className={styles.toolName}>{t.name}</span>
                          {t.detail && <span className={styles.toolDetail}>{t.detail}</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content || (streaming && i === messages.length - 1 ? "..." : "")}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          ))}
          {streaming && (
            <div className={styles.streaming}>
              <span className={styles.streamingDot} />
              <span>Thinking...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input */}
      <div className={styles.inputRow}>
        <textarea
          ref={textareaRef}
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything..."
          rows={1}
          disabled={streaming}
        />
        {streaming ? (
          <button className={styles.stopBtn} onClick={handleStop}>
            <StopIcon sx={{ fontSize: 18 }} />
          </button>
        ) : (
          <button
            className={styles.sendBtn}
            onClick={() => send(input)}
            disabled={!input.trim()}
          >
            <SendIcon sx={{ fontSize: 18 }} />
          </button>
        )}
      </div>
    </div>
  );
}
