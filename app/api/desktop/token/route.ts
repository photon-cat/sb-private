import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth-middleware";

/**
 * Desktop sign-in handoff endpoint.
 *
 * Called same-origin (with the session cookie) by the `/auth/desktop/complete`
 * bridge page after Google OAuth succeeds. Returns the raw session token, which
 * the desktop app (sb-parts) stores in the OS keychain and replays as
 * `Authorization: Bearer <token>` — the `bearer` plugin signs + verifies it.
 *
 * Not secret-bearing beyond the session itself: a caller must already hold a
 * valid session cookie to get anything back.
 */
export async function GET() {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    token: session.session.token,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? null,
    },
  });
}
