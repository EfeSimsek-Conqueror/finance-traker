import { connectionState, listConnections, serviceClient, type Connection, type Resource } from "@/lib/apps";
import { counted, usd } from "@/lib/money";
import { chat, falKey, MODEL, type ChatMessage } from "@/lib/ai/fal";
import { BRIEFING_TOOLS, CONSOLE_TZ, runTool } from "@/lib/ai/tools";

/**
 * One model-written note per app per day.
 *
 * The board already renders every level in bigger type than a paragraph could,
 * so the note is not a summary — it is the one thing that moved, or the one
 * thing closest to a ceiling, written beside the numbers it describes.
 *
 * The console's rule holds here or the feature should not exist: a figure in the
 * note has to have come out of a tool result in the same run. That is not left
 * to the prompt. Every money figure and percentage the model writes is checked
 * against what the tools actually printed, and a note that fails is thrown away
 * rather than corrected — the card keeps yesterday's, labelled with yesterday's
 * date. A stale note that says which day it is about is honest. A repaired one
 * is a guess wearing a citation.
 */

/** A figure in the note, and where it came from. */
export type Cite = { label: string; value: string; source: string };

/** What `write_briefing` hands back, before anything has been checked. */
export type BriefingDraft = {
  headline: string;
  body: string;
  tone: "ok" | "warn" | "crit" | "neutral";
  cites: Cite[];
};

/** A note that exists. This is what the board renders. */
export type Briefing = {
  /** The day the note is ABOUT, "YYYY-MM-DD" in Europe/Istanbul. */
  date: string;
  headline: string;
  body: string;
  tone: "ok" | "warn" | "crit" | "neutral";
  cites: Cite[];
  /** taken_at of the earlier reading it was written against. Null when there was nothing to compare. */
  comparedTo: string | null;
  model: string;
  /** Null means the router reported no cost — not that the note was free. Render through usd(). */
  costUsd: number | null;
  /** Everything this date's note cost, discarded attempts included. */
  costUsdDay: number | null;
  toolCalls: string[];
  generatedAt: string;
};

export type BriefingStatus = "pending" | "ok" | "failed" | "rejected" | "skipped";

export type BriefingCard = {
  /** The most recent note actually written. Null before the first one. */
  note: Briefing | null;
  /** Today's row whatever became of it — including a failure that produced no prose. Null if nothing ran today. */
  today: { date: string; status: BriefingStatus; error: string | null } | null;
  /** The console's own clock. Passed down so "2 days ago" is not a client-side timezone guess. */
  todayDate: string;
};

/** What one generation attempt did. Never throws; a failure is a value. */
export type BriefingRun = {
  appId: string;
  status: BriefingStatus | "unchanged";
  briefing: Briefing | null;
  /** Why nothing was generated, when nothing was. */
  reason: string | null;
  /** What this attempt cost, whether or not it produced a note. */
  costUsd: number;
};

/**
 * The console has one clock and it is not the reader's.
 *
 * "Today" decided in the browser would make a note flip between two dates
 * depending on who opened the board, and the row it is stored under would stop
 * matching the card that renders it. The zone itself is defined once, beside
 * read_history, which has to speak the same clock.
 */
export function istanbulDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONSOLE_TZ }).format(at);
}

const clock = (at: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: CONSOLE_TZ, hour: "2-digit", minute: "2-digit" }).format(at);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const ROW_COLS =
  "briefing_date, status, headline, body, tone, cites, compared_to, model, cost_usd, cost_usd_day, tool_calls, error, generated_at";

type Row = {
  briefing_date: string;
  status: BriefingStatus;
  headline: string | null;
  body: string | null;
  tone: string | null;
  cites: unknown;
  compared_to: string | null;
  model: string | null;
  cost_usd: number | null;
  cost_usd_day: number | null;
  tool_calls: string[] | null;
  error: string | null;
  generated_at: string | null;
};

