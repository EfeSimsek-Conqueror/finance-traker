import { serviceClient, connectionState, type Connection, type Resource } from "@/lib/apps";
import { byVendor, costMtd, coverage, ghostVendors, mergeCeilings, usd } from "@/lib/money";

/**
 * What the board would tell you if you asked it what was wrong.
 *
 * Derived from the rows every time, never stored. A findings list written down
 * somewhere goes stale the moment the thing it describes is fixed, and a
 * console whose standing complaint is about a problem you solved last week is
 * one nobody reads twice.
 *
 * Every finding carries a prompt rather than a handler. The button sends it to
 * the assistant, which has real tools and a real transcript — so the action is
 * something that happened and can be read back, not a silent mutation.
 */
export type Finding = {
  id: string;
  /** Four letters, mono, in a coloured chip. The kind of problem at a glance. */
  tag: string;
  tagTone: "warn" | "gap" | "data" | "note";
  /** Where it lives — a vendor, a connector, a setting. */
  where: string;
  title: string;
  body: string;
  /** The button's label, and what it sends. */
  action: string;
  prompt: string;
};

export async function deriveFindings(appId: string, slug: string): Promise<Finding[]> {
  const db = serviceClient();

  const [{ data: rows }, { data: conns }, { data: app }, { data: briefs }] = await Promise.all([
    db.from("resources").select("*").eq("app_id", appId).eq("is_sample", false),
    db.from("connections").select("id, vendor, status, last_sync_at, last_error").eq("app_id", appId),
    db.from("apps").select("name, budget_usd").eq("id", appId).maybeSingle(),
    db
      .from("briefings")
      .select("cost_usd_day, attempts, status")
      .eq("app_id", appId)
      .order("briefing_date", { ascending: false })
      .limit(1),
  ]);

  // Merged, because that is what the board renders. Reading the raw rows made
  // the panel claim three ceilings had no counter while the table beside it
  // showed all three counted — the two halves of a ceiling arrive as separate
  // rows and only look complete once joined.
  const resources = mergeCeilings((rows ?? []) as Resource[]);
  const connections = (conns ?? []) as Connection[];
  const out: Finding[] = [];

  // ── vendors that bill and say nothing ──────────────────────────────────
  for (const vendor of ghostVendors(resources)) {
    out.push({
      id: `gap:${vendor}`,
      tag: "GAP",
      tagTone: "gap",
      where: `${vendor} · spend`,
      title: `${vendor} bills this app and reports no figure.`,
      body: `Cost MTD is ${usd(costMtd(resources))} and excludes ${vendor} entirely. The total is a floor, not a figure.`,
      action: "Connect it",
      prompt: `What would it take to measure ${vendor} spend for ${slug}, and what is it likely costing meanwhile?`,
    });
  }

  // ── ceilings nothing counts against ────────────────────────────────────
  const blind = resources.filter((r) => r.kind === "metered" && r.cap != null && r.used == null);
  if (blind.length) {
    out.push({
      id: "counter",
      tag: "BLIND",
      tagTone: "warn",
      where: `${blind[0].vendor} · ceilings`,
      title: `${blind.length} ceiling${blind.length === 1 ? " has" : "s have"} a limit and no counter.`,
      body: `${blind.map((r) => r.name).join(", ")}. The vendor will enforce ${
        blind.length === 1 ? "it" : "them"
      }; nothing here will see it coming.`,
      action: "Start counting",
      prompt: `Which of my uncounted ceilings is most likely to be hit, and what would it take to instrument ${blind[0].name}?`,
    });
  }

  // ── revenue that is structurally zero ──────────────────────────────────
  const revenue = resources.filter((r) => r.kind === "revenue");
  const stripe = connections.find((c) => c.vendor === "stripe");
  if (stripe && revenue.every((r) => (r.mtd_usd ?? 0) === 0)) {
    out.push({
      id: "stripe-key",
      tag: "KEY",
      tagTone: "data",
      where: "stripe · credential",
      title: "Revenue reads zero from a key that cannot see revenue.",
      body: "Stripe answered, so $0.00 is a real reading — of a test-mode account. Margin and contribution stay undefined until a live key is attached.",
      action: "Explain the swap",
      prompt: "What exactly changes on the board when I swap the Stripe test key for a live one?",
    });
  }

  // ── a total with nothing to be over ────────────────────────────────────
  if (app && app.budget_usd == null) {
    out.push({
      id: "budget",
      tag: "NULL",
      tagTone: "note",
      where: `${app.name} · budget`,
      title: "No budget is set, so no spend can be too much.",
      body: `Cost MTD renders uncoloured on purpose. Thresholds exist and are tuneable; there is simply no number for them to compare against yet.`,
      action: "Propose one",
      prompt: `Given what this app measured this month, what monthly budget would you set for ${slug}, and why that figure?`,
    });
  }

  // ── connectors that have stopped reporting ─────────────────────────────
  const stale = connections.filter((c) => connectionState(c) !== "connected");
  if (stale.length) {
    out.push({
      id: "stale",
      tag: "STALE",
      tagTone: "warn",
      where: stale.map((c) => c.vendor).join(", "),
      title: `${stale.length} connector${stale.length === 1 ? " is" : "s are"} no longer reporting now.`,
      body: stale[0].last_error
        ? `Last error: ${stale[0].last_error.slice(0, 140)}`
        : "The rows are still on the board, still rendering as current. They describe whenever the last sync was.",
      action: "Re-read them",
      prompt: `Sync ${stale.map((c) => c.vendor).join(" and ")} now and tell me what changed.`,
    });
  }

  // ── the console's own cost ─────────────────────────────────────────────
  const brief = briefs?.[0] as { cost_usd_day: number | null; attempts: number | null } | undefined;
  if (brief?.cost_usd_day != null && (brief.attempts ?? 1) > 2) {
    out.push({
      id: "brief-cost",
      tag: "COST",
      tagTone: "data",
      where: "briefing · retries",
      title: `The day's note took ${brief.attempts} attempts.`,
      body: `${usd(brief.cost_usd_day)} for one paragraph, most of it discarded drafts. This console is meant to notice spend like that, including its own.`,
      action: "Look at it",
      prompt: "Why did today's briefing need so many attempts, and what would cut the retries?",
    });
  }

  return out;
}

