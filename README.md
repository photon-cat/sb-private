# SparkStack Template

Project scaffold extracted from SparkBench — dark IDE-aesthetic full-stack starter.

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS** + **MUI** (dark theme)
- **PostgreSQL 16** + **Drizzle ORM**
- **MinIO** (S3-compatible object storage)
- **Better-Auth** (Google OAuth, extensible)
- **Docker** (multi-stage build, docker-compose)

## Getting Started

```bash
# 1. Copy environment
cp .env.example .env

# 2. Start Postgres + MinIO
docker compose up -d

# 3. Install, push schema, dev
npm install
npm run db:push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production Deploy

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

## Project Structure

```
app/
  layout.tsx          — Root layout with ThemeRegistry
  page.tsx            — Redirects to /dashboard
  dashboard/          — Dashboard page (SparkBench aesthetic)
  api/auth/[...all]/  — Better-Auth route handler
components/
  ThemeRegistry.tsx   — MUI dark theme + Emotion SSR
  AuthButton.tsx      — Google sign-in + avatar dropdown
  Tabs.tsx            — IDE-style tab bar
lib/
  auth.ts             — Better-Auth server config
  auth-client.ts      — Better-Auth React client
  db/index.ts         — Drizzle + pg pool
  db/schema.ts        — Auth tables + your app tables
  storage.ts          — MinIO helpers (put/get/delete)
  theme.ts            — MUI dark theme definition
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
