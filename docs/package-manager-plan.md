# Portable Package Manager — Lockfile + Vendoring

Status: **Plan** (no code yet). Branch: `full-local`.

## Why

SparkBench compiles Arduino firmware **server-side** with PlatformIO
(`app/api/projects/[id]/build/route.ts` → optionally `lib/sandbox.ts`) and simulates the
resulting `hex`/`bin`/`uf2` **in-browser** (avr8js, rp2040js, unicorn-arm).

Dependency handling today is weak and **not reproducible**:

- `libraries.txt` is **name-only** — no versions, no pinning.
- The build route auto-detects `#include`s via a `HEADER_TO_LIB` map and hands names to
  PlatformIO, which resolves **"latest compatible"** at build time.
- Nothing is vendored. A project that builds today can break tomorrow when an upstream
  library publishes a new release. Projects are not portable or offline-rebuildable.

This plan introduces a browser-driven **package manager** that:

1. Resolves dependencies against the **Arduino Library Index** (arch-aware: AVR + RP2040 from day one).
2. Writes a **lockfile** (`sparkbench.lock`) pinning the full transitive closure with integrity hashes.
3. Stores resolved archives in a **content-addressed store (CAS)** — each library stored once, deduped.
4. Lets the server **"ship a saved project along with the exact deps it used"** via an export bundle.
5. Makes the server build **hermetic** (no network) by feeding vendored deps through PlatformIO's
   existing `lib_extra_dirs` mechanism.

This is **Phase 0** of [the in-browser compile roadmap](./roadmap-in-browser-compile.md): a stable
lockfile + CAS + vendoring foundation that a future in-browser compiler can reuse unchanged.

### Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Vendoring model | Content-addressed store + on-demand export bundle | Dedup across projects; still fully portable/offline |
| Registry | Arduino Library Index (`library_index.json`) | Already integrated via `/api/libraries/search`; carries per-lib `architectures` tags; canonical for AVR **and** RP2040 |
| PlatformIO specs | Kept via a compat map | Existing `libraries.txt` / `HEADER_TO_LIB` entries keep working |

---

## 1. Lockfile — `sparkbench.lock`

A JSON file stored **as a project file**, exactly like `libraries.txt`:

- Server: MinIO object `projects/{id}/sparkbench.lock`, added to the project's `fileManifest`
  (`lib/db/schema.ts` → `projects.fileManifest`).
- Local dev: `projects/{slug}/sparkbench.lock` on disk (`lib/local-projects.ts`).

```json
{
  "lockfileVersion": 1,
  "board": "uno",
  "platform": "atmelavr",
  "resolvedAt": "2026-06-28T00:00:00.000Z",
  "root": ["Adafruit NeoPixel@^1.10.0"],
  "packages": {
    "Adafruit NeoPixel": {
      "version": "1.12.0",
      "source": "arduino-index",
      "url": "https://downloads.arduino.cc/libraries/github.com/adafruit/Adafruit_NeoPixel-1.12.0.zip",
      "integrity": "sha256-<base64>",
      "cas": "deps/cas/ab/<sha256>.zip",
      "architectures": ["avr", "esp32", "rp2040", "*"],
      "dependencies": ["Adafruit Unified Sensor"]
    },
    "Adafruit Unified Sensor": {
      "version": "1.1.14",
      "source": "arduino-index",
      "url": "https://downloads.arduino.cc/libraries/github.com/adafruit/Adafruit_Unified_Sensor-1.1.14.zip",
      "integrity": "sha256-<base64>",
      "cas": "deps/cas/cd/<sha256>.zip",
      "architectures": ["*"],
      "dependencies": []
    }
  }
}
```

- `root` — the user's **direct** specs (version ranges they asked for).
- `packages` — the full **deduped transitive closure**, each entry pinned to one exact version
  with its integrity hash and CAS key.
- `board` / `platform` — captured so a lockfile is meaningful on its own and re-resolution can
  detect a board change.

`libraries.txt` remains the **human-editable list of direct deps**; `sparkbench.lock` is the
**generated, pinned artifact**. Never hand-edit the lock.

---

## 2. Content-Addressed Store (CAS)

Each library archive is stored **once**, keyed by the SHA-256 of its bytes — path-independent and
self-deduplicating (see the `content-hash-cache-pattern`).

- MinIO layout: `deps/cas/<sha256[:2]>/<sha256>.zip` (two-char shard prefix to avoid hot prefixes).
- A resolver metadata cache avoids re-hitting the network for already-seen `(name, version)` pairs.

### New table — `dependency_cache` (`lib/db/schema.ts`, Drizzle)

| Column | Type | Notes |
|---|---|---|
| `name` | text | part of PK |
| `version` | text | part of PK |
| `casKey` | text | `deps/cas/.../<sha256>.zip` |
| `integrity` | text | `sha256-<base64>` |
| `dependenciesJson` | jsonb | direct deps (names) |
| `architecturesJson` | jsonb | e.g. `["avr","rp2040","*"]` |
| `sentence` | text | short description (from index) |
| `sourceUrl` | text | original download URL |
| `resolvedAt` | timestamp | |

PK: `(name, version)`.

### Storage helpers (`lib/storage.ts`)

Add `uploadDep` / `downloadDep` / `hasDep` operating on the `deps/` prefix, mirroring the existing
`uploadFile` / `downloadFile` / `listProjectFiles` that work on `projects/{id}/`.