/**
 * Short questions worth asking about this board, right now.
 *
 * Derived rather than listed, for the same reason the findings are: a fixed
 * four ("What runs out today?") is a menu of things the console can talk about
 * in general, and after the second read it is furniture. These name the rows
 * actually on screen — the vendor that is biggest, the ceiling that is fullest,
 * the figure nobody has explained — so the answer is one tool call away and the
 * question changes when the board does.
 *
 * More are returned than fit. The panel shows a window and moves it, which is
 * what keeps the same four from becoming the new fixed four.
 */
export async function deriveSuggestions(appId: string): Promise<string[]> {
  const db = serviceClient();
  const [{ data: rows }, { count: readings }] = await Promise.all([
    db.from("resources").select("*").eq("app_id", appId).eq("is_sample", false),
    db
      .from("readings")
      .select("id", { count: "exact", head: true })
      .eq("app_id", appId)
      .gte("taken_at", new Date(Date.now() - 86_400_000).toISOString()),
  ]);

  const resources = mergeCeilings((rows ?? []) as Resource[]);
  const out: string[] = [];

  const vendors = byVendor(resources);
  if (vendors[0]) out.push(`Why is ${vendors[0].vendor} ${usd(vendors[0].total)}?`);
  if (vendors[1]) out.push(`Is ${vendors[1].vendor} worth ${usd(vendors[1].total)}?`);

  // The ceiling closest to its limit, which is the only one worth naming.
  const fullest = resources
    .filter((r) => r.kind === "metered" && r.cap != null && r.used != null)
    .sort((a, b) => (b.used ?? 0) / (b.cap ?? 1) - (a.used ?? 0) / (a.cap ?? 1))[0];
  if (fullest) out.push(`How long does ${fullest.name.replace(/^YouTube · /, "")} last?`);

  for (const v of new Set(resources.map((r) => r.vendor))) {
    const cov = coverage(resources, v);
    if (cov && cov.unattributed > 0.005) {
      out.push(`What is the ${usd(cov.unattributed)} unattributed?`);
      break;
    }
  }

  const ghosts = ghostVendors(resources);
  if (ghosts[0]) out.push(`What is ${ghosts[0]} costing me?`);

  // Only offer a comparison when there is something to compare against.
  out.push((readings ?? 0) > 12 ? "What changed since yesterday?" : "What has been measured so far?");

  const fastest = resources
    .filter((r) => r.kind === "usage" && (r.run_rate_usd ?? 0) > 0)
    .sort((a, b) => (b.run_rate_usd ?? 0) - (a.run_rate_usd ?? 0))[0];
  if (fastest) out.push(`Where does ${usd(fastest.run_rate_usd)}/mo go?`);

  if (resources.some((r) => r.kind === "revenue")) out.push("When will revenue show up here?");
  out.push("What can I ignore?");

  return out;
}
