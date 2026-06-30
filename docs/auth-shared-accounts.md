# Shared accounts — one issuer, many validators

SparkBench has **one account system**. The circuit-sim backend in this repo
(sb-elec, `sparkbench.ai`) runs **Better-Auth** (Postgres + Drizzle, Google
OAuth) and is the **sole owner of the user database**. Every other surface — the
**sb-parts desktop app**, the parts **edge Worker**, and any future parts website
— is a **client and/or validator only**. None of them touch the auth Postgres.

```
sb-elec Better-Auth (ISSUER, owns Postgres)      sb-parts desktop (CLIENT)      parts Worker (VALIDATOR)
  /api/auth/*  (Google OAuth, sessions)            Google sign-in in browser      verify JWT via JWKS
  + jwt()    → /api/auth/token + JWKS              session token → OS keychain    GET /whoami (proves path)
  + bearer() → Authorization: Bearer <session>     mints short-lived JWTs          (gates nothing yet)
  /auth/desktop bridge → hands token to loopback   sends JWT to edge APIs
```

> **Scope today:** this is the auth *foundation*. It establishes identity but
> **gates no feature** — catalog downloads stay public and the dev channel keeps
> its shared `DEV_TOKEN`. Feature-gating (dev-by-login, saved projects/sync) comes
> later and only adds checks; it does not change this topology.

## What lives in this repo (the issuer)

- **`lib/auth.ts`** — `plugins: [jwt(), bearer()]`.
  - `jwt()` publishes a **JWKS** at `GET /api/auth/jwks` and mints signed JWTs at
    `GET /api/auth/token`. Validators verify tokens statelessly against the JWKS —
    no DB access, no shared secret.
  - `bearer()` accepts `Authorization: Bearer <session-token>` for clients with no
    cookies (the desktop app). A raw session token is signed + verified
    server-side, so the desktop only needs to store the token.
  - `trustedOrigins` includes `http://localhost:*` / `http://127.0.0.1:*` for the
    desktop loopback handoff (add a parts-site origin here when it ships).
- **`lib/db/schema.ts`** — the `jwks` keystore table (declared for Drizzle; the
  signing key pair is managed by Better-Auth). `deploy.sh` runs
  `drizzle-kit push --force`, so a redeploy creates it.
- **Desktop sign-in bridge** (Google only ever redirects to `sparkbench.ai`; the
  local hop happens entirely on our origin):
  - `app/auth/desktop/page.tsx` — reads `?port=&state=`, starts Google OAuth with
    `callbackURL=/auth/desktop/complete?...`.
  - `app/auth/desktop/complete/page.tsx` — session cookie is now set; fetches the
    raw session token and redirects to `http://127.0.0.1:<port>/callback?token=…&state=…`.
  - `app/api/desktop/token/route.ts` — same-origin endpoint returning
    `session.token` (+ basic user) for a cookie-authenticated caller.

Secrets (`BETTER_AUTH_SECRET`, `GOOGLE_*`, `DATABASE_URL`) are unchanged and stay
in this repo's env.

## How a validator verifies a token

Fetch the JWKS once (cache it), then verify signature + `exp` + `iss`:

```
iss / JWKS issuer:  https://sparkbench.ai
JWKS URL:           https://sparkbench.ai/api/auth/jwks
token endpoint:     https://sparkbench.ai/api/auth/token   (Authorization: Bearer <session>)
```

The parts Worker does exactly this with `jose` (`createRemoteJWKSet` + `jwtVerify`)
— see `sb-parts-db/worker/` and the desktop client in `sparkbench-parts`.

## Verify after deploy

```bash
curl https://sparkbench.ai/api/auth/jwks        # → a JWKS (keys array)
# web Google sign-in still works; a row exists in the `jwks` table
```

## Notes / deferred

- The loopback token handoff is local + ephemeral (RFC 8252). Hardening
  (one-time code instead of token-in-URL, refresh-token rotation) is deferred.
- A parts website reuses this same issuer — just add its origin to
  `trustedOrigins`. No second Better-Auth, ever, on this database.
