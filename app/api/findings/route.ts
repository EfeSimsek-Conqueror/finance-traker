import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/apps";
import { deriveFindings, deriveSuggestions } from "@/lib/findings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/findings?slug=… — what is wrong with this app right now.
 *
 * Fetched by the assistant rather than passed down as a prop: the panel is
 * mounted by the layout so it survives navigation, which means it outlives any
 * one page's props and has to ask for itself.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug) return NextResponse.json({ findings: [], suggestions: [] });

  const { data: app } = await serviceClient()
    .from("apps")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!app) return NextResponse.json({ findings: [], suggestions: [] });

  const [findings, suggestions] = await Promise.all([
    deriveFindings(app.id, slug),
    deriveSuggestions(app.id),
  ]);
  return NextResponse.json({ findings, suggestions });
}
