import { serviceClient } from "@/lib/apps";
import { chat, falKey, type ChatMessage } from "./fal";
import { MANUAL, VENDORS, manualByKind, vendorById, type ManualKind } from "@/lib/sources";

/**
 * The assistant filling in the add-a-box form.
 *
 * It drafts; it does not write. The model works out which of the three
 * questions the operator has already answered — what kind of box this is, what
 * it is, what it needs — and the answer lands in the same form, behind the same
 * submit button, with the same server-side validation. Nothing reaches the
 * board that a person did not look at and press a button on.
 *
 * That division is not caution for its own sake. The board's one rule is that a
 * figure it shows was measured, and a model is exactly the thing that will
 * cheerfully supply "Cloudflare Pro, $20/month" from memory — a number that is
 * plausible, frequently correct, and not a measurement of anything. So the
 * prompt allows transcription and forbids recall: a figure may be copied out of
 * what the operator wrote and may come from nowhere else. What it copied is
 * listed back in `check`, on screen, above the button.
 *
 * It is a conversation rather than one shot because the first version was not
 * one. "add the analytics thing" is not enough to choose a shape, and a model
 * given no way to ask is a model that guesses or fails — ours failed, with
 * "could not settle on a shape", which told the operator nothing about what it
 * was missing. Now it either settles or asks, and asking is a first-class
 * outcome rather than an error.
 */

export type BoxTurn = { role: "user" | "assistant"; content: string };

export type BoxDraft = {
  family: "vendor" | "manual";
  /** For a vendor draft: which one, by catalogue id. */
  vendor: string;
  kind?: ManualKind;
  name?: string;
  monthly_usd?: number;
  cap?: number;
  unit?: string;
  used?: number;
  reset_label?: string;
  note?: string;
};

export type DraftResult =
  /** Not enough to settle. One question, in the model's own words. */
  | { kind: "ask"; question: string; costUsd: number }
  | {
      kind: "draft";
      draft: BoxDraft;
      /** One sentence: why this shape and not another. */
      why: string;
      /** Everything the operator has to confirm before pressing the button. */
      check: string[];
      costUsd: number;
    };

const STEP_TOOL = {
  type: "function",
  function: {
    name: "next_step",
    description:
      "Either ask the operator one question, or fill in the form. Call exactly once, then stop.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["ask", "draft"],
          description:
            "ask when you genuinely cannot choose the shape or would have to invent a figure; draft when you can fill the form in.",
        },
        question: {
          type: "string",
          description:
            "action=ask only. One question, the shortest one that unblocks you. Name the choices when there are only a few.",
        },
        family: {
          type: "string",
          enum: ["vendor", "manual"],
          description:
            "action=draft only. vendor when a connector in the catalogue reads this for itself; manual when nothing will ever report it.",
        },
        vendor: {
          type: "string",
          description:
            "action=draft only. family=vendor: exactly one catalogue id. family=manual: who bills it, lower case, as it would appear on a card.",
        },
        kind: {
          type: "string",
          enum: ["fixed", "usage", "metered", "revenue"],
          description: "family=manual only, and required there. Which shape of box.",
        },
        name: { type: "string", description: "family=manual only. What the row is called on the board." },
        monthly_usd: {
          type: "number",
          description:
            "Only if the operator stated an amount. Omit entirely otherwise — never supply a price you happen to know.",
        },
        cap: { type: "number", description: "kind=metered only, and only if the operator stated the limit." },
        unit: { type: "string", description: "kind=metered only. calls, units, GB, USD." },
        used: {
          type: "number",
          description:
            "kind=metered only, and only if the operator said something is already counting. Omit otherwise — a blank reading is the honest state of a stated ceiling.",
        },
        reset_label: {
          type: "string",
          description: "kind=metered only. e.g. 'resets 00:00 Pacific', 'does not reset'.",
        },
        note: { type: "string", description: "Where this figure came from, in the operator's own terms." },
        why: { type: "string", description: "action=draft only. One sentence: why this shape rather than another." },
        check: {
          type: "array",
          items: { type: "string" },
          description:
            "action=draft only. Everything the operator must confirm: every figure you copied, every field you left blank, anything you assumed, anything already on this board that this duplicates or replaces. One short line each. Never empty.",
        },
      },
      required: ["action"],
    },
  },
};

