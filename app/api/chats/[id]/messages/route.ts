import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/apps";
import { listMessages } from "@/lib/chats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return NextResponse.json({ messages: await listMessages(id) });
}

/** Append a message. Used for both the user's turn and the assistant's reply. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const supabase = serviceClient();

  const { error } = await supabase.from("chat_messages").insert({
    chat_id: id,
    role: body.role === "assistant" ? "assistant" : "user",
    content: String(body.content ?? ""),
    payload: body.payload ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Bump the thread so the list stays in most-recent order.
  await supabase.from("chats").update({ updated_at: new Date().toISOString() }).eq("id", id);
  return NextResponse.json({ ok: true });
}
