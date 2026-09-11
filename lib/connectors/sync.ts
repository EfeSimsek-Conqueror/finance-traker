import { serviceClient } from "@/lib/apps";
import { fetchFalUsage, fetchFalBalance } from "./fal";
import { fetchStripeRevenue } from "./stripe";
import { fetchRevenueCat } from "./revenuecat";
import { fetchVercelBilling } from "./vercel";
import { fetchLedger } from "./ledger";
import { record } from "@/lib/readings";
import { fetchGoogleQuota } from "./google";

export type SyncResult = { ok: boolean; vendor: string; message: string; wrote?: number };

/**
 * The next 00:00 America/Los_Angeles, as a UTC instant.
 *
 * Google's quota day is Pacific, and knowing when a ceiling refills is what
 * stops the board calling a 92%-full daily quota critical at eleven at night.
 */
function nextPacificMidnight(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsedMs = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return new Date(now.getTime() - elapsedMs + 86_400_000).toISOString();
}

/** First day of the current month, which is the window every vendor bills on. */
function monthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/**
 * Pull one connection's readings and write them onto the app's board.
 *
 * Each vendor owns its rows: a sync replaces what it wrote last time and leaves
 * everything else alone. That is what lets a real connector quietly displace a
 * sample row without a migration — the seed rows are marked `is_sample` and the
 * first successful sync for that vendor deletes them.
 */
