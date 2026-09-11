import { createClient } from "@supabase/supabase-js";

/**
 * An app's own measurement tables.
 *
 * The highest-resolution source there is, and the one no vendor API can match:
 * fal reports that the workspace spent $0.42 this month; an app's own ledger
 * reports which operation spent it, on which model, after how many retries.
 *
 * It is also the only route to a quota gauge when the vendor will not sell one
 * — an app that counts its own API units knows what it has left without ever
 * asking the vendor.
 *
 * Both tables are optional. A project with neither is not an error; it is an
 * app that does not measure itself yet, and the connector says so.
 */
export type LedgerReading = {
  costByOperation: { operation: string; vendor: string; usd: number }[];
  totalCostUsd: number;
  /** Present only when the project keeps a YouTube unit counter. */
  youtube: { unitsToday: number; dailyCap: number } | null;
  /**
   * Calls today, by the operation name the app records.
   *
   * Google publishes separate daily ceilings for search, batch stats and
   * uploads, and will not report consumption against them without a billing
   * account. The app's own call log can, because it records which operation
   * each call was — so the ceilings Google would only describe become ceilings
   * we can actually watch.
   */
  operationsToday: Record<string, number>;
};

/** YouTube Data API gives every project the same 50,000 units a day. */
const YOUTUBE_DAILY_CAP = 50_000;

export async function fetchLedger(
  projectRef: string,
  serviceKey: string,
  sinceIso: string,
): Promise<LedgerReading> {
  const db = createClient(`https://${projectRef}.supabase.co`, serviceKey, {
    auth: { persistSession: false },
  });

  const costByOperation: LedgerReading["costByOperation"] = [];
  let totalCostUsd = 0;

  const { data: costRows, error: costErr } = await db
    .from("ai_usage_events")
    .select("vendor, operation, cost_usd")
    .gte("occurred_at", sinceIso);

  // A missing table means this app does not keep a cost ledger — not a failure.
  if (costErr && !/does not exist|schema cache/i.test(costErr.message)) {
    throw new Error(`ai_usage_events: ${costErr.message}`);
  }

  if (costRows?.length) {
    const totals = new Map<string, { vendor: string; usd: number }>();
    for (const e of costRows) {
      const key = String(e.operation);
      const prev = totals.get(key) ?? { vendor: String(e.vendor), usd: 0 };
      prev.usd += Number(e.cost_usd ?? 0);
      totals.set(key, prev);
    }
    for (const [operation, v] of totals) {
      if (v.usd <= 0) continue;
      costByOperation.push({ operation, vendor: v.vendor, usd: v.usd });
      totalCostUsd += v.usd;
    }
    costByOperation.sort((a, b) => b.usd - a.usd);
  }

  // ── YouTube units ───────────────────────────────────────────────────────
  //
  // The quota day is Google's, not ours: it resets at midnight America/
  // Los_Angeles. Summing "today" in UTC would split the day in the wrong place
  // and undercount by up to ten hours every evening.
  let youtube: LedgerReading["youtube"] = null;
  const operationsToday: Record<string, number> = {};
  const pacificDayStart = startOfPacificDayUtc();

  const { data: ytRows, error: ytErr } = await db
    .from("youtube_api_usage")
    .select("units, operation")
    .gte("occurred_at", pacificDayStart);

  if (ytErr && !/does not exist|schema cache/i.test(ytErr.message)) {
    throw new Error(`youtube_api_usage: ${ytErr.message}`);
  }
  if (ytRows) {
    youtube = {
      unitsToday: ytRows.reduce((t, r) => t + Number(r.units ?? 0), 0),
      dailyCap: YOUTUBE_DAILY_CAP,
    };
    for (const r of ytRows) {
      const op = String(r.operation ?? "unknown");
      operationsToday[op] = (operationsToday[op] ?? 0) + 1;
    }
  }

  return { costByOperation, totalCostUsd, youtube, operationsToday };
}

/** Midnight America/Los_Angeles, expressed as a UTC instant. */
function startOfPacificDayUtc(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // How far into the Pacific day we are, subtracted from now.
  const elapsedMs = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return new Date(now.getTime() - elapsedMs).toISOString();
}
