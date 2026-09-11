import { NextResponse } from "next/server";
import { loadLayout, resetLayout, saveNode } from "@/lib/settings";
import { serviceClient } from "@/lib/apps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveApp(appId?: string, slug?: string): Promise<string | null> {
  if (appId) return appId;
  if (!slug) return null;
  const { data } = await serviceClient().from("apps").select("id").eq("slug", slug).maybeSingle();
  return data?.id ?? null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const appId = await resolveApp(
    url.searchParams.get("appId") ?? undefined,
    url.searchParams.get("slug") ?? undefined,
  );
  if (!appId) return NextResponse.json({ error: "appId or slug required" }, { status: 400 });
  return NextResponse.json({ layout: await loadLayout(appId) });
}

/**
 * PATCH — remember where a node was dragged or how it was resized.
 *
 * One node per call, because that is how the gesture arrives: a drag ends, one
 * card moved, and nothing else on the board should be rewritten by it.
 */
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const { appId, slug, nodeKey, x, y, w, h } = (body ?? {}) as Record<string, never>;

  const id = await resolveApp(appId, slug);
  if (!id || !nodeKey) {
    return NextResponse.json({ error: "appId/slug and nodeKey required" }, { status: 400 });
  }

  await saveNode(id, String(nodeKey), { x, y, w, h });
  return NextResponse.json({ layout: await loadLayout(id) });
}

/** DELETE — put a node, or the whole board, back where the layout puts it. */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = await resolveApp(
    url.searchParams.get("appId") ?? undefined,
    url.searchParams.get("slug") ?? undefined,
  );
  if (!id) return NextResponse.json({ error: "appId or slug required" }, { status: 400 });
  await resetLayout(id, url.searchParams.get("nodeKey") ?? undefined);
  return NextResponse.json({ ok: true, layout: await loadLayout(id) });
}