function catalogue(): string {
  const vendors = VENDORS.map(
    (v) => `- ${v.id} — reports ${v.reports}. Needs: ${v.fields.map((f) => f.label.toLowerCase()).join(" + ")}.`,
  ).join("\n");
  const manual = MANUAL.map((m) => `- ${m.kind} — ${m.label}: ${m.reports}`).join("\n");
  return `Vendors this build can actually read (family="vendor"):\n${vendors}\n\nShapes for a hand-stated box (family="manual"):\n${manual}`;
}

const SYSTEM = `You fill in one form on Cloudgeng Finance Tracker: the form that adds a box to an app's board. The operator describes what they want; you work out the shape and fill in what they told you. It is a short conversation, and it ends the moment you can fill the form in.

${catalogue()}

The console has one rule and you inherit it: never state a number that was not measured. In this form that means exactly one thing — a figure may be copied out of what the operator wrote, and may come from nowhere else. You know roughly what a Cloudflare plan or a Supabase tier costs; that knowledge is forbidden here. If they did not name an amount, leave the field out and say so in check. A blank the operator fills in takes five seconds; a plausible wrong number on a finance board can sit there for months.

A manual box cannot be saved without the figure its shape asks for: fixed and usage need the monthly amount, a ceiling needs its cap. When the operator did not state one, leave the field out and tell them in check that they have to type it before the box can be added. Never describe the result as $0.00 — a blank is not a zero, the form refuses it, and this console draws the distinction everywhere else.

When to ask instead of drafting:
- You cannot tell which shape it is, and the choice changes what the board does with it. "the analytics thing" could be a subscription, a ceiling or neither.
- You cannot tell whether a vendor in the catalogue covers it, or whether this is a separate hand-stated line.
- Anything else — ask. Asking one short question is always better than guessing, and far better than failing.
But ask only when the answer changes the draft. Do not ask for a name you could take from their own words, do not ask permission, and do not confirm something they already said. Never ask two questions at once. If they have told you enough for a shape but not a figure, draft it with the figure blank and put it in check — that is not a reason to ask.

Choosing the family:
- If a vendor in the catalogue above reads this for itself, that is a vendor box, even when the operator phrased it as a cost. "we spend about forty dollars a month on fal" is a fal.ai connection, not a hand-stated forty dollars — the connector will report the real figure, and the real figure is the point.
- Everything else is manual: domain renewals, contractors, a ceiling someone was told about on a call, a vendor with no connector written yet.
- If they are clearly describing a vendor with no connector in the catalogue, use manual and say in check that no connector exists for it, so the figure will not update itself.

Choosing the manual shape: fixed for a bill that is the same every month, usage for money that moves with use and has no ceiling, metered for something that runs out, revenue for money coming in. family="manual" always needs a kind.

check is the point of the whole step. Write it for someone who is about to press a button: every figure you copied and where you got it, every field you left blank and why, and anything already on this app's board that this would duplicate or replace. Never return it empty.`;

/** A figure that came back as something other than a finite number is not a figure. */
const number = (v: unknown): number | undefined => {
  const n = Number(v);
  return typeof v === "number" || (typeof v === "string" && v.trim() !== "")
    ? Number.isFinite(n)
      ? n
      : undefined
    : undefined;
};

const text = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s || undefined;
};

/** After this many questions the conversation is not converging on its own. */
const ENOUGH_ASKING = 3;

/**
 * One turn of the add-a-box conversation.
 *
 * The app's existing rows and connections go in with the transcript, so the
 * model can say "fal.ai is already connected, this would replace the key"
 * instead of proposing a duplicate the operator only finds after pressing the
 * button.
 */
