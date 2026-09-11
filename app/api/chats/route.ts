import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/apps";
import { listChats, titleFromPrompt } from "@/lib/chats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ chats: await listChats() });
}

/**
 * Create a thread.
 *
 * Titled from the first prompt at creation time — there is no "untitled chat"
 * state, because a list of untitled chats is a list you cannot use.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "prompt required" }, { status: 400 });

  const { data, error } = await serviceClient()
    .from("chats")
    .insert({ title: titleFromPrompt(prompt) })
    .select("id, title, updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ chat: data });
}
