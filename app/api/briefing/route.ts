import { NextResponse } from "next/server";
import { listApps, serviceClient } from "@/lib/apps";
import { generateBriefing, type BriefingRun } from "@/lib/briefing";

export const runtime = "nodejs";
/** One model run per app, each several tool round trips deep. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET/POST /api/briefing — write today's note.
 *
 * GET is the 04:35 UTC cron: every app, sequentially. POST is the card's
 * Rewrite button: one app, optionally over a row that already exists.
 *
 * It reads the board; it does not sync it. A briefer that synced first would
 * turn a vendor outage into its own failure, when the far more useful outcome is
 * a note saying the board has not synced since yesterday. Freshness is an input
 * it reports on, not a dependency it owns — which is also why the cron sits
 * eighteen minutes behind /api/sync rather than chaining to it.
 */
export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const apps = await listApps();
  const results: (BriefingRun & { app: string })[] = [];
  // Sequential for the same reason /api/sync is: a burst of parallel model runs
  // is how you find fal's rate limit, and there are two apps.
  for (const app of apps) {
    results.push({ app: app.slug, ...(await generateBriefing(app.id)) });
  }
  return NextResponse.json(summarise(results));
}

export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => ({}))) as {
    appId?: string;
    slug?: string;
    force?: boolean;
  };

  const appId = body.appId ?? (body.slug ? await idForSlug(body.slug) : null);
  if (!appId) {
    return NextResponse.json({ error: "appId or slug required" }, { status: 400 });
  }

  const run = await generateBriefing(appId, { force: body.force === true });
  return NextResponse.json(summarise([{ app: body.slug ?? appId, ...run }]));
}

async function idForSlug(slug: string): Promise<string | null> {
  const { data } = await serviceClient()
    .from("apps")
    .select("id")
    .eq("slug", slug.toLowerCase())
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** Same shape as /api/sync's: unset CRON_SECRET leaves the route open locally. */
function unauthorized(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) return null;
  const auth = request.headers.get("authorization");
  const header = request.headers.get("x-cron-secret");
  if (auth === `Bearer ${expected}` || header === expected) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * `ok` is about the route, not about the notes.
 *
 * A run that skipped because nothing is measured, or because today's note was
 * already written, did exactly what it should. Only a broken generator is a
 * failure, so only `failed` and `rejected` count against it — and a rejected
 * note is reported rather than swallowed, because a model quoting figures nobody
 * measured is the one thing this endpoint exists to catch.
 */
function summarise(results: (BriefingRun & { app: string })[]) {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return {
    ok: count("failed") + count("rejected") === 0,
    written: count("ok"),
    skipped: count("skipped") + count("unchanged"),
    failed: count("failed") + count("rejected"),
    costUsd: results.reduce((t, r) => t + r.costUsd, 0),
    results: results.map((r) => ({
      app: r.app,
      status: r.status,
      reason: r.reason,
      costUsd: r.costUsd,
      headline: r.briefing?.headline ?? null,
      body: r.briefing?.body ?? null,
      tone: r.briefing?.tone ?? null,
      cites: r.briefing?.cites ?? null,
      comparedTo: r.briefing?.comparedTo ?? null,
      toolCalls: r.briefing?.toolCalls ?? null,
    })),
  };
}
