# SparkBench — Local Development

## Local Dev vs Production

SparkBench runs in two very different modes depending on the environment:

|  | Local Dev | Production |
|--|-----------|------------|
| **Runtime** | Node.js 20+ on host, `npm run dev` (Turbopack) | Docker Compose (3 containers) |
| **Database** | None — projects stored as flat files in `projects/` | PostgreSQL 16 (Drizzle ORM) |
| **File storage** | Local filesystem (`projects/<slug>/`) | MinIO (S3-compatible object storage) |
| **Auth** | None — no login required | Google OAuth via Better-Auth |
| **Users** | Single user, no accounts | Multi-user with sessions, usage tracking |
| **AI agent** | Claude Code CLI on host | Claude Code CLI inside Docker + Agent SDK |
| **Firmware builds** | PlatformIO installed via pip on host | PlatformIO inside Docker (or sandboxed containers) |
| **Env file** | `.env.local` (2-3 vars) | `.env` (full config — DB, MinIO, auth, API keys) |
| **Config** | Minimal | PostgreSQL password, MinIO keys, auth secret, OAuth creds |
| **URL** | `http://localhost:3000` | `https://sparkbench.ai` (behind reverse proxy) |
| **Hot reload** | Yes (Turbopack) | No — rebuild Docker image to deploy changes |

## Prerequisites (macOS)

- **Node.js 20+** (via nvm, Homebrew, or direct install)
- **Python 3** with pip (for PlatformIO)
- **Git**

```bash
# Install Node.js 20 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20

# Install PlatformIO
pip3 install platformio
```

## Prerequisites (Ubuntu/Linux)

```bash
# Node.js 20
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 20

# PlatformIO
pip3 install platformio
```

## Recommended Operating Model

Use host-native local development as the default engineering loop:

- Run Next.js directly with `npm run dev`.
- Store projects as files under `projects/<slug>/`.
- Compile firmware with the host PlatformIO install.
- Skip PostgreSQL, MinIO, OAuth, and Docker unless you are testing deploy-only behavior.

This is the right approach for this project right now. The app is not serving enough users to justify a heavy local stack, and the main development problems are editor correctness, simulation wiring, PCB generation, and routing feedback. Those are easier to debug when files are plain files and the app is one host process.

Keep the current VPS/container deployment path for production. It is a reasonable low-traffic deployment model: one app container, Postgres, MinIO, and a reverse proxy. Do not introduce Kubernetes, a multi-service dev cluster, or a local Docker mirror until there is a concrete scaling or isolation problem.

## Setup

```bash
# Clone and install
git clone https://github.com/photon-cat/sparkbench.git
cd sparkbench
npm install

# Configure environment
cp .env.local.example .env.local
```

Edit `.env.local` — only one variable is normally needed for local dev:

```bash
# Required — powers Sparky AI agent
ANTHROPIC_API_KEY=sk-ant-...

# Optional — enables DeepPCB autorouter
DEEPPCB_API_KEY=
```

Do not set `DATABASE_URL` in `.env.local` unless you intentionally want to test production-style storage. Everything else (database, auth, MinIO) is not used in local dev. Projects are read from `projects/` on disk. No login is required.

## Running

```bash
npm run dev
```

Opens at **http://localhost:3000**. Turbopack provides instant hot reload.

`npm run dev` sets `SPARKBENCH_LOCAL_DEV=1`, so local development stays in filesystem-backed mode even if a production `.env` file exists in the repo. Use `npm run dev:prod-like` only when you intentionally want to exercise `DATABASE_URL`, MinIO, and auth locally.

### What works locally

- Code editor (Monaco)
- Circuit diagram editor
- Build & Run (compiles via PlatformIO, runs on avr8js emulator)
- Sparky AI chat (uses Claude Agent SDK → Claude Code CLI)
- PCB editor (KiCanvas fork)
- 3D board viewer
- Serial monitor
- CLI test runner and fuzzer

### What requires production setup

- User accounts and Google OAuth login
- Project persistence across sessions (needs PostgreSQL + MinIO)
- Usage tracking and billing limits
- Admin dashboard (`/dashboard/admin`)
- Multiple users with separate projects
- Star/favorite projects

## Project File Structure (Local)

In local dev, each project is a directory under `projects/`:

```
projects/
├── blink/
│   ├── diagram.json      # Circuit schematic (parts + connections)
│   └── sketch.ino        # Arduino firmware
├── simon-game/
│   ├── diagram.json
│   ├── sketch.ino
│   ├── board.kicad_pcb   # PCB layout (optional)
│   └── libraries.txt     # Extra PlatformIO libraries (optional)
└── ...
```

In production, these files are stored in MinIO and the project metadata (owner, stars, timestamps) lives in PostgreSQL.

## CLI Tools

```bash
# List all local projects
npm run sparkbench -- list

# Run a test scenario against the simulator
npm run sparkbench -- test <project-name>

# AI security fuzzer
npm run sparkbench -- fuzz <project-name>

# Direct test runner
npx tsx scripts/run-scenario.ts <project-name> [scenario.yaml]
```

## Environment Variables Reference

### Local dev (`.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Sparky AI |
| `DEEPPCB_API_KEY` | No | DeepPCB autorouter key |
| `PLATFORMIO_CORE_DIR` | No | PlatformIO install path (default: `~/.platformio`) |
| `SPARKBENCH_LOCAL_DEV` | Yes | Forces local filesystem storage and skips production auth/storage coupling |

### Production (`.env`)

See [docs/deploy.md](deploy.md) for the full list. Production requires ~12 variables covering PostgreSQL, MinIO, Better-Auth, Google OAuth, and the Anthropic API key.

## Switching Between Local and Production

The codebase detects its environment automatically:

- **Database**: API routes use file-backed projects when `SPARKBENCH_LOCAL_DEV=1` or `DATABASE_URL` is absent. Otherwise they use PostgreSQL.
- **Storage**: `lib/storage.ts` connects to MinIO using `MINIO_ENDPOINT`. In local dev, project files are served from `projects/` on disk.
- **Auth**: `lib/auth.ts` uses Better-Auth with `BETTER_AUTH_SECRET`. In local dev without this set, auth endpoints are inactive and all features work without login.
- **Builds**: PlatformIO runs the same way in both environments — the only difference is the `SANDBOX_ENABLED` flag for Docker isolation in production.

## Common Issues

| Problem | Fix |
|---------|-----|
| `Node.js >= 20.9.0 required` | Install Node 20+ via nvm |
| `pio: command not found` | `pip3 install platformio` and ensure it's on PATH |
| Build fails on first run | PlatformIO auto-downloads the AVR toolchain — needs internet |
| `.env.local` not picked up | Restart `npm run dev` after editing |
| Port 3000 in use | Kill the other process or set `PORT=3001 npm run dev` |
| macOS Xcode errors during npm install | Run `xcode-select --install` for build tools |

## Next Steps

- To deploy to production, see [docs/deploy.md](deploy.md)
- For the full project overview, see [README.md](../README.md)
- For CLI testing, see the CLI section in [README.md](../README.md#sparkbench-cli)
