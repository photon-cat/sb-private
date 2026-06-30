"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Desktop sign-in bridge — step 1 (initiate).
 *
 * The sb-parts desktop app opens the system browser to
 *   https://sparkbench.ai/auth/desktop?port=<loopback>&state=<nonce>
 * This page kicks off Google OAuth and asks Better-Auth to land back on the
 * companion `/auth/desktop/complete` page (carrying port+state), which then
 * hands the session token to the app's loopback listener.
 *
 * Google itself only ever redirects to sparkbench.ai (its configured redirect
 * URI is unchanged) — the local hop happens entirely on our origin.
 */
export default function DesktopAuthInitiate() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const port = params.get("port") ?? "";
    const state = params.get("state") ?? "";

    if (!/^\d+$/.test(port) || !state) {
      setError("Missing or invalid sign-in parameters. Please retry from the app.");
      return;
    }

    const callbackURL = `/auth/desktop/complete?port=${encodeURIComponent(
      port,
    )}&state=${encodeURIComponent(state)}`;

    authClient
      .signIn.social({ provider: "google", callbackURL })
      .catch((e) => setError(e?.message ?? "Failed to start sign-in."));
  }, []);

  return (
    <main style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 18, margin: 0 }}>SparkBench Parts</h1>
        <p style={{ color: "#555", marginTop: 12 }}>
          {error ?? "Redirecting you to Google to sign in…"}
        </p>
      </div>
    </main>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  fontFamily: "system-ui, sans-serif",
  background: "#fafafa",
};
const card: React.CSSProperties = {
  textAlign: "center",
  padding: "32px 40px",
  borderRadius: 12,
  background: "#fff",
  boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
};
