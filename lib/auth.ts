import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, bearer } from "better-auth/plugins";
import { db } from "./db";
import * as schema from "./db/schema";

// Origins allowed to drive sign-in / receive redirects. The desktop app (sb-parts)
// completes OAuth in the system browser and the bridge hands the session token off
// to a localhost loopback listener (RFC 8252), so loopback origins must be trusted.
// Any future parts website origin gets added here too — one issuer, many clients.
const trustedOrigins = [
  process.env.BETTER_AUTH_URL || "https://sparkbench.ai",
  "http://localhost:*",
  "http://127.0.0.1:*",
];

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      jwks: schema.jwks,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins,
  // jwt()    → GET /api/auth/token (short-lived signed JWT w/ user claims) and a
  //            public JWKS at /api/auth/jwks so edge validators (the parts Worker)
  //            can verify tokens statelessly — no DB access, no shared secret.
  // bearer() → accept `Authorization: Bearer <session-token>` on the auth API for
  //            clients without cookies (the desktop app). A raw session token is
  //            signed + verified server-side, so the desktop can store just the token.
  plugins: [jwt(), bearer()],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh every 24 hours
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
});
