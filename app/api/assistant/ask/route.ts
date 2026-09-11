import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/apps";
import { ask } from "@/lib/ai/agent";
import { groundFollowups } from "@/lib/ai/grounding";
import type { ChatMessage } from "@/lib/ai/fal";

export const runtime = "nodejs";
/** A tool round trip plus Gemini's thinking time; the default would cut it short. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Enough context to follow a conversation without resending an afternoon of it. */
const HISTORY_TURNS = 12;

/**
 * POST /api/assistant/ask — one turn of the conversation.
 *
 * The model narrates; the tools measure. Nothing it says about money reaches
 * the screen without having come back from a tool call first, which is what
 * lets a language model sit on a finance console at all.
 */
export async function POST(request: Request) {
  const { chatId, prompt } = await request.json();
  if (!chatId || !prompt) {
    return NextResponse.json({ error: "chatId and prompt required" }, { status: 400 });
  }

  const supabase = serviceClient();
  await supabase.from("chat_messages").insert({ chat_id: chatId, role: "user", content: prompt });

  const { data: past } = await supabase
    .from("chat_messages")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_TURNS + 1);

  // Newest-first for the limit, oldest-first for the model, and drop the turn
  // we just wrote — it is passed separately as the prompt.
  const history = ((past ?? []).slice(1).reverse() as { role: string; content: string }[])
    .filter((m) => m.content)
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }) as ChatMessage);

  try {
    const result = await ask(history, String(prompt));
    // A follow-up is a button, not a sentence: whatever it says gets sent back
    // as the next prompt, so a name the model invented has to be caught here.
    const followups = await groundFollowups(result.followups);

    await supabase.from("chat_messages").insert({
      chat_id: chatId,
      role: "assistant",
      content: result.reply,
      payload: result.blocks?.length ? result.blocks : null,
      // Persisted with the turn they belong to, so reopening a thread restores
      // the conversation's own suggestions rather than the cold-start four.
      followups: followups.length ? followups : null,
    });
    await supabase.from("chats").update({ updated_at: new Date().toISOString() }).eq("id", chatId);

    return NextResponse.json({
      reply: result.reply,
      payload: result.blocks,
      followups,
      // Surfaced rather than hidden: this console exists to show what things
      // cost, and it would be a poor joke for its own assistant to be the one
      // untracked line. The spend also lands on fal's invoice, so the board
      // picks it up on the next sync either way.
      costUsd: result.costUsd,
      tools: result.toolsUsed,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const reply = `I could not reach the model: ${message}`;
    await supabase.from("chat_messages").insert({ chat_id: chatId, role: "assistant", content: reply });
    return NextResponse.json({ reply, payload: null, error: message }, { status: 502 });
  }
}
