#!/usr/bin/env bash
set -euo pipefail

# SparkStack Template Setup
# Configures the template for one of three modes:
#   1) Generic web app (no AI)
#   2) Claude Agent SDK (MCP tools)
#   3) Generic model API (Anthropic + OpenRouter)

BOLD='\033[1m'
DIM='\033[2m'
AMBER='\033[38;5;214m'
GREEN='\033[38;5;65m'
RED='\033[38;5;203m'
RESET='\033[0m'

header() {
  echo ""
  echo -e "${AMBER}${BOLD}SparkStack${RESET} ${DIM}template setup${RESET}"
  echo -e "${DIM}─────────────────────────────────${RESET}"
  echo ""
}

header

echo -e "  ${BOLD}1)${RESET} Generic web app ${DIM}(no AI — just the core stack)${RESET}"
echo -e "  ${BOLD}2)${RESET} Claude Agent SDK ${DIM}(Claude Code tools + MCP)${RESET}"
echo -e "  ${BOLD}3)${RESET} Generic model API ${DIM}(Anthropic API + OpenRouter)${RESET}"
echo ""

read -rp "$(echo -e "${AMBER}>${RESET} Choose template [1/2/3]: ")" choice

case "$choice" in
  1) MODE="generic" ;;
  2) MODE="agent-sdk" ;;
  3) MODE="model-api" ;;
  *)
    echo -e "${RED}Invalid choice.${RESET} Run ./setup.sh again."
    exit 1
    ;;
esac

echo ""
read -rp "$(echo -e "${AMBER}>${RESET} Project name ${DIM}(lowercase, e.g. my-app)${RESET}: ")" PROJECT_NAME
PROJECT_NAME="${PROJECT_NAME:-sparkstack}"

echo ""
echo -e "${DIM}Setting up ${BOLD}${PROJECT_NAME}${RESET}${DIM} with ${BOLD}${MODE}${RESET}${DIM} template...${RESET}"
echo ""

# ── Helper: remove files safely ──
remove_files() {
  for f in "$@"; do
    if [ -e "$f" ]; then
      rm -rf "$f"
      echo -e "  ${DIM}removed${RESET} $f"
    fi
  done
}

# ── 1) Strip AI code for generic mode ──
if [ "$MODE" = "generic" ]; then
  echo -e "${AMBER}Removing AI integration...${RESET}"
  remove_files \
    lib/ai \
    app/api/chat \
    components/Chat.tsx \
    components/Chat.module.css

  # Remove AI chat button and panel from dashboard
  # Write a clean dashboard without AI imports/state/UI
  cat > app/dashboard/page.tsx << 'DASHBOARD_EOF'
"use client";

import { useState } from "react";
import AuthButton from "@/components/AuthButton";
import Tabs from "@/components/Tabs";
import styles from "./dashboard.module.css";

