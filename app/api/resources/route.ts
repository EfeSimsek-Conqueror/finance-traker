import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/apps";
import { manualByKind } from "@/lib/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/resources — state a box by hand.
 *
 * The other half of the add flow. Some costs will never have a connector — a
 * domain renewal, a contractor's monthly invoice, a ceiling someone was told
 * about on a support call — and leaving them off the board makes the totals
 * look complete when they are not, which is the one failure this console exists
 * to avoid.
 *
 * Everything written here carries `source: "manual"`, and the board renders
 * that differently on purpose: a figure a person typed and a figure a vendor
 * answered with are not the same kind of fact, and the row has to say which.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });

  const appId = String(body.appId ?? "");
  const kind = String(body.kind ?? "");
  const name = String(body.name ?? "").trim();
  const vendor = String(body.vendor ?? "").trim();
  const note = String(body.note ?? "").trim();

  if (!appId) return NextResponse.json({ error: "appId required" }, { status: 400 });
  const spec = manualByKind(kind);
  if (!spec) return NextResponse.json({ error: `no box of kind "${kind}"` }, { status: 400 });
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!vendor) return NextResponse.json({ error: "vendor required" }, { status: 400 });

  /** Blank means unknown and must stay unknown; 0 is a reading and must survive. */
  const number = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const monthly = number(body.monthly_usd);
  const cap = number(body.cap);
  const used = number(body.used);

  if (spec.asks.includes("monthly") && monthly == null) {
    return NextResponse.json({ error: "a monthly figure is required for this kind" }, { status: 400 });
  }
  if (spec.asks.includes("ceiling") && cap == null) {
    return NextResponse.json({ error: "a ceiling is required for this kind" }, { status: 400 });
  }

  const supabase = serviceClient();

  // Sort is per app and only orders rows within a kind, so the newest hand-
  // stated row landing last is the whole requirement.
  const { data: siblings } = await supabase.from("resources").select("sort").eq("app_id", appId);
  const sort = (siblings ?? []).reduce((m, r) => Math.max(m, r.sort ?? 0), 0) + 1;

  const { data, error } = await supabase
    .from("resources")
    .insert({
      app_id: appId,
      kind,
      name,
      vendor,
      source: "manual",
      unit: kind === "metered" ? String(body.unit ?? "").trim() || null : null,
      cap,
      // A ceiling with no reading is the honest state of most stated ceilings —
      // someone knows the limit, nothing counts against it. The board draws
      // "? / cap" for exactly this and must not be handed a zero instead.
      used: kind === "metered" ? used : null,
      reset_label: String(body.reset_label ?? "").trim() || null,
      mtd_usd: kind === "metered" ? null : monthly,
      run_rate_usd: null,
      // Colour is decided on every render from thresholds, not stored. What is
      // stored is the one state no threshold can compute: a ceiling nothing is
      // counting cannot be green, amber or red, it can only be unknown.
      status: kind === "metered" && used == null ? "unknown" : "neutral",
      projection: null,
      projection_note: note || null,
      is_sample: false,
      sort,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}

/**
 * DELETE /api/resources?id= — take a hand-stated box off the board.
 *
 * Only manual rows. A vendor's own row belongs to its connector and would come
 * straight back on the next sync, so deleting one from here would look like a
 * bug in the board rather than what it is.
 */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = serviceClient();
  const { data: row } = await supabase.from("resources").select("source").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "no such row" }, { status: 404 });
  if (row.source !== "manual") {
    return NextResponse.json(
      { error: `that row comes from ${row.source} — remove the connection instead` },
      { status: 409 },
    );
  }

  const { error } = await supabase.from("resources").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
