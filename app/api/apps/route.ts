import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/apps";

export const runtime = "nodejs";

const TILE = 300;
const GAP = 140;

/** Slug from a display name: lowercase, alphanumeric, dash-separated. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * POST /api/apps — add an app to the board.
 *
 * Multipart because a logo comes with it. The upload goes to the public
 * `app-logos` bucket keyed by slug, so re-adding an app with the same name
 * replaces its logo rather than accumulating orphans.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }

  const slug = slugify(name);
  if (!slug) {
    return NextResponse.json({ error: "name has no usable characters" }, { status: 400 });
  }

  const supabase = serviceClient();

  // Place the new tile to the right of the rightmost one, on its row, so the
  // board grows in a predictable direction instead of stacking at the origin.
  const { data: existing } = await supabase.from("apps").select("x, y");
  const x = existing?.length ? Math.max(...existing.map((a) => a.x)) + TILE + GAP : 160;
  const y = existing?.length ? Math.min(...existing.map((a) => a.y)) : 200;

  let logoUrl: string | null = null;
  const logo = form.get("logo");
  if (logo instanceof File && logo.size > 0) {
    const ext = (logo.name.split(".").pop() || "png").toLowerCase();
    const path = `${slug}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("app-logos")
      .upload(path, await logo.arrayBuffer(), {
        contentType: logo.type || "image/png",
        upsert: true,
      });
    if (upErr) {
      return NextResponse.json({ error: `logo upload failed: ${upErr.message}` }, { status: 500 });
    }
    logoUrl = supabase.storage.from("app-logos").getPublicUrl(path).data.publicUrl;
  }

  const { error } = await supabase
    .from("apps")
    .insert({ slug, name, logo_url: logoUrl, x, y, stack: [] });

  if (error) {
    const conflict = error.code === "23505";
    return NextResponse.json(
      { error: conflict ? `"${name}" is already on the board` : error.message },
      { status: conflict ? 409 : 500 },
    );
  }

  return NextResponse.json({ ok: true, slug });
}
