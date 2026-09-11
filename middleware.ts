import { NextResponse, type NextRequest } from "next/server";
import { readSession, SESSION_COOKIE } from "@/lib/auth";

/**
 * Nothing is reachable without a session.
 *
 * Deny by default, with a named list of exceptions, rather than protecting
 * routes one at a time: every API route here holds the service-role key, and
 * the assistant can sync vendors, write costs and delete rows. A route added
 * later is protected because it was not exempted, which is the only ordering
 * that survives someone forgetting.
 */
const PUBLIC = ["/login", "/api/auth"];  // /api/auth covers the passkey steps,
// which do their own session check where one is required — registering a device
// needs a session, signing in with one obviously cannot have it yet.

/** The scheduled sync authenticates with its own secret, not a browser session. */
const CRON = ["/api/sync", "/api/briefing"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();

  if (CRON.some((p) => pathname.startsWith(p))) {
    const secret = process.env.CRON_SECRET;
    const auth = request.headers.get("authorization");
    if (secret && (auth === `Bearer ${secret}` || request.headers.get("x-cron-secret") === secret)) {
      return NextResponse.next();
    }
    // No cron secret on the request: fall through to the session check, so a
    // signed-in operator can still trigger a sync by hand.
  }

  const who = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (who) return NextResponse.next();

  // An API caller gets a status it can act on; a browser gets the form.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const to = request.nextUrl.clone();
  to.pathname = "/login";
  to.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(to);
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
