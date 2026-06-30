"use client";

import { useEffect, useState } from "react";

/**
 * Desktop sign-in bridge — step 2 (complete).
 *
 * Reached after Google OAuth succeeds, so the session cookie is now set on this
 * origin. We fetch the raw session token same-origin and hand it to the app's
 * loopback listener at http://127.0.0.1:<port>/callback?token=…&state=…
 * (RFC 8252). The app verifies `state`, stores the token in the OS keychain, and
 * closes the loop. The token only ever travels over localhost.
 */
export default function DesktopAuthComplete() {
  const [status, setStatus] = useState("Finishing sign-in…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const port = params.get("port") ?? "";
    const state = params.get("state") ?? "";

    if (!/^\d+$/.test(port) || !state) {
      setStatus("Invalid sign-in parameters. Please retry from the app.");
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/desktop/token", { credentials: "same-origin" });
        if (!res.ok) {
          setStatus("Sign-in did not complete. Please retry from the app.");
          return;
        }
        const { token } = (await res.json()) as { token: string };
        const url = `http://127.0.0.1:${port}/callback?token=${encodeURIComponent(
          token,
        )}&state=${encodeURIComponent(state)}`;
        setStatus("Signed in! Returning to the app…");
        window.location.replace(url);
      } catch {
        setStatus("Could not reach the app. You can close this window and retry.");
      }
    })();
  }, []);

  return (
    <main style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 18, margin: 0 }}>SparkBench Parts</h1>
        <p style={{ color: "#555", marginTop: 12 }}>{status}</p>
        <p style={{ color: "#999", fontSize: 13, marginTop: 8 }}>
          You can close this window once the app shows you’re signed in.
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