const TABS = [
  { id: "overview", label: "overview" },
  { id: "settings", label: "settings" },
];

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState("overview");

  return (
    <div className={styles.page}>
      {/* Toolbar */}
      <div className={styles.header}>
        <a href="/" className={styles.logo}>
          <span className={styles.logoAccent}>Spark</span>Stack
        </a>
        <div className={styles.spacer} />
        <AuthButton />
        <span className={styles.version}>v0.1.0</span>
      </div>

      {/* Tabs */}
      <Tabs tabs={TABS} activeId={activeTab} onTabChange={setActiveTab} />

      {/* Content */}
      <div className={styles.main}>
        <div className={styles.content}>
          {activeTab === "overview" && (
            <>
              {/* About section */}
              <div className={styles.about}>
                <div className={styles.comment}>// welcome</div>
                <p>
                  This is the SparkStack project template. It includes the full
                  infrastructure stack: Next.js 16, React 19, PostgreSQL with
                  Drizzle ORM, MinIO object storage, Better-Auth with Google
                  OAuth, and the SparkBench dark IDE aesthetic.
                </p>
                <div className={styles.comment}>// stack</div>
                <div className={styles.tagRow}>
                  {["Next.js 16", "React 19", "TypeScript", "Tailwind", "PostgreSQL", "Drizzle", "MinIO", "Better-Auth", "Docker", "MUI"].map((s) => (
                    <span key={s} className={styles.tag}>{s}</span>
                  ))}
                </div>
              </div>

              {/* Quick start */}
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>quick start</span>
              </div>

              <div className={styles.guide}>
                <div className={styles.guideStep}>
                  <span className={styles.guideNum}>1</span>
                  <div>
                    <div className={styles.guideLabel}>Copy environment</div>
                    <code className={styles.code}>cp .env.example .env</code>
                  </div>
                </div>
                <div className={styles.guideStep}>
                  <span className={styles.guideNum}>2</span>
                  <div>
                    <div className={styles.guideLabel}>Start services</div>
                    <code className={styles.code}>docker compose up -d</code>
                  </div>
                </div>
                <div className={styles.guideStep}>
                  <span className={styles.guideNum}>3</span>
                  <div>
                    <div className={styles.guideLabel}>Install &amp; run</div>
                    <code className={styles.code}>npm install && npm run db:push && npm run dev</code>
                  </div>
                </div>
              </div>

              {/* Features section */}
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>included</span>
              </div>

              <div className={styles.featureList}>
                <FeatureRow icon="db" title="PostgreSQL + Drizzle ORM" desc="Schema in lib/db/schema.ts, push with npm run db:push" />
                <FeatureRow icon="auth" title="Google OAuth" desc="Better-Auth wired to Drizzle, add providers in lib/auth.ts" />
                <FeatureRow icon="s3" title="MinIO Object Storage" desc="S3-compatible file storage, helpers in lib/storage.ts" />
                <FeatureRow icon="docker" title="Docker Production Deploy" desc="Multi-stage Dockerfile, docker-compose.prod.yml ready" />
                <FeatureRow icon="ui" title="Dark IDE Aesthetic" desc="SparkBench-style dark theme with MUI + Tailwind" />
              </div>
            </>
          )}

          {activeTab === "settings" && (
            <div className={styles.empty}>
              settings panel — add your app config here
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FeatureRow({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  const icons: Record<string, string> = { db: "//", auth: ">>", s3: "[]", docker: "<>", ui: "##" };
  return (
    <div className={styles.featureRow}>
      <span className={styles.featureIcon}>{icons[icon] || "//"}</span>
      <div>
        <div className={styles.featureName}>{title}</div>
        <div className={styles.featureDesc}>{desc}</div>
      </div>
    </div>
  );
}
DASHBOARD_EOF
  echo -e "  ${DIM}rewrote${RESET} app/dashboard/page.tsx ${DIM}(no AI)${RESET}"

  # Strip AI-related CSS from dashboard
  sed -i.bak '/\/\* -- Chat button/,/^$/d' app/dashboard/dashboard.module.css
  sed -i.bak '/\.chatBtn/,/^}/d' app/dashboard/dashboard.module.css
  sed -i.bak '/\.chatPanel/,/^}/d' app/dashboard/dashboard.module.css
  sed -i.bak '/@keyframes slideIn/,/^}/d' app/dashboard/dashboard.module.css
  rm -f app/dashboard/dashboard.module.css.bak
  echo -e "  ${DIM}cleaned${RESET} app/dashboard/dashboard.module.css"

  # Remove AI deps from package.json
  node -e "
    const pkg = require('./package.json');
    delete pkg.dependencies['@anthropic-ai/claude-agent-sdk'];
    delete pkg.dependencies['@anthropic-ai/sdk'];
    delete pkg.dependencies['@modelcontextprotocol/sdk'];
    delete pkg.dependencies['react-markdown'];
    delete pkg.dependencies['remark-gfm'];
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo -e "  ${DIM}cleaned${RESET} package.json ${DIM}(removed AI deps)${RESET}"

  # Strip AI env vars from .env.example
  sed -i.bak '/^# --- AI/,$d' .env.example
  rm -f .env.example.bak
  echo -e "  ${DIM}cleaned${RESET} .env.example"

  # Strip AI env vars from docker-compose.prod.yml
  sed -i.bak '/# AI providers/,/AGENT_MODEL/d' docker-compose.prod.yml
  rm -f docker-compose.prod.yml.bak
  echo -e "  ${DIM}cleaned${RESET} docker-compose.prod.yml"

  # Strip Agent SDK lines from Dockerfile
  sed -i.bak '/Claude Agent SDK/d' Dockerfile
  sed -i.bak '/@anthropic-ai/d' Dockerfile
  sed -i.bak '/claude-code/d' Dockerfile
  sed -i.bak '/Comment out this line/d' Dockerfile
  sed -i.bak '/docker-entrypoint/d' Dockerfile
  rm -f Dockerfile.bak
  # Use simple node server.js CMD
  sed -i.bak 's|CMD \["sh", "./docker-entrypoint.sh"\]|CMD ["node", "server.js"]|' Dockerfile
  rm -f Dockerfile.bak
  echo -e "  ${DIM}cleaned${RESET} Dockerfile"

  remove_files docker-entrypoint.sh

fi

# ── 2) Strip for Agent SDK only ──
if [ "$MODE" = "agent-sdk" ]; then
  echo -e "${AMBER}Configuring for Claude Agent SDK...${RESET}"
  remove_files \
    lib/ai/anthropic.ts \
    lib/ai/openrouter.ts

  # Rewrite types.ts — agent-sdk only
  cat > lib/ai/types.ts << 'TYPES_EOF'
export type AIProvider = "agent-sdk";

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
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for Claude Agent SDK");
  }
  return "agent-sdk";
}
TYPES_EOF
  echo -e "  ${DIM}rewrote${RESET} lib/ai/types.ts ${DIM}(agent-sdk only)${RESET}"

  # Rewrite index.ts
  cat > lib/ai/index.ts << 'INDEX_EOF'
export { getProvider } from "./types";
export type { AIProvider, ChatMessage, StreamCallbacks } from "./types";
export { streamAgentChat, createSdkMcpServer, tool, z } from "./agent-sdk";
INDEX_EOF
  echo -e "  ${DIM}rewrote${RESET} lib/ai/index.ts"

  # Rewrite chat route — agent-sdk only
  cat > app/api/chat/route.ts << 'ROUTE_EOF'
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
        const lastUserMsg = messages.filter((m) => m.role === "user").pop();
        if (!lastUserMsg) {
          callbacks.onError("No user message found");
        } else {
          await streamAgentChat(lastUserMsg.content, callbacks, {
            model,
            systemPrompt,
          });
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
ROUTE_EOF
  echo -e "  ${DIM}rewrote${RESET} app/api/chat/route.ts ${DIM}(agent-sdk only)${RESET}"

  # Remove non-agent deps
  node -e "
    const pkg = require('./package.json');
    delete pkg.dependencies['@anthropic-ai/sdk'];
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo -e "  ${DIM}cleaned${RESET} package.json ${DIM}(removed @anthropic-ai/sdk)${RESET}"

  # Simplify .env.example
  cat > .env.example << 'ENV_EOF'
# Database
DATABASE_URL=postgresql://sparkstack:password@localhost:5432/sparkstack
POSTGRES_DB=sparkstack
POSTGRES_USER=sparkstack
POSTGRES_PASSWORD=password

# MinIO (S3-compatible object storage)
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=sparkstack
MINIO_USE_SSL=false

# Auth
BETTER_AUTH_SECRET=change-me-to-a-random-string
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Google OAuth (optional — get from console.cloud.google.com)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Claude Agent SDK
ANTHROPIC_API_KEY=
AGENT_MODEL=claude-sonnet-4-6
ENV_EOF
  echo -e "  ${DIM}rewrote${RESET} .env.example"

  # Clean docker-compose.prod.yml AI vars
  sed -i.bak '/# AI providers/,/AGENT_MODEL/d' docker-compose.prod.yml
  # Add back just the agent vars
  sed -i.bak '/GOOGLE_CLIENT_SECRET/a\
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}\
      AGENT_MODEL: ${AGENT_MODEL:-claude-sonnet-4-6}' docker-compose.prod.yml
  rm -f docker-compose.prod.yml.bak
  echo -e "  ${DIM}cleaned${RESET} docker-compose.prod.yml"

  # Remove OpenRouter refs from Dockerfile (keep Agent SDK)
  sed -i.bak '/Comment out this line/d' Dockerfile
  rm -f Dockerfile.bak
  echo -e "  ${DIM}cleaned${RESET} Dockerfile"

fi

# ── 3) Strip for model API only ──
if [ "$MODE" = "model-api" ]; then
  echo -e "${AMBER}Configuring for generic model API...${RESET}"
  remove_files \
    lib/ai/agent-sdk.ts

  # Rewrite types.ts — no agent-sdk
  cat > lib/ai/types.ts << 'TYPES_EOF'
export type AIProvider = "anthropic" | "openrouter";

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
  if (process.env.OPENROUTER_API_KEY) {
    return "openrouter";
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return "anthropic";
  }
  throw new Error("No AI provider configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env");
}
TYPES_EOF
  echo -e "  ${DIM}rewrote${RESET} lib/ai/types.ts ${DIM}(anthropic + openrouter)${RESET}"

  # Rewrite index.ts
  cat > lib/ai/index.ts << 'INDEX_EOF'
export { getProvider } from "./types";
export type { AIProvider, ChatMessage, StreamCallbacks } from "./types";
export { streamAnthropicChat } from "./anthropic";
export { streamOpenRouterChat } from "./openrouter";
INDEX_EOF
  echo -e "  ${DIM}rewrote${RESET} lib/ai/index.ts"

  # Rewrite chat route — no agent-sdk
  cat > app/api/chat/route.ts << 'ROUTE_EOF'
import { getProvider } from "@/lib/ai/types";
import { streamAnthropicChat } from "@/lib/ai/anthropic";
import { streamOpenRouterChat } from "@/lib/ai/openrouter";
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
ROUTE_EOF
  echo -e "  ${DIM}rewrote${RESET} app/api/chat/route.ts ${DIM}(anthropic + openrouter)${RESET}"

  # Remove agent SDK deps
  node -e "
    const pkg = require('./package.json');
    delete pkg.dependencies['@anthropic-ai/claude-agent-sdk'];
    delete pkg.dependencies['@modelcontextprotocol/sdk'];
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo -e "  ${DIM}cleaned${RESET} package.json ${DIM}(removed agent-sdk deps)${RESET}"

  # Simplify .env.example
  cat > .env.example << 'ENV_EOF'
# Database
DATABASE_URL=postgresql://sparkstack:password@localhost:5432/sparkstack
POSTGRES_DB=sparkstack
POSTGRES_USER=sparkstack
POSTGRES_PASSWORD=password

# MinIO (S3-compatible object storage)
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=sparkstack
MINIO_USE_SSL=false

# Auth
BETTER_AUTH_SECRET=change-me-to-a-random-string
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Google OAuth (optional — get from console.cloud.google.com)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# --- AI Configuration ---
# Set AI_PROVIDER to force: "anthropic" | "openrouter"
# If not set, auto-detects from available keys
# AI_PROVIDER=

# Anthropic API (direct)
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6

# OpenRouter (access 100+ models via one API)
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-sonnet-4
ENV_EOF
  echo -e "  ${DIM}rewrote${RESET} .env.example"

  # Clean docker-compose.prod.yml
  sed -i.bak '/# AI providers/,/AGENT_MODEL/d' docker-compose.prod.yml
  sed -i.bak '/GOOGLE_CLIENT_SECRET/a\
      AI_PROVIDER: ${AI_PROVIDER:-}\
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}\
      ANTHROPIC_MODEL: ${ANTHROPIC_MODEL:-claude-sonnet-4-6}\
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}\
      OPENROUTER_MODEL: ${OPENROUTER_MODEL:-anthropic/claude-sonnet-4}' docker-compose.prod.yml
  rm -f docker-compose.prod.yml.bak
  echo -e "  ${DIM}cleaned${RESET} docker-compose.prod.yml"

  # Strip Agent SDK lines from Dockerfile, use simple entrypoint
  sed -i.bak '/Claude Agent SDK/d' Dockerfile
  sed -i.bak '/@anthropic-ai/d' Dockerfile
  sed -i.bak '/claude-code/d' Dockerfile
  sed -i.bak '/Comment out this line/d' Dockerfile
  sed -i.bak '/docker-entrypoint/d' Dockerfile
  sed -i.bak 's|CMD \["sh", "./docker-entrypoint.sh"\]|CMD ["node", "server.js"]|' Dockerfile
  rm -f Dockerfile.bak
  echo -e "  ${DIM}cleaned${RESET} Dockerfile"

  remove_files docker-entrypoint.sh

fi

# ── Rename project everywhere ──
echo ""
echo -e "${AMBER}Renaming to ${BOLD}${PROJECT_NAME}${RESET}${AMBER}...${RESET}"

# package.json name
node -e "
  const pkg = require('./package.json');
  pkg.name = '${PROJECT_NAME}';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo -e "  ${DIM}updated${RESET} package.json name"

# docker-compose defaults
if [ -f docker-compose.yml ]; then
  sed -i.bak "s/sparkstack/${PROJECT_NAME}/g" docker-compose.yml
  rm -f docker-compose.yml.bak
  echo -e "  ${DIM}updated${RESET} docker-compose.yml"
fi

if [ -f docker-compose.prod.yml ]; then
  sed -i.bak "s/sparkstack/${PROJECT_NAME}/g" docker-compose.prod.yml
  rm -f docker-compose.prod.yml.bak
  echo -e "  ${DIM}updated${RESET} docker-compose.prod.yml"
fi

if [ -f .env.example ]; then
  sed -i.bak "s/sparkstack/${PROJECT_NAME}/g" .env.example
  rm -f .env.example.bak
  echo -e "  ${DIM}updated${RESET} .env.example"
fi

if [ -f Dockerfile ]; then
  sed -i.bak "s/sparkstack/${PROJECT_NAME}/g" Dockerfile
  rm -f Dockerfile.bak
fi

# ── Cleanup ──
echo ""
echo -e "${AMBER}Cleaning up...${RESET}"
rm -f setup.sh
echo -e "  ${DIM}removed${RESET} setup.sh"

# ── Done ──
echo ""
echo -e "${GREEN}${BOLD}Done!${RESET} Your ${BOLD}${PROJECT_NAME}${RESET} project is ready."
echo ""
echo -e "  ${DIM}Next steps:${RESET}"
echo -e "    cp .env.example .env"
echo -e "    docker compose up -d"
echo -e "    npm install && npm run db:push && npm run dev"
echo ""
