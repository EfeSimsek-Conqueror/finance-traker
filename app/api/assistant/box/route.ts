import { NextResponse } from "next/server";
import { draftBox, type BoxTurn } from "@/lib/ai/draft";

export const runtime = "nodejs";
/** One model round trip, plus Gemini's thinking time. */
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** Enough to hold the whole exchange; this conversation is meant to be short. */
const MAX_TURNS = 16;

/**
 * POST /api/assistant/box — one turn of the add-a-box conversation.
 *
 * Read-only by construction. It reads the app's board for context and answers
 * with either a question or a filled-in form; the writing still happens through
 * /api/resources and /api/connections, after a person has looked at the draft
 * and pressed the button. A route that both drafted and wrote would have been
 * fewer moving parts and exactly one fewer place where a human sees the figure.
 *
 * The transcript arrives with the request rather than living in a table. It is
 * worth keeping only until the box is added, and a chat that outlives the thing
 * it was about is clutter with a primary key.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    appId?: string;
    messages?: { role?: string; content?: string }[];
    /** The single-shot shape the first version took. Still honoured. */
    text?: string;
  };

  const turns: BoxTurn[] = (body.messages ?? [])
    .map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(m.content ?? "").trim(),
    }))
    .filter((m) => m.content)
    .slice(-MAX_TURNS);

  if (!turns.length && body.text?.trim()) {
    turns.push({ role: "user", content: body.text.trim() });
  }

  if (!body.appId || !turns.length) {
    return NextResponse.json({ error: "appId and a description are required" }, { status: 400 });
  }

  try {
    const result = await draftBox(body.appId, turns);
    // The cost of the turn is reported with the turn. This console exists to
    // show what things cost and its own assistant is not exempt — the same
    // spend also lands on fal's invoice, which the board reads on the next sync.
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
