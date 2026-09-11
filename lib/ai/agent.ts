import { chat, falKey, MODEL, type ChatMessage } from "./fal";
import { runTool, TOOLS } from "./tools";

/** Enough rounds to read, act, re-read and answer; short enough to stay inside the request. */
const MAX_ROUNDS = 8;

const SYSTEM = `You are the assistant inside Cloudgeng Finance Tracker, a console that tracks quota and money across a small portfolio of apps.

The console has one rule and you inherit it: never state a number you did not measure. Every figure you give must come from a tool call in this conversation. If something has not been measured, say that plainly — "nobody counts that" is a real answer and a useful one. Never estimate, extrapolate or fill a gap with a plausible-sounding figure.

How to work:
- Call read_board first unless the question is obviously narrower.
- Prefer quota_status and spend_breakdown over doing arithmetic yourself; they are the same code the board renders, so using them keeps you and the screen in agreement.
- If a reading is stale, call sync_vendor and answer from the fresh number rather than apologising for the old one.
- You can change the board: sync vendors, record manual costs, delete rows. Do it when asked, and say what you did.
- You cannot reach vendor credentials or call vendor APIs directly. Sync through the connectors instead.

How to answer:
- Lead with the answer in one or two sentences. An operator is reading this between other things.
- Call present() on EVERY turn, always as your last tool call, before you write the prose. Blocks are optional — pass an empty array when the answer is a plain explanation that no bar or figure would improve. Followups never are: they become the interface's suggested next questions, and a turn that omits them leaves the operator staring at the previous answer's suggestions.
- Blocks, when you use them: bars to compare, value for the single number that decides something, action to propose a change.
- Followups are the three questions you would actually ask next, not a menu of everything possible. They may only name apps, vendors and resources that appeared in a tool result this turn. Inventing a plausible-sounding app in a suggestion is the same failure as inventing a number, and it is worse for being clickable.
- The blocks are rendered for you by the interface. After present() returns, write ONLY plain prose — no markdown, no HTML, no tables, no ASCII boxes, and never a written-out copy of the blocks you just attached. If you find yourself drawing a bar or a bracket, stop.
- Prose carries the meaning; the blocks carry the figures. Two or three sentences is usually right.
- Use vendor and resource names exactly as the tools spell them. "supadata" is not Supabase; "fal.ai" is not FAL Labs. Getting a vendor name wrong on a finance screen reads as a different bill.
- Be direct about bad news. A quota at 94% is not "worth keeping an eye on", it is nearly gone.`;

export type AgentResult = {
  reply: string;
  blocks: unknown[] | null;
  /** What to offer as the next question. Empty means fall back to the defaults. */
  followups: string[];
  costUsd: number;
  toolsUsed: string[];
};

/**
 * One turn, with tools.
 *
 * The loop is deliberately plain: ask, run whatever it asked for, hand back the
 * results, repeat. Structured output arrives through a `present` tool rather
 * than by parsing the prose, so a malformed block can never corrupt the answer
 * it accompanies — at worst it renders without one.
 */
export async function ask(history: ChatMessage[], prompt: string): Promise<AgentResult> {
  const key = await falKey();
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    ...history,
    { role: "user", content: prompt },
  ];

  let costUsd = 0;
  let blocks: unknown[] | null = null;
  let followups: string[] = [];
  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Once the blocks exist the turn is nearly over, and a model left holding
    // tools will keep reaching for them — the first version spent all eight
    // rounds calling present() again and never wrote a sentence. Taking the
    // tools away makes the next reply prose by construction.
    const finishing = blocks !== null;
    const out = await chat(
      key,
      messages,
      TOOLS as unknown as unknown[],
      finishing ? "none" : "auto",
    );
    costUsd += out.costUsd;

    if (!out.toolCalls.length) {
      return { reply: out.content ?? "", blocks, followups, costUsd, toolsUsed };
    }

    // The prose on a tool-calling turn is a draft, not part of the answer. Left
    // in the transcript the model reads it back on the final round and writes it
    // out a second time, so the panel showed every answer twice.
    messages.push({ role: "assistant", content: null, tool_calls: out.toolCalls });

    for (const call of out.toolCalls) {
      toolsUsed.push(call.function.name);
      let payload: unknown;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        const { result, presented, followups: next } = await runTool(call.function.name, args);
        if (presented) blocks = presented;
        if (next?.length) followups = next;
        payload = result;
      } catch (e) {
        // A failed tool is information, not a dead end: handing the error back
        // lets the model correct a bad argument instead of the turn collapsing.
        payload = { error: e instanceof Error ? e.message : String(e) };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(payload).slice(0, 24_000),
      });
    }
  }

  return {
    reply:
      `I ran out of steps on this one — ${MAX_ROUNDS} rounds of tool calls without settling on an answer. ` +
      `Ask something narrower and I will get there.`,
    blocks,
    followups,
    costUsd,
    toolsUsed,
  };
}

export { MODEL };