export async function draftBox(appId: string, turns: BoxTurn[]): Promise<DraftResult> {
  const db = serviceClient();
  const [app, resources, connections] = await Promise.all([
    db.from("apps").select("name").eq("id", appId).maybeSingle(),
    db.from("resources").select("kind, name, vendor, source").eq("app_id", appId),
    db.from("connections").select("vendor, status").eq("app_id", appId),
  ]);

  const context = [
    `App: ${app.data?.name ?? "unknown"}`,
    `Already on its board: ${
      (resources.data ?? []).map((r) => `${r.name} (${r.kind}, via ${r.source})`).join("; ") || "nothing"
    }`,
    `Already connected: ${
      (connections.data ?? []).map((c) => `${c.vendor} (${c.status})`).join("; ") || "nothing"
    }`,
  ].join("\n");

  const asked = turns.filter((t) => t.role === "assistant").length;
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "system", content: `The app this box is being added to:\n${context}` },
    ...turns.map((t) =>
      t.role === "user"
        ? ({ role: "user", content: t.content } as ChatMessage)
        : ({ role: "assistant", content: t.content } as ChatMessage),
    ),
  ];

  // A conversation that has asked three times and still cannot settle is not
  // going to be rescued by a fourth question. Draft the best available shape and
  // let check carry the doubt — the operator is looking at the form either way,
  // and a filled form they correct beats a fourth question they abandon.
  if (asked >= ENOUGH_ASKING) {
    // Carried as a turn in the conversation rather than as another system
    // message: several system messages are merged into one instruction before
    // this model sees them, so a late one loses its lateness — which is the
    // entire content of this particular instruction.
    messages.push({
      role: "user",
      content:
        `[the interface, not the operator] You have asked ${asked} questions and the conversation is not converging. ` +
        `Stop asking. Call next_step with action="draft" now, using whatever you have: leave every field you are ` +
        `unsure of blank, and put each of those blanks in check so the operator knows what to fill in.`,
    });
  }

  const key = await falKey();
  const out = await chat(key, messages, [STEP_TOOL], {
    type: "function",
    function: { name: "next_step" },
  });

  const call = out.toolCalls.find((c) => c.function.name === "next_step");
  if (!call) {
    // The model answered in prose despite being handed one tool and told to use
    // it. Its sentence is still the most useful thing available, so it becomes
    // the question rather than an error.
    const said = text(out.content);
    if (said) return { kind: "ask", question: said, costUsd: out.costUsd };
    throw new Error("the assistant did not answer — try describing it differently");
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new Error("the assistant's draft came back malformed");
  }

  const ask = (question: string): DraftResult => ({ kind: "ask", question, costUsd: out.costUsd });

  if (args.action === "ask") {
    return ask(
      text(args.question) ?? "Tell me a little more about this one — what is it, and who bills it?",
    );
  }

  const why = text(args.why) ?? "";
  const check = Array.isArray(args.check) ? args.check.map((c) => String(c)).filter(Boolean) : [];

  // Grounding. The model is choosing from a list, and a list it invented an
  // entry for is the one failure that would reach the board looking legitimate:
  // an unknown vendor id posts to a connector that does not exist, and a missing
  // kind posts a row the board has no shape for.
  //
  // Both used to throw. Neither does now: an unusable draft means the model did
  // not have enough to go on, and the honest response to that is the question it
  // should have asked — not a red box telling the operator to do it themselves.
  if (args.family === "vendor") {
    const vendor = vendorById(String(args.vendor ?? ""));
    if (!vendor) {
      return ask(
        `This build has no connector for "${args.vendor ?? "that"}", so it would have to be stated by hand. ` +
          `Is it a fixed monthly bill, spend that moves with use, something with a ceiling, or money coming in?`,
      );
    }
    return { kind: "draft", draft: { family: "vendor", vendor: vendor.id }, why, check, costUsd: out.costUsd };
  }

  const spec = manualByKind(String(args.kind ?? ""));
  if (!spec) {
    return ask(
      "I could not tell which shape this should be. Is it a fixed monthly cost, spend that moves with use, " +
        "something with a ceiling that runs out, or revenue coming in?",
    );
  }

  const draft: BoxDraft = {
    family: "manual",
    kind: spec.kind,
    vendor: text(args.vendor) ?? "",
    name: text(args.name) ?? "",
    note: text(args.note),
  };

  // Only the fields this shape actually asks for. A cap drafted onto a fixed
  // monthly line would be dropped by the server anyway; dropping it here means
  // the form never shows the operator a field their box does not have.
  if (spec.asks.includes("monthly")) draft.monthly_usd = number(args.monthly_usd);
  if (spec.asks.includes("ceiling")) {
    draft.cap = number(args.cap);
    draft.used = number(args.used);
    draft.unit = text(args.unit);
    draft.reset_label = text(args.reset_label);
  }

  return { kind: "draft", draft, why, check, costUsd: out.costUsd };
}
