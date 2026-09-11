import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/apps";
import { syncConnection } from "@/lib/connectors/sync";

export const runtime = "nodejs";
/** Six connectors, each a network round trip to a different vendor. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST/GET /api/sync — re-read every connection.
 *
 * Without this the board is a photograph: every figure is frozen at the moment
 * its credential was pasted, and a finance screen showing yesterday as if it
 * were now is worse than one that admits it is empty. `connections.last_sync_at`
 * already drives a stale badge; this is what keeps it green honestly.
 *
 * One vendor failing does not stop the rest. A connector that errors records
 * its own failure and the board shows it as an error, which is the correct
 * outcome — a broken reading must never be silently replaced by an old one.
 */
export async function POST(request: Request) {
  return run(request);
}

/** Vercel Cron issues a GET. */
export async function GET(request: Request) {
  return run(request);
}

async function run(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get("authorization");
    const header = request.headers.get("x-cron-secret");
    if (auth !== `Bearer ${expected}` && header !== expected) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabase = serviceClient();
  const { data: conns } = await supabase.from("connections").select("id, vendor");
  if (!conns?.length) return NextResponse.json({ ok: true, synced: 0, results: [] });

  // Sequential on purpose: six vendors is not worth the concurrency, and a
  // burst of parallel requests is how you find a vendor's own rate limit.
  const results = [];
  for (const c of conns) results.push(await syncConnection(c.id));

  const failed = results.filter((r) => !r.ok);
  return NextResponse.json(
    {
      ok: failed.length === 0,
      synced: results.length - failed.length,
      failed: failed.length,
      results,
    },
    { status: failed.length && failed.length === results.length ? 502 : 200 },
  );
}
