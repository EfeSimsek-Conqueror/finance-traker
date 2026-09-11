import { NextResponse } from "next/server";
import { parseIncoming, recordCrash, resolveApp } from "@/lib/crashes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ingest/crashlytics — a crash, pushed rather than polled.
 *
 * Crashlytics has no API that will hand over crash data; the only things that
 * leave Firebase on their own are its alerts. So this is the one reading on the
 * board that arrives instead of being fetched, and the shape follows from that:
 * a Cloud Function in the Firebase project normalises the alert and posts it
 * here. Keeping the mapping on their side means this route validates one schema
 * we control, not five the SDK may reshape.
 *
 * The secret is checked here as well as in middleware. Middleware is a routing
 * concern and can be reconfigured by a matcher edit; a route holding the
 * service-role key should not depend on that to stay shut.
 */
export async function POST(request: Request) {
  const expected = process.env.INGEST_SECRET;
  if (!expected) {
    // Refuse rather than accept everything. An ingest endpoint that is open
    // because a variable is missing writes whatever it is sent onto the board.
    return NextResponse.json({ error: "INGEST_SECRET is not set" }, { status: 503 });
  }
  const given = request.headers.get("x-ingest-secret") ?? "";
  if (given !== expected) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body is not json" }, { status: 400 });
  }

  const parsed = parseIncoming(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.why }, { status: 400 });

  const app = await resolveApp(parsed.crash);
  if (!app) {
    // 200, not 404. Firebase retries a failure, and a crash from an app nobody
    // has mapped yet would retry forever. It is dropped, and the response says
    // exactly that so the function's log shows a named app going nowhere
    // instead of a webhook that looks like it is working.
    return NextResponse.json({
      ok: false,
      stored: false,
      reason: "no app maps this firebase app id",
      firebaseAppId: parsed.crash.firebaseAppId ?? null,
    });
  }

  const result = await recordCrash(app.id, parsed.crash);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.message }, { status: 500 });

  return NextResponse.json({ ok: true, stored: true, app: app.slug, what: result.message });
}
