import { NextResponse } from "next/server";
import { draftBox } from "@/lib/ai/draft";

export const runtime = "nodejs";
/** One model round trip, plus Gemini's thinking time. */
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * POST /api/assistant/box — draft a box from a sentence.
 *
 * Read-only by construction. It reads the app's board for context and returns a
 * filled-in form; the writing still happens through /api/resources and
 * /api/connections, after a person has looked at the draft and pressed the
 * button. Adding a route that both drafts and writes would have been fewer
 * moving parts and exactly one fewer place where a human sees the figure.
 */
export async function POST(request: Request) {
  const { appId, text } = (await request.json().catch(() => ({}))) as {
    appId?: string;
    text?: string;
  };

  if (!appId || !text?.trim()) {
    return NextResponse.json({ error: "appId and a description are required" }, { status: 400 });
  }

  try {
    const { draft, why, check, costUsd } = await draftBox(appId, text.trim());
    // The cost of the draft is reported with the draft. This console exists to
    // show what things cost and its own assistant is not exempt — the same
    // spend also lands on fal's invoice, which the board reads on the next sync.
    return NextResponse.json({ draft, why, check, costUsd });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
