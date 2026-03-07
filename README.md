# SparkStack Template

Project scaffold extracted from SparkBench — dark IDE-aesthetic full-stack starter with AI integration.

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS** + **MUI** (dark theme)
- **PostgreSQL 16** + **Drizzle ORM**
- **MinIO** (S3-compatible object storage)
- **Better-Auth** (Google OAuth, extensible)
- **AI Chat** (3 providers: Anthropic API, OpenRouter, Claude Agent SDK)
- **Docker** (multi-stage build, docker-compose)

## Getting Started

```bash
# 1. Copy environment
cp .env.example .env
# Edit .env — set at least one AI provider key

# 2. Start Postgres + MinIO
docker compose up -d

# 3. Install, push schema, dev
npm install
npm run db:push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## AI Providers

Set one in `.env`:

| Provider | Key | What you get |
|----------|-----|-------------|
| **Anthropic API** | `ANTHROPIC_API_KEY` | Direct Claude API, streaming chat |
| **OpenRouter** | `OPENROUTER_API_KEY` | 100+ models (Claude, GPT, Llama, etc.) via one API |
| **Agent SDK** | `ANTHROPIC_API_KEY` + `USE_AGENT_SDK=true` | Claude Code tools (Read/Write/Edit/Bash/Glob/Grep) + MCP |

Auto-detects from available keys, or force with `AI_PROVIDER=anthropic|openrouter|agent-sdk`.

### Adding Custom MCP Tools (Agent SDK)

```typescript
// lib/ai/agent-sdk.ts — add tools to the mcpServers config
import { createSdkMcpServer, tool, z } from "@/lib/ai";

const myTools = createSdkMcpServer({
  name: "my-tools",
  version: "1.0.0",
  tools: [
    tool("MyTool", "Description", { arg: z.string() }, async (args) => {
      return { content: [{ type: "text", text: "result" }] };
    }),
  ],
});
```

## Production Deploy

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

## Project Structure

```
app/
  layout.tsx            — Root layout with ThemeRegistry
  page.tsx              — Redirects to /dashboard
  dashboard/            — Dashboard page with AI chat
  api/auth/[...all]/    — Better-Auth route handler
  api/chat/             — AI chat endpoint (auto-detects provider)
components/
  ThemeRegistry.tsx     — MUI dark theme + Emotion SSR
  AuthButton.tsx        — Google sign-in + avatar dropdown
  Chat.tsx              — AI chat panel (streaming, tool badges)
  Tabs.tsx              — IDE-style tab bar
lib/
  ai/index.ts           — AI provider exports
  ai/types.ts           — Provider detection + types
  ai/anthropic.ts       — Anthropic API streaming
  ai/openrouter.ts      — OpenRouter API streaming
  ai/agent-sdk.ts       — Claude Agent SDK with MCP tools
  auth.ts               — Better-Auth server config
  auth-client.ts        — Better-Auth React client
  db/index.ts           — Drizzle + pg pool
  db/schema.ts          — Auth tables + your app tables
  storage.ts            — MinIO helpers (put/get/delete/exists)
  theme.ts              — MUI dark theme definition
```

## Adding Your Own Tables

Edit `lib/db/schema.ts`, add your tables, then:

```bash
npm run db:push
```

## Aesthetic

Dark IDE look inherited from SparkBench:
- Black/dark gray backgrounds (#000, #1a1a1a, #222, #252526)
- Amber accent (#f59e0b) for highlights
- Muted green (#335533) for primary actions and active tabs
- Monospace font for labels/metadata (Cascadia Code / Fira Code)
- Roboto for body text
- Compact, information-dense layouts
