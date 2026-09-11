import { NextResponse } from "next/server";
import { loadThresholds, saveThresholds } from "@/lib/settings";
import { serviceClient } from "@/lib/apps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — the thresholds the board is colouring by right now. */
export async function GET() {
  return NextResponse.json({ thresholds: await loadThresholds() });
}

/**
 * PATCH — retune what counts as trouble, or set an app's monthly budget.
 *
 * Partial by design: sending one field must not reset the others to defaults.
 */
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "expected a JSON object" }, { status: 400 });
  }

  const { budget, ...thresholds } = body as Record<string, unknown> & {
    budget?: { appId?: string; slug?: string; usd?: number | null };
  };

  if (budget && (budget.appId || budget.slug)) {
    const db = serviceClient();
    let appId = budget.appId;
    if (!appId && budget.slug) {
      const { data } = await db.from("apps").select("id").eq("slug", budget.slug).maybeSingle();
      appId = data?.id;
    }
    if (!appId) return NextResponse.json({ error: "no such app" }, { status: 404 });
    await db
      .from("apps")
      .update({ budget_usd: budget.usd == null ? null : Number(budget.usd) })
      .eq("id", appId);
  }

  const saved = await saveThresholds(thresholds as never);
  return NextResponse.json({ thresholds: saved });
}