function toBriefing(row: Row): Briefing | null {
  // The table's own check constraint guarantees this for status 'ok', but the
  // board renders whatever it is handed, and a card with an empty headline is
  // worse than no card.
  if (!row.headline || !row.body) return null;
  return {
    date: row.briefing_date,
    headline: row.headline,
    body: row.body,
    tone: (row.tone ?? "neutral") as Briefing["tone"],
    cites: Array.isArray(row.cites) ? (row.cites as Cite[]) : [],
    comparedTo: row.compared_to,
    model: row.model ?? MODEL,
    costUsd: row.cost_usd,
    costUsdDay: row.cost_usd_day,
    toolCalls: row.tool_calls ?? [],
    generatedAt: row.generated_at ?? "",
  };
}

/**
 * The most recent note that was actually written, or null.
 *
 * Safe to call on a board that has never generated one, and safe to call when
 * the table is unreachable: a page render must not fail because a decorative
 * card could not load. Read-only by construction — nothing here regenerates on
 * read, because a card that writes when someone looks at it would bill fal every
 * time the board was opened.
 */
export async function latestBriefing(appId: string): Promise<Briefing | null> {
  try {
    const { data, error } = await serviceClient()
      .from("briefings")
      .select(ROW_COLS)
      .eq("app_id", appId)
      .eq("status", "ok")
      .order("briefing_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[briefing] latest failed", error.message);
      return null;
    }
    return data ? toBriefing(data as Row) : null;
  } catch (e) {
    console.error("[briefing] latest threw", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Everything the card needs: the newest note, and what became of today's run.
 *
 * Two reads rather than one, because they answer different questions. The newest
 * `ok` note is what there is to show; today's row is why it might be yesterday's.
 * Both are served by the `(app_id, briefing_date)` unique index.
 */
export async function briefingCard(appId: string): Promise<BriefingCard> {
  const todayDate = istanbulDate();
  try {
    const db = serviceClient();
    const [{ data: newest }, { data: today }] = await Promise.all([
      db
        .from("briefings")
        .select(ROW_COLS)
        .eq("app_id", appId)
        .eq("status", "ok")
        .order("briefing_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("briefings")
        .select("briefing_date, status, error")
        .eq("app_id", appId)
        .eq("briefing_date", todayDate)
        .maybeSingle(),
    ]);

    return {
      note: newest ? toBriefing(newest as Row) : null,
      today: today
        ? {
            date: (today as Row).briefing_date,
            status: (today as Row).status,
            error: (today as Row).error,
          }
        : null,
      todayDate,
    };
  } catch (e) {
    console.error("[briefing] card threw", e instanceof Error ? e.message : String(e));
    return { note: null, today: null, todayDate };
  }
}

// ---------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------

const BRIEFING_SYSTEM = `You are the daily briefer inside Cloudgeng Finance Tracker, a console that tracks quota and money across a small portfolio of apps. You write one short note per app per day. It renders as a card on the board, beside the numbers it describes, and it is read in about eight seconds by the person who pays these bills.

THE RULE YOU INHERIT
Never state a number you did not measure. Every figure in your note must be copied character for character out of a tool result in this conversation — $0.9276 stays $0.9276, not "about a dollar" and not "$0.93". Copy the tool's own precision; it was chosen deliberately.
Where a tool hands you the same figure twice — a raw number and a formatted twin beside it, like 1.237133225 and $1.24, or 0.0286 and 2% — the formatted one is what the board prints and the one that belongs on the card. Quoting it is not rounding: you did not do the rounding, the console did, using the same code the screen uses. Doing that arithmetic yourself is the thing that is banned. Where only the raw number exists, quote the raw number. If a thing is not measured, say so plainly: "nobody counts that" and "not measured" are real findings, and on this board they are often the most useful line on the card. Never estimate, never extrapolate, never round, never fill a gap with a plausible figure. A note that says less than you would like is correct. A note that says more than was measured is the one failure this console cannot absorb, and it will be thrown away before anyone reads it.

WHAT IS WORTH WRITING
Levels are boring. The board already shows them, in bigger type than yours. You are here for change and proximity:
- what moved since the last comparable reading, and by how much
- what is closest to a ceiling, and when the tool says it gets there
- what became unmeasured — a connector gone stale or errored, a vendor that bills and reports nothing, a ceiling with a known limit and no counter behind it
- what a figure implies if it continues, but only when a tool handed you that projection. Never compute one.
If nothing moved, the note is "nothing moved" plus the single fact closest to mattering. One sentence, then stop. Do not inflate a quiet day into a paragraph — a card that sounds urgent every morning stops being read by Thursday, and then it is worse than nothing.
On a day when read_history can compare nothing, one sentence carries that and the rest of the note is about what IS measured: the gauge closest to its ceiling with its own figures, and the ceilings that have a limit and no counter behind them. A note that is only about the absence of history tells the operator nothing they did not already know from the date.

WHAT YOU MAY NOT WRITE
No hedging and no filler. These are banned outright: "keep an eye on", "worth monitoring", "worth noting", "as always", "continues to", "trending", "healthy", "looking good", "no major changes", "overall", "stable", "consider". If a quota is at 94% you write that it is nearly gone. If it is at 0.3% you write that it is idle. Each is one sentence.
No advice nobody asked for. No next steps, no "you may want to", no recommendations. You report what happened. The operator decides what to do.
No markdown, no bullets, no headings, no emoji, no ASCII drawing. The card renders plain sentences.
Spell every vendor and resource exactly as the tools spell it. "supadata" is not Supabase. "fal.ai" is not FAL Labs. A misspelled vendor on a finance screen reads as a different bill.

HOW TO WORK
1. read_board, narrowed to the app you were given.
2. read_history for the same app. This is the only source of "since yesterday" — the resources table holds nothing but the present.
3. quota_status whenever this app has a ceiling worth naming, and spend_breakdown when the note turns on a cost. Quote their figures rather than doing arithmetic; they are the same code the board renders, so quoting them keeps you and the screen from disagreeing in one viewport. Both cover the whole portfolio, and the two halves of that are not equally dangerous: quota_status lists ceilings one at a time and every row names its vendor and resource, so any row you can match to this app in read_board is yours to quote. spend_breakdown's totals — cost_mtd, revenue_mtd, margin_pct — are portfolio sums. Name them as the portfolio's or leave them out; never as this app's.
If your note ranks ceilings against one another — fullest, closest, most at risk — that ordering has to come from quota_status, which sorts them and knows what each one is a fraction of. Ranking them yourself off read_board is arithmetic, and arithmetic is the thing you do not do here.
4. write_briefing, once, last. It is the only thing that reaches the card.

HISTORY HAS EDGES AND YOU WILL RESPECT THEM
read_history tells you per series whether a comparison is possible. When comparable is false there is no "since yesterday" and you may not invent one: write what is true now and say the board has only been recording since the timestamp the tool gave you. That is an honest first week, not a failure.
When a series is marked monotonic_break, a counter reset inside the window. The drop is not a saving and not a refund, and describing it as either would be a lie about money. Say the counter reset, or say nothing about it.
When counted_cost_delta is null there is no total. Do not add the parts up yourself — the parts include a vendor's invoice and the app's own breakdown of the same money, and summing them counts it twice.
RevenueCat reports a trailing 28-day window. Its change is not what was earned yesterday. If you mention it, name the window.
read_history also reports what your own briefings have cost. You are a line on fal's invoice. If fal's movement is small enough that your own run is a visible part of it, say so.

LENGTH
headline: one clause, at most 60 characters, no full stop. Name something on the board, not the state of this card. "No history yet" describes the briefing; "fal credit 2% spent, nothing else moved" describes the board, and only one of those is worth the top line.
body: 32 to 55 words, two or three sentences. If you reach 65 you are explaining rather than reporting; cut the explanation and keep the fact.
cites: every money figure and every percentage in your headline or body, each copied exactly as the tool printed it. A figure in the prose that is not in cites is a bug, and the note will be discarded and today's card will show yesterday's instead.`;

/**
 * The freshness line, written by the runner and never by the model.
 *
 * How stale the board is happens to be the most quotable fact available on a
 * quiet morning, which is exactly why the model does not get to phrase it. It is
 * read off `connections`, stated once, and the note can only repeat it.
 */
function syncLine(conns: Connection[]): string {
  const synced = conns.filter((c) => c.last_sync_at);
  if (!synced.length) return "Nothing on this board has ever synced.";

  const newest = synced
    .map((c) => new Date(c.last_sync_at as string))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const at = clock(newest);
  const mins = Math.max(0, Math.round((Date.now() - newest.getTime()) / 60_000));

  const broken = conns
    .map((c) => ({ vendor: c.vendor, state: connectionState(c) }))
    .filter((c) => c.state !== "connected");

  if (broken.length) {
    return `The board was last synced at ${at}. These connectors are not reporting: ${broken
      .map((c) => `${c.vendor} (${c.state})`)
      .join(", ")}.`;
  }
  return `The board was last synced at ${at}, ${mins} minute${mins === 1 ? "" : "s"} ago.`;
}

function userPrompt(app: { name: string; slug: string }, conns: Connection[]): string {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: CONSOLE_TZ, weekday: "long" }).format(now);
  return [
    `Write today's briefing for ${app.name} (slug: ${app.slug}).`,
    "",
    `Today is ${istanbulDate(now)}, a ${weekday}, in Europe/Istanbul. ${syncLine(conns)}`,
    "",
    "Start with read_board and read_history for this app, then file it with write_briefing. One note, about this app only.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

/**
 * Anything shaped like money, a percentage, or a measured decimal.
 *
 * `<$0.01` comes first in the alternation because `usd()` emits it for sub-cent
 * figures and the plain-dollar branch would otherwise swallow the "$0.01" inside
 * it and leave the "<" behind, turning one token into a different claim.
 *
 * The spelled-out "percent" and the bare-decimal branches are here because the
 * first live run walked straight through a narrower version of this regex: told
 * that "$1.2375" was not in any tool result, the model did not drop the claim —
 * it rewrote the sentence as "1.2375 ... at 2 percent" and sailed past a check
 * that only knew about "$" and "%". A verifier a model can reword its way around
 * is decoration. Bare INTEGERS are still unchecked on purpose: "Three other
 * quotas" and a cap written "50,000" against a tool that printed "50000" would
 * both be rejections of true sentences, and a check that cries wolf gets the
 * whole mechanism switched off.
 */
const FIGURE = /(?:<\$0\.01|-?\$\s?\d[\d,]*(?:\.\d+)?|-?\d[\d,]*(?:\.\d+)?\s?%|-?\d[\d,]*\.\d+)/g;

/**
 * "2 percent" and "2%" are the same claim and have to compare equal, or the
 * check is a spelling test. Applied to both sides before anything is compared.
 */
const spell = (text: string) => text.replace(/\s?per\s?cent/gi, "%");

const figuresIn = (text: string): string[] => spell(text).match(FIGURE) ?? [];

/**
 * Every figure a tool printed this run.
 *
 * Strings are scanned for the shapes above. Numbers are added raw AND in the
 * form the board would render them, because the tools emit both kinds: a
 * percentage arrives as `pct: 0` and money as `usd: 0.9276`, and without the
 * second form a model that correctly wrote "0%" or "$0.928" would be rejected
 * for quoting the figure the screen shows.
 */
function collectFigures(node: unknown, key: string, into: Set<string>): void {
  if (node == null) return;
  if (typeof node === "string") {
    for (const f of figuresIn(node)) into.add(f);
    return;
  }
  if (typeof node === "number" && Number.isFinite(node)) {
    into.add(String(node));
    if (/pct/i.test(key)) {
      into.add(`${node}%`);
      into.add(`${Math.round(node)}%`);
    }
    if (/usd/i.test(key)) {
      into.add(usd(node));
      // The raw digits with the currency mark the field name already promises.
      // Quoting them is not a rounding — it is the tool's own precision — and
      // rejecting it would push the model toward a vaguer sentence.
      into.add(`$${node}`);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectFigures(item, key, into);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) collectFigures(v, k, into);
  }
}

const unique = (xs: string[]) => [...new Set(xs)];

/**
 * The teeth behind the rule. Returns null when the note may be published.
 *
 * Two checks in series, and they are not the same check. The first says the
 * citations are real — every figure claimed as measured was printed by a tool.
 * The second says the prose is covered — every figure in the sentences is one of
 * those citations. Passing only the first would let a model attach three true
 * figures and write a fourth into the paragraph.
 */
function verify(draft: BriefingDraft, observed: Set<string>): string | null {
  const uncited = unique(draft.cites.flatMap((c) => figuresIn(c.value))).filter((f) => !observed.has(f));
  if (uncited.length) {
    return (
      `these figures are not in any tool result: ${uncited.join(", ")} — ` +
      `copy them exactly as the tool printed them, including its own precision, or drop the claim`
    );
  }

  const values = draft.cites.map((c) => spell(c.value));
  const loose = unique(figuresIn(`${draft.headline} ${draft.body}`)).filter(
    (f) => !values.some((v) => v.includes(f)),
  );
  if (loose.length) {
    return (
      `these figures appear in your note but not in cites: ${loose.join(", ")} — ` +
      `add each one to cites exactly as the tool printed it, or drop the claim`
    );
  }
  return null;
}

/**
 * The provenance line is the console's to write, not the model's.
 *
 * It is read off the history the run actually saw: the earliest reading behind
 * any series the tool was willing to call comparable. When nothing was
 * comparable this stays null and the card says so in its own words, which is the
 * one sentence on the screen that must not be a paraphrase.
 */
function comparedToFrom(result: unknown, slug: string): string | null {
  let earliest: string | null = null;
  const apps = Array.isArray(result) ? result : [result];
  for (const app of apps) {
    const a = app as { slug?: string; series?: { comparable?: boolean; first?: { at?: string } }[] };
    if (a?.slug !== slug || !Array.isArray(a.series)) continue;
    for (const s of a.series) {
      if (!s?.comparable || !s.first?.at) continue;
      if (!earliest || Date.parse(s.first.at) < Date.parse(earliest)) earliest = s.first.at;
    }
  }
  return earliest;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Enough to read the board, read history, check a total and file. */
const MAX_ROUNDS = 6;

/** A `pending` row older than this belonged to a run that died. */
const LOCK_MS = 10 * 60 * 1000;

type Claim =
  | { held: true; id: string; priorCost: number }
  | { held: false; reason: string; status: BriefingStatus };

/**
 * Take the day's lock, or find out who has it.
 *
 * `briefings_one_per_day` does double duty: it is the idempotency key and it is
 * the mutex. The insert below is `ON CONFLICT DO NOTHING`, so two invocations
 * racing at 04:35 cannot both proceed, and a cron that fires twice costs nothing
 * the second time instead of producing two different notes for one day.
 */
async function claimDay(db: ReturnType<typeof serviceClient>, appId: string, date: string, force: boolean): Promise<Claim> {
  const { data: fresh } = await db
    .from("briefings")
    .upsert(
      { app_id: appId, briefing_date: date, status: "pending", attempts: 1 },
      { onConflict: "app_id,briefing_date", ignoreDuplicates: true },
    )
    .select("id");
  if (fresh?.length) return { held: true, id: fresh[0].id as string, priorCost: 0 };

  const { data: existing } = await db
    .from("briefings")
    .select("id, status, created_at, attempts, cost_usd_day")
    .eq("app_id", appId)
    .eq("briefing_date", date)
    .maybeSingle();
  if (!existing) return { held: false, reason: "could not claim the day", status: "failed" };

  const status = existing.status as BriefingStatus;
  if ((status === "ok" || status === "skipped") && !force) {
    return { held: false, reason: "already written", status };
  }
  // A forced rewrite is a deliberate second bill and the operator asked for it.
  // An in-flight run is not overridable at any price: the whole reason the lock
  // exists is that two concurrent generators would both charge fal and then
  // disagree about which note is today's.
  if (status === "pending" && Date.now() - Date.parse(existing.created_at as string) < LOCK_MS) {
    return { held: false, reason: "generation in flight", status };
  }

  // Optimistic takeover. Matching on `attempts` means a second reclaimer racing
  // for the same crashed row loses rather than both proceeding.
  const { data: taken } = await db
    .from("briefings")
    .update({ status: "pending", created_at: new Date().toISOString(), attempts: (existing.attempts as number) + 1 })
    .eq("id", existing.id)
    .eq("attempts", existing.attempts)
    .select("id");
  if (!taken?.length) return { held: false, reason: "generation in flight", status: "pending" };

  return { held: true, id: existing.id as string, priorCost: (existing.cost_usd_day as number | null) ?? 0 };
}

/**
 * Write one app's note for today.
 *
 * Never throws. A generation that fails is a row saying so, because a briefer
 * that breaks silently is worse than one that breaks visibly — the card reads
 * differently for "the model could not be reached", "the model quoted a figure
 * nobody measured" and "there is nothing measured to write about", and
 * collapsing those three into an empty card would hide the second one.
 */
export async function generateBriefing(
  appId: string,
  opts: { force?: boolean } = {},
): Promise<BriefingRun> {
  const db = serviceClient();
  const date = istanbulDate();
  const force = opts.force === true;

  const claim = await claimDay(db, appId, date, force);
  if (!claim.held) {
    return { appId, status: "unchanged", briefing: null, reason: claim.reason, costUsd: 0 };
  }

  // Outside the try on purpose: a round that billed fal and then threw still
  // cost money, and a failure that cost money has to say so.
  let cost = 0;

  const finish = async (
    status: Exclude<BriefingStatus, "pending">,
    patch: Record<string, unknown>,
    cost: number,
  ) => {
    await db
      .from("briefings")
      .update({
        status,
        // Null rather than zero when nothing was reported. lib/ai/fal.ts folds an
        // absent `usage.cost` into 0 before we see it, and a round of Gemini 2.5
        // Pro is never actually free — so an exact zero here means the router
        // said nothing, and this console does not get to render that as $0.00.
        cost_usd: cost > 0 ? cost : null,
        cost_usd_day: claim.priorCost + cost > 0 ? claim.priorCost + cost : null,
        model: MODEL,
        generated_at: new Date().toISOString(),
        ...patch,
      })
      .eq("id", claim.id);
  };

  try {
    const { data: app } = await db.from("apps").select("id, slug, name").eq("id", appId).maybeSingle();
    if (!app) {
      await finish("failed", { error: "no such app" }, 0);
      return { appId, status: "failed", briefing: null, reason: "no such app", costUsd: 0 };
    }

    // Before spending a token. An app with no history and no measured cost has
    // nothing for a note to be about, and paying Gemini every morning to say
    // "nothing is instrumented" is a recurring charge for a fact the console
    // already knows and can state for free.
    const [{ count }, { data: rowData }] = await Promise.all([
      db.from("readings").select("id", { count: "exact", head: true }).eq("app_id", appId),
      db
        .from("resources")
        .select("id, kind, name, vendor, unit, used, cap, mtd_usd, source, is_sample")
        .eq("app_id", appId),
    ]);
    const money = counted((rowData ?? []) as unknown as Resource[]);
    if ((count ?? 0) < 2 && !money.length) {
      const reason = "nothing measured for this app yet";
      await finish("skipped", { error: reason }, 0);
      return { appId, status: "skipped", briefing: null, reason, costUsd: 0 };
    }

    const conns = await listConnections(appId);
    const key = await falKey();
    const messages: ChatMessage[] = [
      { role: "system", content: BRIEFING_SYSTEM },
      { role: "user", content: userPrompt(app, conns) },
    ];

    const observed = new Set<string>();
    const toolCalls: string[] = [];
    let comparedTo: string | null = null;
    let draft: BriefingDraft | null = null;
    let lastRejection: string | null = null;

    for (let round = 0; round < MAX_ROUNDS && !draft; round++) {
      const out = await chat(key, messages, BRIEFING_TOOLS as unknown as unknown[], "auto");
      cost += out.costUsd;

      if (!out.toolCalls.length) {
        // Prose is not a filing. Nothing written outside write_briefing reaches
        // the card, so the round is spent telling it that rather than letting a
        // perfectly good note evaporate.
        messages.push({ role: "assistant", content: out.content ?? null });
        messages.push({
          role: "user",
          content: "That did not reach the card. File the note with write_briefing.",
        });
        continue;
      }

      messages.push({ role: "assistant", content: null, tool_calls: out.toolCalls });

      for (const call of out.toolCalls) {
        const name = call.function.name;
        toolCalls.push(name);
        let payload: unknown;
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const { result, briefing } = await runTool(name, args);
          payload = result;

          if (briefing) {
            const problem = verify(briefing, observed);
            if (problem) {
              // A failed tool is information, not a dead end — the same pattern
              // the assistant uses for a bad argument. Handing the rejection
              // back lets the model fix its own citation inside the run, so the
              // retry needs no machinery of its own.
              lastRejection = problem;
              payload = { ok: false, error: problem };
            } else if (!toolCalls.some((t) => t !== "write_briefing")) {
              lastRejection = "you filed a note without reading anything first";
              payload = { ok: false, error: `${lastRejection} — call read_board and read_history, then file` };
            } else {
              draft = briefing;
            }
          } else {
            collectFigures(result, name, observed);
            if (name === "read_history") comparedTo ??= comparedToFrom(result, app.slug);
          }
        } catch (e) {
          payload = { error: e instanceof Error ? e.message : String(e) };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(payload).slice(0, 24_000),
        });
      }
    }

    if (!draft) {
      const reason = lastRejection ?? `no note after ${MAX_ROUNDS} rounds`;
      await finish("rejected", { error: reason }, cost);
      return { appId, status: "rejected", briefing: null, reason, costUsd: cost };
    }

    await finish(
      "ok",
      {
        headline: draft.headline,
        body: draft.body,
        tone: draft.tone,
        cites: draft.cites,
        compared_to: comparedTo,
        tool_calls: toolCalls,
        error: null,
      },
      cost,
    );

    return {
      appId,
      status: "ok",
      briefing: {
        date,
        headline: draft.headline,
        body: draft.body,
        tone: draft.tone,
        cites: draft.cites,
        comparedTo,
        model: MODEL,
        costUsd: cost > 0 ? cost : null,
        costUsdDay: claim.priorCost + cost > 0 ? claim.priorCost + cost : null,
        toolCalls,
        generatedAt: new Date().toISOString(),
      },
      reason: null,
      costUsd: cost,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The lock must not be left held by a run that died, or the day is blocked
    // for ten minutes and then retried by whoever comes next.
    await finish("failed", { error: message }, cost);
    return { appId, status: "failed", briefing: null, reason: message, costUsd: cost };
  }
}
