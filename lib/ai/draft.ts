import { serviceClient } from "@/lib/apps";
import { chat, falKey } from "./fal";
import { MANUAL, VENDORS, manualByKind, vendorById, type ManualKind } from "@/lib/sources";

/**
 * The assistant filling in the add-a-box form.
 *
 * It drafts; it does not write. The model picks which of the two questions the
 * operator has already answered in their sentence — what kind of box this is,
 * and what it is — and the answer lands in the same form, with the same submit
 * button and the same server-side validation behind it. Nothing reaches the
 * board that a person did not look at and press a button on.
 *
 * That division is not caution for its own sake. The board's one rule is that a
 * figure it shows was measured, and a model is exactly the thing that will
 * cheerfully supply "Cloudflare Pro, $20/month" from memory — a number that is
 * plausible, frequently correct, and not a measurement of anything. So the
 * prompt allows transcription and forbids recall: a figure may be copied out of
 * the operator's own sentence and may not come from anywhere else. What it
 * copied is listed back in `check`, on screen, above the button.
 */

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

export type DraftResult = {
  draft: BoxDraft;
  /** One sentence: why this shape and not another. */
  why: string;
  /** Everything the operator has to confirm before pressing the button. */
  check: string[];
  costUsd: number;
};

const DRAFT_TOOL = {
  type: "function",
  function: {
    name: "draft_box",
    description:
      "Fill in the add-a-box form from what the operator wrote. Call exactly once, then stop.",
    parameters: {
      type: "object",
      properties: {
        family: {
          type: "string",
          enum: ["vendor", "manual"],
          description:
            "vendor when a connector in the catalogue can read this for itself; manual when nothing will ever report it.",
        },
        vendor: {
          type: "string",
          description:
            "family=vendor: exactly one catalogue id. family=manual: who bills it, lower case, as it would appear on a card.",
        },
        kind: {
          type: "string",
          enum: ["fixed", "usage", "metered", "revenue"],
          description: "family=manual only. Which shape of box.",
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
        reset_label: { type: "string", description: "kind=metered only. e.g. 'resets 00:00 Pacific', 'does not reset'." },
        note: { type: "string", description: "Where this figure came from, in the operator's own terms." },
        why: { type: "string", description: "One sentence: why this shape rather than another." },
        check: {
          type: "array",
          items: { type: "string" },
          description:
            "Everything the operator must confirm: every figure you copied, every field you left blank, and anything you had to assume. One short line each. Never empty.",
        },
      },
      required: ["family", "vendor", "why", "check"],
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

const SYSTEM = `You fill in one form on Cloudgeng Finance Tracker: the form that adds a box to an app's board. The operator describes what they want in a sentence; you choose the shape and fill in what they told you.

${catalogue()}

The console has one rule and you inherit it: never state a number that was not measured. In this form that means exactly one thing — a figure may be copied out of the operator's sentence, and may come from nowhere else. You know roughly what a Cloudflare plan or a Supabase tier costs; that knowledge is forbidden here. If they did not name an amount, omit the field and say so in check. A blank the operator fills in takes five seconds; a plausible wrong number on a finance board can sit there for months.

A manual box cannot be saved without the figure its shape asks for: fixed and usage need the monthly amount, a ceiling needs its cap. When the operator did not state one, leave the field out and tell them in check that they have to type it before the box can be added. Never describe the result as $0.00 — a blank is not a zero, the form refuses it, and this console draws the distinction everywhere else.

Choosing the family:
- If a vendor in the catalogue above reads this for itself, that is a vendor box, even when the operator phrased it as a cost. "we spend about forty dollars a month on fal" is a fal.ai connection, not a hand-stated forty dollars — the connector will report the real figure, and the real figure is the point.
- Everything else is manual: domain renewals, contractors, a ceiling someone was told about on a call, a vendor with no connector written yet.
- If they are clearly describing a vendor with no connector in the catalogue, use manual and say in check that no connector exists for it, so the figure will not update itself.

Choosing the manual shape: fixed for a bill that is the same every month, usage for money that moves with use and has no ceiling, metered for something that runs out, revenue for money coming in.

check is the point of this whole step. Write it for someone who is about to press a button: every figure you copied and where you got it, every field you left blank and why, and anything already on this app's board that this would duplicate or replace. Never return it empty.`;

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

/**
 * Draft a box for one app from one sentence.
 *
 * The app's existing rows and connections go in with the prompt, so the model
 * can say "fal.ai is already connected, this would replace the key" instead of
 * proposing a duplicate the operator only discovers after pressing the button.
 */
export async function draftBox(appId: string, wanted: string): Promise<DraftResult> {
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

  const key = await falKey();
  const out = await chat(
    key,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: `${context}\n\nThe operator wants to add:\n${wanted}` },
    ],
    [DRAFT_TOOL],
    { type: "function", function: { name: "draft_box" } },
  );

  const call = out.toolCalls.find((c) => c.function.name === "draft_box");
  if (!call) throw new Error("the assistant did not fill anything in — try describing it differently");

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new Error("the assistant's draft came back malformed");
  }

  const why = text(args.why) ?? "";
  const check = Array.isArray(args.check)
    ? args.check.map((c) => String(c)).filter(Boolean)
    : [];

  // Grounding. The model is choosing from a list, and a list it invented an
  // entry for is the one failure that would reach the board looking legitimate:
  // an unknown vendor id posts to a connector that does not exist, and a made-up
  // kind posts a row the board has no shape for. Both are caught here, before
  // the form ever renders, and come back as something the operator can act on.
  if (args.family === "vendor") {
    const vendor = vendorById(String(args.vendor ?? ""));
    if (!vendor) {
      throw new Error(
        `no connector for "${args.vendor}" in this build — add it by hand, or pick a vendor from the list`,
      );
    }
    return { draft: { family: "vendor", vendor: vendor.id }, why, check, costUsd: out.costUsd };
  }

  const spec = manualByKind(String(args.kind ?? ""));
  if (!spec) throw new Error("the assistant could not settle on a shape — pick one by hand");

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

  return { draft, why, check, costUsd: out.costUsd };
}
