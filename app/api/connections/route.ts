import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/apps";
import { syncConnection } from "@/lib/connectors/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const appId = new URL(request.url).searchParams.get("app_id");
  if (!appId) return NextResponse.json({ error: "app_id required" }, { status: 400 });

  const { data } = await serviceClient()
    .from("connections")
    .select("id, vendor, label, status, last_sync_at, last_error")
    .eq("app_id", appId)
    .order("vendor");

  return NextResponse.json({ connections: data ?? [] });
}

/**
 * POST /api/connections — attach a vendor credential to an app.
 *
 * Syncs immediately rather than waiting for a schedule: pasting a key and being
 * told nothing happened is the worst moment to leave someone guessing, and a
 * failure here is nearly always a wrong or under-scoped key, which is exactly
 * what the caller can still fix while the dialog is open.
 */
export async function POST(request: Request) {
  const { appId, vendor, secret, label } = await request.json();
  if (!appId || !vendor || !secret) {
    return NextResponse.json({ error: "appId, vendor and secret required" }, { status: 400 });
  }

  const supabase = serviceClient();
  const { data, error } = await supabase
    .from("connections")
    .upsert(
      { app_id: appId, vendor, secret, label: label ?? null, status: "pending" },
      { onConflict: "app_id,vendor" },
    )
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result = await syncConnection(data.id);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