export async function syncConnection(connectionId: string): Promise<SyncResult> {
  const supabase = serviceClient();

  const { data: conn, error } = await supabase
    .from("connections")
    .select("id, app_id, vendor, secret")
    .eq("id", connectionId)
    .single();

  if (error || !conn) return { ok: false, vendor: "?", message: "connection not found" };

  try {
    const rows = await readVendor(conn.vendor, conn.secret);

    // The vendor's own rows go, sample rows for the same vendor go with them.
    // Own rows by SOURCE, not vendor: the app's own ledger reports fal spend,
    // so a sync that cleaned up by vendor would delete the fal connector's
    // rows and leave its own behind.
    await supabase
      .from("resources")
      .delete()
      .eq("app_id", conn.app_id)
      .eq("source", conn.vendor);

    if (rows.length) {
      const withIds = rows.map((r, i) => ({
        ...r,
        app_id: conn.app_id,
        source: conn.vendor,
        vendor: r.vendor ?? conn.vendor,
        sort: i + 1,
      }));
      const { error: insErr } = await supabase.from("resources").insert(withIds);
      if (insErr) throw new Error(insErr.message);

      // Archive what we just measured. This is what turns a board of current
      // values into one that can say how fast anything is moving.
      await record(conn.app_id, withIds as never);
    }

    await supabase
      .from("connections")
      .update({ status: "connected", last_sync_at: new Date().toISOString(), last_error: null })
      .eq("id", conn.id);

    return { ok: true, vendor: conn.vendor, message: `wrote ${rows.length} reading(s)`, wrote: rows.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("connections")
      .update({ status: "error", last_error: message, last_sync_at: new Date().toISOString() })
      .eq("id", conn.id);
    return { ok: false, vendor: conn.vendor, message };
  }
}

type Reading = {
  /** Who bills for this. Defaults to the connector that read it. */
  vendor?: string;
  kind: "metered" | "usage" | "fixed" | "revenue";
  name: string;
  unit: string | null;
  used: number | null;
  cap: number | null;
  reset_label: string | null;
  /** When the ceiling refills. Null when it does not, or when we cannot tell. */
  resets_at?: string | null;
  projection: string | null;
  projection_note: string | null;
  status: "ok" | "warn" | "crit" | "neutral" | "unknown";
  mtd_usd: number | null;
  run_rate_usd: number | null;
  gross_usd?: number | null;
  fees_usd?: number | null;
  is_sample: boolean;
};

async function readVendor(vendor: string, secret: string): Promise<Reading[]> {
  switch (vendor) {
    case "fal.ai": {
      const [usage, balance] = await Promise.all([
        fetchFalUsage(secret, monthStartIso()),
        fetchFalBalance(secret),
      ]);
      const day = new Date().getUTCDate();
      // Run rate is this month's spend extrapolated over the whole month. It is
      // arithmetic on a measurement, not a forecast, so it is safe to show —
      // but only once there is at least a day of it to divide by.
      const runRate = day > 0 ? (usage.totalUsd / day) * 30 : null;
      const rows: Reading[] = usage.endpoints.map((e) => ({
        kind: "usage" as const,
        name: `fal · ${e.id.split("/").slice(-2)[0] ?? "models"}`,
        unit: null,
        used: null,
        cap: null,
        reset_label: `this month · ${day} day${day === 1 ? "" : "s"}`,
        projection: null,
        projection_note: null,
        status: "ok" as const,
        mtd_usd: e.usd,
        run_rate_usd: usage.totalUsd ? Number((runRate! * (e.usd / usage.totalUsd)).toFixed(2)) : null,
        gross_usd: null,
        fees_usd: null,
        is_sample: false,
      }));

      if (balance != null) {
        // The pot is what is left plus what this month has already taken out of
        // it. That understates the original top-up whenever spend predates the
        // month, but it is the only figure both numbers agree on — and the bar
        // it draws is honest about the part that matters: the remainder.
        const pot = balance + usage.totalUsd;
        const dailyRate = day > 0 ? usage.totalUsd / day : 0;
        const daysLeft = dailyRate > 0 ? balance / dailyRate : null;
        rows.unshift({
          kind: "metered",
          name: "fal credit",
          unit: "USD",
          used: Number(usage.totalUsd.toFixed(4)),
          cap: Number(pot.toFixed(4)),
          reset_label: "does not reset \u00b7 top-up",
          projection:
            daysLeft == null
              ? "no burn yet"
              : daysLeft > 365
                ? "over a year"
                : `${Math.round(daysLeft)} days left`,
          projection_note:
            daysLeft == null
              ? "nothing spent this month, so there is no rate to project"
              : `at this month\u2019s rate of $${dailyRate.toFixed(2)}/day`,
          status: daysLeft != null && daysLeft < 14 ? "crit" : daysLeft != null && daysLeft < 45 ? "warn" : "ok",
          mtd_usd: null,
          run_rate_usd: null,
          gross_usd: null,
          fees_usd: null,
          is_sample: false,
        });
      }
      return rows;
    }
    case "stripe": {
      const since = Math.floor(new Date(monthStartIso()).getTime() / 1000);
      const rev = await fetchStripeRevenue(secret, since);
      if (!rev.count) {
        // No charges is a fact, not a failure — say so with a zero rather than
        // writing nothing and leaving the card looking unconnected.
        return [{
          kind: "revenue", name: "Stripe", unit: null, used: null, cap: null,
          reset_label: "this month · no charges yet", projection: null, projection_note: null,
          status: "neutral", mtd_usd: 0, run_rate_usd: null,
          gross_usd: 0, fees_usd: 0, is_sample: false,
        }];
      }
      return [{
        kind: "revenue",
        name: `Stripe · ${rev.count} charge${rev.count === 1 ? "" : "s"}`,
        unit: null, used: null, cap: null,
        reset_label: `this month · ${rev.currency.toUpperCase()}`,
        projection: null, projection_note: null,
        status: "ok",
        // Net, not gross: Stripe's fee never reaches the account, and margin
        // measured against gross is wrong on every sale.
        mtd_usd: Number(rev.netUsd.toFixed(2)),
        run_rate_usd: null,
        gross_usd: Number(rev.grossUsd.toFixed(2)),
        fees_usd: Number(rev.feesUsd.toFixed(2)),
        is_sample: false,
      }];
    }
    case "revenuecat": {
      // The secret carries the project id after a colon, because RevenueCat
      // scopes every v2 call to a project and one key can serve several.
      const [key, projectId] = secret.split("|");
      if (!projectId) throw new Error('paste as "<secret key>|<project id>"');
      const rc = await fetchRevenueCat(key, projectId);
      return [{
        kind: "revenue",
        name: "App Store · RevenueCat",
        unit: null, used: null, cap: null,
        reset_label: "trailing 28 days",
        projection: null, projection_note: null,
        status: rc.revenueUsd ? "ok" : "neutral",
        mtd_usd: rc.revenueUsd,
        run_rate_usd: null,
        gross_usd: null,
        fees_usd: null,
        is_sample: false,
      }];
    }
    case "vercel": {
      // Secret is "<token>|<teamId>" — one token can see several teams and the
      // board is per app, so the team has to be named explicitly.
      const [token, teamId] = secret.split("|");
      if (!teamId) throw new Error('paste as "<token>|<team id>"');
      const v = await fetchVercelBilling(token, teamId);
      const ends = v.periodEnd ? new Date(v.periodEnd).toUTCString().slice(5, 16) : null;
      return [{
        kind: "fixed",
        name: `${v.plan === "pro" ? "Vercel Pro" : `Vercel ${v.plan}`} · ${v.seats} seat${v.seats === 1 ? "" : "s"}`,
        unit: null, used: null, cap: null,
        reset_label: ends ? `billing period to ${ends}` : null,
        projection: null,
        projection_note: `$${v.includedAllocationUsd} usage included`,
        status: "neutral",
        mtd_usd: v.monthlyUsd,
        run_rate_usd: null,
        gross_usd: null, fees_usd: null,
        is_sample: false,
      }];
    }
    case "ledger": {
      // "<project ref>|<service role key>" — the ref names which project's
      // tables to read, the key opens them.
      const [ref, key] = secret.split("|");
      if (!ref || !key) throw new Error('paste as "<project ref>|<service role key>"');
      const led = await fetchLedger(ref, key, `${monthStartIso()}T00:00:00Z`);

      const rows: Reading[] = led.costByOperation.map((c) => ({
        kind: "usage" as const,
        // The ledger names its vendors in its own terms; normalise so the board
        // can group a vendor's rows no matter which connector produced them.
        vendor: c.vendor === "fal_openrouter" ? "fal.ai" : c.vendor,
        name: `measured \u00b7 ${c.operation}`,
        unit: null, used: null, cap: null,
        reset_label: "this month \u00b7 from the app's own ledger",
        projection: null, projection_note: null,
        status: "ok" as const,
        mtd_usd: Number(c.usd.toFixed(6)),
        run_rate_usd: null,
        gross_usd: null, fees_usd: null,
        is_sample: false,
      }));

      if (led.youtube) {
        const { unitsToday, dailyCap } = led.youtube;
        const pct = unitsToday / dailyCap;
        rows.unshift({
          kind: "metered",
          vendor: "google",
          name: "YouTube Data API",
          unit: "units",
          used: unitsToday,
          cap: dailyCap,
          reset_label: "resets 00:00 Pacific",
          resets_at: nextPacificMidnight(),
          // No projection from one sample: a running total is a level, not a
          // rate. Two readings apart in time are what a projection needs, and
          // inventing one is the failure this console exists to avoid.
          projection: pct >= 1 ? "exhausted" : "no projection yet",
          projection_note: "counted by the app itself \u00b7 needs a second reading to project",
          status: pct >= 0.9 ? "crit" : pct >= 0.6 ? "warn" : "ok",
          mtd_usd: null,
          run_rate_usd: null,
          gross_usd: null, fees_usd: null,
          is_sample: false,
        });
      }

      // ── the named sub-ceilings ────────────────────────────────────────
      //
      // Google publishes a separate daily limit for each of these and will not
      // say how much of it is gone without a billing account on the project.
      // The app's own call log can, because it records which operation every
      // call was — so these stop being limits we merely know about.
      //
      // A zero here is a reading, not a blank: the log instruments every call
      // site, so an operation with no rows today is an operation that did not
      // happen. Uploads are the clear case — the app calls videos.list and
      // never videos.insert, so its upload ceiling is untouched by construction.
      if (led.youtube) {
        for (const [name, op] of Object.entries(SUB_CEILINGS)) {
          rows.push({
            kind: "metered",
            vendor: "google",
            name,
            unit: "calls",
            used: led.operationsToday[op] ?? 0,
            // Google owns the cap and reports it through its own connector.
            // Asserting it from here would be restating something we were told
            // elsewhere, and the two would drift.
            cap: null,
            reset_label: "resets 00:00 Pacific",
            resets_at: nextPacificMidnight(),
            projection: null,
            projection_note: "counted by the app's own call log",
            status: "ok",
            mtd_usd: null,
            run_rate_usd: null,
            gross_usd: null,
            fees_usd: null,
            is_sample: false,
          });
        }
      }

      if (!rows.length) throw new Error("no ai_usage_events or youtube_api_usage tables found");
      return rows;
    }
    case "google": {
      // The YouTube Data API is the only Google surface this portfolio uses, and
      // it is the one with a ceiling worth watching.
      const q = await fetchGoogleQuota(secret, "youtube.googleapis.com");
      return q.daily
        // The overall "Queries" budget is skipped on purpose: the app's own
        // ledger already gauges that one and knows how much of it is spent. A
        // ceiling with no usage beside it is strictly worse than a gauge with
        // both, and two cards for one quota would just disagree with each other.
        .filter((d) => d.name !== "Queries")
        .map((d) => ({
          kind: "metered" as const,
          vendor: "google",
          name: `YouTube \u00b7 ${d.name.toLowerCase()}`,
          unit: "calls",
          // Google will not report consumption without a billing account on the
          // project, so this ceiling is known but unmonitored — which is the
          // finding, not a gap to paper over with a plausible number.
          used: null,
          cap: d.limit,
          reset_label: "resets 00:00 Pacific",
          resets_at: nextPacificMidnight(),
          projection: "not counted",
          projection_note: d.isDefault
            ? "default ceiling \u00b7 the app does not record these calls separately"
            : "raised above default \u00b7 the app does not record these calls separately",
          status: "unknown" as const,
          mtd_usd: null,
          run_rate_usd: null,
          gross_usd: null,
          fees_usd: null,
          is_sample: false,
        }));
    }
    default:
      throw new Error(`no connector for "${vendor}" yet`);
  }
}

/**
 * Which recorded operation counts against which of Google's named ceilings.
 *
 * Keyed by the exact row name the Google connector writes, so the two halves —
 * its cap and this usage — land on the same ceiling when the board merges them.
 */
const SUB_CEILINGS: Record<string, string> = {
  "YouTube · search queries": "search",
  "YouTube · video batch get stats queries": "video_meta",
  "YouTube · video uploads": "video_upload",
};

/** Vendors this build can actually read, in the order they matter. */
export const SUPPORTED_VENDORS = [
  { id: "fal.ai", label: "fal.ai", hint: "ADMIN-scope key from fal.ai/dashboard/keys" },
  { id: "stripe", label: "Stripe", hint: "secret key (sk_live_… or sk_test_…)" },
  { id: "vercel", label: "Vercel", hint: "account token, pasted as <token>|<team id>" },
  { id: "ledger", label: "App own ledger", hint: "<supabase project ref>|<service role key>" },
  { id: "revenuecat", label: "RevenueCat", hint: "v2 secret key, pasted as <key>|<project id>" },
  { id: "google", label: "Google Cloud", hint: "the whole service-account JSON file" },
] as const;