---

## 3. Resolver — browser-driven, server-executed

`lib/deps/resolver.ts`:

1. Parse direct specs (`name`, optional `@range`).
2. Semver range-resolve each against the Arduino Library Index.
3. Compute the **deduped transitive closure** (libraries' own `depends` field).
4. **Filter / annotate by the project's board architecture** — `projects.boardType` → platform →
   arch tag, reusing the existing `getPlatform()` helper. A lib whose `architectures` excludes the
   board's arch (and isn't `*`) surfaces as a **warning at resolve time**, not a build failure.
5. Emit the lockfile object.

Index access reuses the machinery behind `/api/libraries/search`, which already fetches and caches
`library_index.json`; add a resolution helper rather than re-fetching per request.

**Why server-executed:** resolution + archive download run on the server to (a) avoid browser CORS
against `downloads.arduino.cc`, and (b) centralize CAS writes.

### New route — `POST /api/deps/resolve`

Request: `{ board, specs: string[] }`
Flow:
1. Resolve specs → closure.
2. For each pinned `(name, version)` not already in `dependency_cache`: download archive, verify,
   store in CAS, upsert `dependency_cache`.
3. Return the assembled lockfile.

The browser package manager calls this, then persists the result (§4).

---

## 4. Persistence routes

`GET` / `PUT` `app/api/projects/[id]/lockfile/route.ts` — mirror the existing
`app/api/projects/[id]/libraries/route.ts` (handles both MinIO and local-dev). Keeps the lockfile a
first-class project file alongside `libraries.txt`.

---

## 5. Hermetic build integration

`app/api/projects/[id]/build/route.ts`:

- **When `sparkbench.lock` is present:** materialize each locked archive from CAS into a per-build
  `libdeps/` directory, then generate `platformio.ini` with:
  ```ini
  lib_deps =
  lib_extra_dirs = ./libdeps
  lib_ldf_mode = chain+      ; explicit, deterministic dependency discovery
  ```
  This is **hermetic** — no network resolution — and reuses the *exact* mechanism the sandbox
  already relies on (`lib_extra_dirs = /home/sandbox/.platformio/lib`, see `lib/sandbox.ts`).
- **When no lockfile:** the current auto-detect + `lib_deps` path is unchanged — fully backward
  compatible. Existing projects keep building.
- The `#include` → `HEADER_TO_LIB` auto-detect is **repurposed** from a build-time resolver into a
  **resolve-time seed**: it suggests specs to lock, but version resolution happens once, up front.

---

## 6. Export / Import — "ship project + used deps"

### `GET /api/projects/[id]/export`

Produces a portable, offline-rebuildable zip:

```
project/
  sketch.ino
  <other sources>
  diagram.json
  libraries.txt
  sparkbench.lock
  vendor/
    Adafruit NeoPixel/1.12.0/...
    Adafruit Unified Sensor/1.1.14/...
```

`vendor/` is reconstructed by extracting each locked archive from CAS. This is the literal
realization of "the server just ships the user's saved project along with the deps it used."

### `POST /api/projects/import`

Reads the bundle, repopulates CAS from `vendor/` (hashing to confirm integrity against the lock),
recreates the project row + files + lockfile. May reuse the existing copy flow
(`app/api/projects/copy/route.ts`).

---

## 7. Browser UI — extend `components/LibraryManager.tsx`

The component already exists. Extend it to:

- Search the index (existing `/api/libraries/search`).
- Add / remove **direct** deps (writes `libraries.txt`).
- "Resolve / Update" → `POST /api/deps/resolve` → write `sparkbench.lock` via the persistence route.
- Show **pinned versions** from the lockfile, integrity status, and **arch-compatibility warnings**
  for the current board.

---

## 8. AVR + RP2040 from day one

Arch-awareness is built into resolution, not bolted on:

- The lockfile records each package's `architectures`.
- Resolution filters/annotates against the project's board arch (`avr` for Uno/Nano/Mega,
  `rp2040` for Pico, etc.).
- A library that supports both `avr` and `rp2040` resolves correctly for either board; an
  incompatible one warns at resolve time.

---

## Implementation checklist (follow-up PR)

- [ ] `dependency_cache` table + migration (`lib/db/schema.ts`, `npm run db:push`).
- [ ] CAS helpers in `lib/storage.ts` (`uploadDep` / `downloadDep` / `hasDep`).
- [ ] `lib/deps/resolver.ts` (semver resolve + transitive closure + arch filter).
- [ ] `POST /api/deps/resolve`.
- [ ] `GET`/`PUT /api/projects/[id]/lockfile`.
- [ ] Build route: lockfile → `libdeps/` + `lib_extra_dirs` (hermetic), with fallback.
- [ ] `GET /api/projects/[id]/export`, `POST /api/projects/import`.
- [ ] `components/LibraryManager.tsx` UI.
- [ ] Tests: resolver (ranges, closure, arch filter), lockfile round-trip, hermetic build, export/import.

## Touch points (existing code)

- Build: `app/api/projects/[id]/build/route.ts`, `lib/sandbox.ts`
- Deps today: `app/api/projects/[id]/libraries/route.ts`, `/api/libraries/search`, `HEADER_TO_LIB`
- Model / storage: `lib/db/schema.ts`, `lib/storage.ts`, `lib/api.ts`, `lib/local-projects.ts`
- UI: `components/LibraryManager.tsx`
